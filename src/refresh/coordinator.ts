import {AppError, toDisplaySafeError} from '../domain/errors.js';
import {
  normalizeDailyUsage,
  normalizeRateLimits,
  normalizeUsageSummary
} from '../domain/normalization.js';
import type {
  AccountStatus,
  AccountUsageDTO,
  AuthenticationState,
  CodexAccountClient,
  CodexExecutable,
  CodexRuntimeInfo,
  DailyUsageEntry,
  DashboardSnapshot,
  DisplaySafeError,
  HistoryStore,
  LiveUsageState,
  LocalUsageAggregate,
  LocalUsageSource,
  LoginPrompt,
  PersistedHistory,
  RateLimitsDTO,
  RefreshScope,
  RefreshTrigger,
  SourceFreshness,
  UsageRefreshCoordinator
} from '../domain/types.js';
import {
  appendDiagnostic,
  emptyHistory,
  latestLimitsFromHistory,
  mergeSuccessfulRefresh,
  recordLocalUsageSample,
  recordAttempt
} from '../persistence/history-store.js';

const STALE_AFTER_MS = 90 * 60 * 1_000;
const FULL_REFRESH_MS = 5 * 60 * 1_000;
const LIVE_REFRESH_MS = 60 * 1_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;

type RefreshCycle =
  | {
      kind: 'authenticated';
      account: Extract<AccountStatus, {kind: 'chatgpt'}>;
      executable: CodexExecutable;
      runtimeInfo: CodexRuntimeInfo;
      rateLimits: RateLimitsDTO;
      usage: AccountUsageDTO | undefined;
      localAggregate: LocalUsageAggregate | undefined;
    }
  | {
      kind: 'account';
      account: Exclude<AccountStatus, {kind: 'chatgpt'}>;
      executable: CodexExecutable;
    };

type LiveRefreshCycle = {
  executable: CodexExecutable;
  runtimeInfo: CodexRuntimeInfo;
  rateLimits: RateLimitsDTO;
  localAggregate: LocalUsageAggregate | undefined;
};

type QueuedFullRefresh = {
  promise: Promise<DashboardSnapshot>;
  resolve: (state: DashboardSnapshot) => void;
  reject: (error: unknown) => void;
};

export type CoordinatorOptions = {
  store: HistoryStore;
  discover: () => Promise<CodexExecutable>;
  createClient: (executable: CodexExecutable) => CodexAccountClient;
  localUsageSource?: LocalUsageSource;
  localEnabled?: boolean;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  setInterval?: (callback: () => void, milliseconds: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
  loginTimeoutMs?: number;
};

export class RefreshCoordinator implements UsageRefreshCoordinator {
  private readonly store: HistoryStore;
  private readonly discover: () => Promise<CodexExecutable>;
  private readonly createClient: (executable: CodexExecutable) => CodexAccountClient;
  private readonly localUsageSource: LocalUsageSource | undefined;
  private readonly localEnabled: boolean;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly makeInterval: (
    callback: () => void,
    milliseconds: number
  ) => NodeJS.Timeout;
  private readonly clearScheduledInterval: (timer: NodeJS.Timeout) => void;
  private readonly loginTimeoutMs: number;

  private history: PersistedHistory = emptyHistory();
  private state: DashboardSnapshot = loadingSnapshot();
  private executable: CodexExecutable | undefined;
  private client: CodexAccountClient | undefined;
  private inFlight: Promise<DashboardSnapshot> | undefined;
  private inFlightScope: RefreshScope | undefined;
  private queuedFull: QueuedFullRefresh | undefined;
  private fullInterval: NodeJS.Timeout | undefined;
  private liveInterval: NodeJS.Timeout | undefined;
  private readonly lifetime = new AbortController();
  private closed = false;

  constructor(options: CoordinatorOptions) {
    this.store = options.store;
    this.discover = options.discover;
    this.createClient = options.createClient;
    this.localUsageSource = options.localUsageSource;
    this.localEnabled = options.localEnabled ?? true;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? abortableSleep;
    this.makeInterval = options.setInterval ?? setInterval;
    this.clearScheduledInterval = options.clearInterval ?? clearInterval;
    this.loginTimeoutMs = options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
  }

  async loadCached(): Promise<DashboardSnapshot> {
    let warning: DisplaySafeError | undefined;
    try {
      this.history = await this.store.load();
    } catch (error) {
      this.history = emptyHistory();
      warning = toDisplaySafeError(error);
    }
    const limits = latestLimitsFromHistory(this.history.limitHistory);
    const hasCache = this.history.lastSuccessfulAt !== undefined && limits.length > 0;
    this.state = {
      status: hasCache
        ? this.isStale(this.history.lastSuccessfulAt)
          ? 'stale'
          : 'fresh'
        : 'loading',
      limits,
      usageSummary: this.history.usageSummary,
      dailyUsage: this.history.dailyUsage,
      localUsageDays: this.history.localUsageDays,
      limitHistory: this.history.limitHistory,
      lastAttemptAt: this.history.lastAttemptAt,
      lastSuccessfulAt: this.history.lastSuccessfulAt,
      codexVersion: this.history.detectedCodexVersion,
      planType: undefined,
      authenticationState: this.history.authenticationState,
      sourceFreshness: this.history.sourceFreshness,
      liveUsage: this.cachedLiveUsage(),
      warning,
      isRefreshing: false
    };
    return this.state;
  }

  refresh(
    _trigger: RefreshTrigger,
    scope: RefreshScope = 'full'
  ): Promise<DashboardSnapshot> {
    if (this.closed) {
      return Promise.resolve(this.state);
    }
    if (this.inFlight !== undefined) {
      if (this.inFlightScope === 'live' && scope === 'full') {
        return this.queueFullRefresh();
      }
      return this.inFlight;
    }
    return this.startRefresh(scope);
  }

  private startRefresh(scope: RefreshScope): Promise<DashboardSnapshot> {
    this.state = {...this.state, isRefreshing: true};
    this.inFlightScope = scope;
    const refresh = this.performRefresh(scope)
      .finally(() => {
        this.inFlight = undefined;
        this.inFlightScope = undefined;
        const queued = this.queuedFull;
        this.queuedFull = undefined;
        if (queued !== undefined) {
          if (this.closed) {
            queued.resolve(this.state);
          } else {
            void this.startRefresh('full').then(queued.resolve, queued.reject);
          }
        }
      });
    this.inFlight = refresh;
    return refresh;
  }

  private queueFullRefresh(): Promise<DashboardSnapshot> {
    if (this.queuedFull !== undefined) {
      return this.queuedFull.promise;
    }
    let resolveQueued: ((state: DashboardSnapshot) => void) | undefined;
    let rejectQueued: ((error: unknown) => void) | undefined;
    const promise = new Promise<DashboardSnapshot>((resolve, reject) => {
      resolveQueued = resolve;
      rejectQueued = reject;
    });
    if (resolveQueued === undefined || rejectQueued === undefined) {
      throw new Error('Unable to queue refresh.');
    }
    this.queuedFull = {
      promise,
      resolve: resolveQueued,
      reject: rejectQueued
    };
    return promise;
  }

  async startChatGPTLogin(): Promise<LoginPrompt> {
    if (this.closed) {
      throw new AppError(
        'processFailed',
        'The Codex connection is closed.',
        'Restart my-codex-usage.'
      );
    }
    const executable = this.executable ?? (await this.discover());
    this.executable = executable;
    const client = this.client ?? this.createClient(executable);
    this.client = client;
    await client.initialize(this.lifetime.signal);
    this.state = {
      ...this.state,
      status: 'authenticating',
      warning: undefined,
      isRefreshing: false
    };
    return client.startChatGPTLogin(this.lifetime.signal);
  }

  async waitForLoginCompletion(loginId: string): Promise<DashboardSnapshot> {
    const client = this.client;
    if (client === undefined) {
      const warning: DisplaySafeError = {
        category: 'processFailed',
        message: 'The Codex connection closed before authorization completed.',
        recovery: 'Press l to try again.'
      };
      this.state = {
        ...this.state,
        status: 'unauthenticated',
        warning,
        isRefreshing: false
      };
      return this.state;
    }

    const timeoutSignal = AbortSignal.timeout(this.loginTimeoutMs);
    const signal = AbortSignal.any([this.lifetime.signal, timeoutSignal]);
    try {
      await client.waitForLoginCompletion(loginId, signal);
      this.state = {
        ...this.state,
        status: 'loading',
        warning: undefined,
        isRefreshing: true
      };
      return await this.refresh('manual');
    } catch (error) {
      if (this.closed && isAbort(error)) {
        this.state = {...this.state, isRefreshing: false};
        return this.state;
      }
      const warning: DisplaySafeError =
        error instanceof DOMException && error.name === 'TimeoutError'
          ? {
              category: 'unauthenticated',
              message: 'ChatGPT authorization timed out.',
              recovery: 'Press l to start a new login.'
            }
          : toDisplaySafeError(error);
      this.state = {
        ...this.state,
        status: 'unauthenticated',
        warning,
        isRefreshing: false
      };
      return this.state;
    }
  }

  startAutomaticRefresh(callback: (state: DashboardSnapshot) => void): void {
    if (
      this.fullInterval !== undefined ||
      this.liveInterval !== undefined ||
      this.closed
    ) {
      return;
    }
    this.liveInterval = this.makeInterval(() => {
      callback({...this.state, isRefreshing: true});
      void this.refresh('automatic', 'live').then(callback);
    }, LIVE_REFRESH_MS);
    this.fullInterval = this.makeInterval(() => {
      callback({...this.state, isRefreshing: true});
      void this.refresh('automatic', 'full').then(callback);
    }, FULL_REFRESH_MS);
    this.liveInterval.unref?.();
    this.fullInterval.unref?.();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.lifetime.abort();
    if (this.liveInterval !== undefined) {
      this.clearScheduledInterval(this.liveInterval);
      this.liveInterval = undefined;
    }
    if (this.fullInterval !== undefined) {
      this.clearScheduledInterval(this.fullInterval);
      this.fullInterval = undefined;
    }
    const activeRefresh = this.inFlight;
    const queuedRefresh = this.queuedFull?.promise;
    await this.client?.close().catch(() => undefined);
    this.client = undefined;
    await activeRefresh?.catch(() => undefined);
    await queuedRefresh?.catch(() => undefined);
  }

  private async performRefresh(scope: RefreshScope): Promise<DashboardSnapshot> {
    const attemptedAt = this.now();
    this.history = recordAttempt(this.history, attemptedAt);

    try {
      if (scope === 'live') {
        return await this.performLiveRefresh(attemptedAt);
      }
      const cycle = await this.readFullRefreshCycle();
      const {account, executable} = cycle;
      const authenticationState = accountToAuthenticationState(account);
      this.history = {
        ...recordAttempt(this.history, attemptedAt, authenticationState),
        detectedCodexVersion: executable.version
      };

      if (account.kind === 'signedOut') {
        return await this.finishAuthenticationState(
          'unauthenticated',
          authenticationState,
          {
            category: 'unauthenticated',
            message: 'Codex is not signed in with ChatGPT.',
            recovery: 'Press l to sign in through this Codex connection.'
          }
        );
      }
      if (account.kind === 'apiKeyUnsupported') {
        return await this.finishAuthenticationState(
          'unauthenticated',
          authenticationState,
          {
            category: 'authenticationUnsupported',
            message: 'API-key-only accounts do not expose ChatGPT usage limits.',
            recovery: 'Press l to sign in with a ChatGPT account.'
          }
        );
      }
      if (account.kind === 'unsupported') {
        return await this.finishAuthenticationState(
          'incompatible',
          authenticationState,
          {
            category: 'authenticationUnsupported',
            message: 'This Codex account type is not supported.',
            recovery: 'Use a ChatGPT-backed Codex login.'
          }
        );
      }

      if (cycle.kind !== 'authenticated') {
        throw new AppError(
          'protocolIncompatible',
          'Authenticated refresh data was not available.',
          'Press r to retry.'
        );
      }

      const limits = normalizeRateLimits(cycle.rateLimits, attemptedAt);
      const dailyUsage =
        cycle.usage !== undefined
          ? normalizeDailyUsage(cycle.usage, attemptedAt)
          : undefined;
      const usageSummary =
        cycle.usage !== undefined
          ? normalizeUsageSummary(cycle.usage)
          : undefined;
      const sourceFreshness = updatedSourceFreshness(
        this.history.sourceFreshness,
        attemptedAt,
        dailyUsage
      );
      const liveUsage = this.applyLocalSample(cycle.localAggregate);
      const partialWarning: DisplaySafeError | undefined =
        cycle.usage === undefined
          ? {
              category: 'usageUnavailable',
              message: 'Current limits are fresh, but daily usage is unavailable.',
              recovery: 'Press r to retry daily usage.'
            }
          : undefined;

      this.history = mergeSuccessfulRefresh(this.history, {
        observedAt: attemptedAt,
        codexVersion: executable.version,
        authenticationState,
        limits,
        usageSummary,
        dailyUsage,
        sourceFreshness
      });
      if (partialWarning !== undefined) {
        this.history = appendDiagnostic(this.history, partialWarning, attemptedAt);
      }
      const persistenceWarning = await this.trySave();
      this.state = {
        status:
          partialWarning !== undefined || persistenceWarning !== undefined
            ? 'partial'
            : 'fresh',
        limits,
        usageSummary: this.history.usageSummary,
        dailyUsage: this.history.dailyUsage,
        localUsageDays: this.history.localUsageDays,
        limitHistory: this.history.limitHistory,
        lastAttemptAt: attemptedAt.toISOString(),
        lastSuccessfulAt: attemptedAt.toISOString(),
        codexVersion: executable.version,
        planType: account.planType,
        authenticationState,
        sourceFreshness: this.history.sourceFreshness,
        liveUsage,
        warning: persistenceWarning ?? partialWarning,
        isRefreshing: false
      };
      return this.state;
    } catch (error) {
      if (this.closed && isAbort(error)) {
        this.state = {...this.state, isRefreshing: false};
        return this.state;
      }
      const warning = toDisplaySafeError(error);
      this.history = appendDiagnostic(this.history, warning, attemptedAt);
      const persistenceWarning = await this.trySave();
      const limits = this.state.limits.length > 0
        ? this.state.limits
        : latestLimitsFromHistory(this.history.limitHistory);
      const hasCache =
        limits.length > 0 && this.history.lastSuccessfulAt !== undefined;
      this.state = {
        ...this.state,
        status: hasCache
          ? this.isStale(this.history.lastSuccessfulAt)
            ? 'stale'
            : 'partial'
          : isIncompatibility(warning)
            ? 'incompatible'
            : 'unavailable',
        limits,
        usageSummary: this.history.usageSummary,
        dailyUsage: this.history.dailyUsage,
        localUsageDays: this.history.localUsageDays,
        limitHistory: this.history.limitHistory,
        lastAttemptAt: attemptedAt.toISOString(),
        lastSuccessfulAt: this.history.lastSuccessfulAt,
        codexVersion:
          this.executable?.version ?? this.history.detectedCodexVersion,
        sourceFreshness: this.history.sourceFreshness,
        warning: persistenceWarning ?? warning,
        isRefreshing: false
      };
      return this.state;
    }
  }

  private async performLiveRefresh(
    attemptedAt: Date
  ): Promise<DashboardSnapshot> {
    const cycle = await this.readLiveRefreshCycle();
    const limits = normalizeRateLimits(cycle.rateLimits, attemptedAt);
    const sourceFreshness = updatedSourceFreshness(
      this.history.sourceFreshness,
      attemptedAt
    );
    const liveUsage = this.applyLocalSample(cycle.localAggregate);
    this.history = mergeSuccessfulRefresh(this.history, {
      observedAt: attemptedAt,
      codexVersion: cycle.executable.version,
      authenticationState: this.history.authenticationState,
      limits,
      dailyUsage: undefined,
      sourceFreshness
    });
    const persistenceWarning = await this.trySave();
    const usageWarning =
      this.state.warning?.category === 'usageUnavailable'
        ? this.state.warning
        : undefined;
    this.state = {
      ...this.state,
      status:
        persistenceWarning !== undefined || usageWarning !== undefined
          ? 'partial'
          : 'fresh',
      limits,
      usageSummary: this.history.usageSummary,
      dailyUsage: this.history.dailyUsage,
      localUsageDays: this.history.localUsageDays,
      limitHistory: this.history.limitHistory,
      lastAttemptAt: attemptedAt.toISOString(),
      lastSuccessfulAt: attemptedAt.toISOString(),
      codexVersion: cycle.executable.version,
      sourceFreshness: this.history.sourceFreshness,
      liveUsage,
      warning: persistenceWarning ?? usageWarning,
      isRefreshing: false
    };
    return this.state;
  }

  private async readFullRefreshCycle(): Promise<RefreshCycle> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const executable = this.executable ?? (await this.discover());
        this.executable = executable;
        const client = this.client ?? this.createClient(executable);
        this.client = client;
        const runtimeInfo = await client.initialize(this.lifetime.signal);
        const account = await client.readAccount(this.lifetime.signal);
        if (account.kind !== 'chatgpt') {
          return {kind: 'account', account, executable};
        }
        const [limitsResult, usageResult, localResult] = await Promise.allSettled([
          client.readRateLimits(this.lifetime.signal),
          client.readUsage(this.lifetime.signal),
          this.readLocalAggregate(runtimeInfo)
        ]);
        if (limitsResult.status === 'rejected') {
          throw limitsResult.reason;
        }
        return {
          kind: 'authenticated',
          account,
          executable,
          runtimeInfo,
          rateLimits: limitsResult.value,
          usage:
            usageResult.status === 'fulfilled'
              ? usageResult.value
              : undefined,
          localAggregate:
            localResult.status === 'fulfilled'
              ? localResult.value
              : undefined
        };
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === RETRY_DELAYS_MS.length) {
          throw error;
        }
        await this.client?.close().catch(() => undefined);
        this.client = undefined;
        await this.sleep(RETRY_DELAYS_MS[attempt]!, this.lifetime.signal);
      }
    }
    throw lastError;
  }

  private async readLiveRefreshCycle(): Promise<LiveRefreshCycle> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const executable = this.executable ?? (await this.discover());
        this.executable = executable;
        const client = this.client ?? this.createClient(executable);
        this.client = client;
        const runtimeInfo = await client.initialize(this.lifetime.signal);
        const [limitsResult, localResult] = await Promise.allSettled([
          client.readRateLimits(this.lifetime.signal),
          this.readLocalAggregate(runtimeInfo)
        ]);
        if (limitsResult.status === 'rejected') {
          throw limitsResult.reason;
        }
        return {
          executable,
          runtimeInfo,
          rateLimits: limitsResult.value,
          localAggregate:
            localResult.status === 'fulfilled'
              ? localResult.value
              : undefined
        };
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === RETRY_DELAYS_MS.length) {
          throw error;
        }
        await this.client?.close().catch(() => undefined);
        this.client = undefined;
        await this.sleep(RETRY_DELAYS_MS[attempt]!, this.lifetime.signal);
      }
    }
    throw lastError;
  }

  private readLocalAggregate(
    runtimeInfo: CodexRuntimeInfo
  ): Promise<LocalUsageAggregate | undefined> {
    if (!this.localEnabled || this.localUsageSource === undefined) {
      return Promise.resolve(undefined);
    }
    return this.localUsageSource.readAggregate(
      runtimeInfo.codexHome,
      this.lifetime.signal
    );
  }

  private applyLocalSample(
    sample: LocalUsageAggregate | undefined
  ): LiveUsageState {
    if (!this.localEnabled) {
      return {status: 'disabled'};
    }
    if (sample === undefined) {
      return unavailableLiveUsage(this.state.liveUsage);
    }
    const result = recordLocalUsageSample(this.history, sample);
    this.history = result.history;
    return localStateFromObservation(result.sampleStatus, result.observation);
  }

  private cachedLiveUsage(): LiveUsageState {
    if (!this.localEnabled) {
      return {status: 'disabled'};
    }
    const dayKey = this.now().toISOString().slice(0, 10);
    const observation = this.history.localUsageDays.find(
      entry => entry.dayKey === dayKey
    );
    return observation === undefined
      ? {status: 'unavailable'}
      : localStateFromObservation(
          observation.observedIncreaseTokens > 0 ? 'observed' : 'baseline',
          observation
        );
  }

  private async finishAuthenticationState(
    status: 'unauthenticated' | 'incompatible',
    authenticationState: AuthenticationState,
    warning: DisplaySafeError
  ): Promise<DashboardSnapshot> {
    this.history = appendDiagnostic(this.history, warning, this.now());
    const persistenceWarning = await this.trySave();
    this.state = {
      ...this.state,
      status,
      usageSummary: this.history.usageSummary,
      dailyUsage: this.history.dailyUsage,
      localUsageDays: this.history.localUsageDays,
      limitHistory: this.history.limitHistory,
      lastAttemptAt: this.history.lastAttemptAt,
      lastSuccessfulAt: this.history.lastSuccessfulAt,
      codexVersion:
        this.executable?.version ?? this.history.detectedCodexVersion,
      planType: undefined,
      authenticationState,
      warning: persistenceWarning ?? warning,
      isRefreshing: false
    };
    return this.state;
  }

  private async trySave(): Promise<DisplaySafeError | undefined> {
    try {
      await this.store.save(this.history);
      return undefined;
    } catch (error) {
      return toDisplaySafeError(error);
    }
  }

  private isStale(lastSuccessfulAt: string | undefined): boolean {
    if (lastSuccessfulAt === undefined) {
      return true;
    }
    return this.now().getTime() - Date.parse(lastSuccessfulAt) > STALE_AFTER_MS;
  }
}

function loadingSnapshot(): DashboardSnapshot {
  return {
    status: 'loading',
    limits: [],
    usageSummary: {},
    dailyUsage: [],
    localUsageDays: [],
    limitHistory: [],
    lastAttemptAt: undefined,
    lastSuccessfulAt: undefined,
    codexVersion: undefined,
    planType: undefined,
    authenticationState: 'unknown',
    sourceFreshness: {},
    liveUsage: {status: 'unavailable'},
    warning: undefined,
    isRefreshing: false
  };
}

function updatedSourceFreshness(
  previous: SourceFreshness,
  limitsFetchedAt: Date,
  dailyUsage?: DailyUsageEntry[]
): SourceFreshness {
  const next: SourceFreshness = {
    ...previous,
    limitsFetchedAt: limitsFetchedAt.toISOString()
  };
  if (dailyUsage !== undefined) {
    next.usageFetchedAt = limitsFetchedAt.toISOString();
    delete next.usageDataThroughDay;
    const latestDay = dailyUsage.map(entry => entry.dayKey).sort().at(-1);
    if (latestDay !== undefined) {
      next.usageDataThroughDay = latestDay;
    }
  }
  return next;
}

function localStateFromObservation(
  status: 'observed' | 'baseline' | 'reset',
  observation: PersistedHistory['localUsageDays'][number]
): LiveUsageState {
  return {
    status,
    aggregateTokens: observation.latestAggregateTokens,
    deltaTokens: observation.observedIncreaseTokens,
    intervalStartedAt: observation.baselineSampledAt,
    sampledAt: observation.latestSampledAt,
    todayDayKey: observation.dayKey,
    todayObservedTokens: observation.observedIncreaseTokens,
    todayBaselineAt: observation.baselineSampledAt,
    todayLatestSampleAt: observation.latestSampledAt,
    todayCoverageStartedAt: observation.baselineSampledAt,
    todaySampleCount: observation.sampleCount,
    todayResetCount: observation.resetCount,
    ...(observation.latestActivityAt === undefined
      ? {}
      : {latestActivityAt: observation.latestActivityAt})
  };
}

function unavailableLiveUsage(previous: LiveUsageState): LiveUsageState {
  const next: LiveUsageState = {status: 'unavailable'};
  if (previous.aggregateTokens !== undefined) {
    next.aggregateTokens = previous.aggregateTokens;
  }
  if (previous.sampledAt !== undefined) {
    next.sampledAt = previous.sampledAt;
  }
  if (previous.latestActivityAt !== undefined) {
    next.latestActivityAt = previous.latestActivityAt;
  }
  if (previous.deltaTokens !== undefined) {
    next.deltaTokens = previous.deltaTokens;
  }
  if (previous.intervalStartedAt !== undefined) {
    next.intervalStartedAt = previous.intervalStartedAt;
  }
  if (previous.todayDayKey !== undefined) {
    next.todayDayKey = previous.todayDayKey;
  }
  if (previous.todayObservedTokens !== undefined) {
    next.todayObservedTokens = previous.todayObservedTokens;
  }
  if (previous.todayBaselineAt !== undefined) {
    next.todayBaselineAt = previous.todayBaselineAt;
  }
  if (previous.todayLatestSampleAt !== undefined) {
    next.todayLatestSampleAt = previous.todayLatestSampleAt;
  }
  if (previous.todayCoverageStartedAt !== undefined) {
    next.todayCoverageStartedAt = previous.todayCoverageStartedAt;
  }
  if (previous.todaySampleCount !== undefined) {
    next.todaySampleCount = previous.todaySampleCount;
  }
  if (previous.todayResetCount !== undefined) {
    next.todayResetCount = previous.todayResetCount;
  }
  return next;
}

function accountToAuthenticationState(
  account: AccountStatus
): AuthenticationState {
  switch (account.kind) {
    case 'chatgpt':
      return 'chatgpt';
    case 'signedOut':
      return 'signedOut';
    case 'apiKeyUnsupported':
      return 'apiKeyUnsupported';
    case 'unsupported':
      return 'unsupported';
  }
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.category === 'processFailed' ||
      error.category === 'requestTimeout' ||
      error.category === 'serviceUnavailable' ||
      error.category === 'protocolMalformed')
  );
}

function isIncompatibility(error: DisplaySafeError): boolean {
  return (
    error.category === 'cliIncompatible' ||
    error.category === 'protocolIncompatible' ||
    error.category === 'authenticationUnsupported'
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function abortableSleep(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) {
    throw signal.reason;
  }
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, {once: true});
  });
}
