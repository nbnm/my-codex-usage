import {describe, expect, it} from 'vitest';
import {AppError} from '../../src/domain/errors.js';
import type {
  AccountStatus,
  AccountUsageDTO,
  CodexAccountClient,
  CodexExecutable,
  HistoryStore,
  LocalUsageAggregate,
  LocalUsageSource,
  PersistedHistory,
  RateLimitsDTO
} from '../../src/domain/types.js';
import {
  emptyHistory,
  mergeSuccessfulRefresh
} from '../../src/persistence/history-store.js';
import {RefreshCoordinator} from '../../src/refresh/coordinator.js';

const executable: CodexExecutable = {
  path: '/sanitized/codex',
  version: '0.144.3'
};

const rateLimits: RateLimitsDTO = {
  rateLimits: {
    limitId: 'codex',
    limitName: 'Codex',
    planType: 'plus',
    primary: {
      usedPercent: 25,
      windowDurationMins: 300,
      resetsAt: 1_900_000_000
    },
    secondary: null,
    rateLimitReachedType: null
  },
  rateLimitsByLimitId: null
};

class MemoryStore implements HistoryStore {
  history: PersistedHistory;
  saveCount = 0;

  constructor(history: PersistedHistory = emptyHistory()) {
    this.history = history;
  }

  load(): Promise<PersistedHistory> {
    return Promise.resolve(this.history);
  }

  save(history: PersistedHistory): Promise<void> {
    this.history = history;
    this.saveCount++;
    return Promise.resolve();
  }

  quarantineCorruptFile(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeClient implements CodexAccountClient {
  account: AccountStatus;
  limits: RateLimitsDTO;
  readonly usage: AccountUsageDTO | Error;
  readonly initializeHook: (() => Promise<void>) | undefined;
  readonly rateLimitsHook: (() => Promise<void>) | undefined;
  loginCompletionHook:
    | ((signal?: AbortSignal) => Promise<void>)
    | undefined;
  closed = false;
  accountReads = 0;
  rateLimitReads = 0;
  usageReads = 0;

  constructor(options?: {
    account?: AccountStatus;
    limits?: RateLimitsDTO;
    usage?: AccountUsageDTO | Error;
    initializeHook?: () => Promise<void>;
    rateLimitsHook?: () => Promise<void>;
    loginCompletionHook?: (signal?: AbortSignal) => Promise<void>;
  }) {
    this.account = options?.account ?? {kind: 'chatgpt', planType: 'plus'};
    this.limits = options?.limits ?? rateLimits;
    this.usage = options?.usage ?? {
      summary: {
        lifetimeTokens: 1_234,
        currentStreakDays: 4,
        longestStreakDays: 13,
        peakDailyTokens: 456,
        longestRunningTurnSec: 5_375
      },
      dailyUsageBuckets: [{startDate: '2026-07-24', tokens: 100}]
    };
    this.initializeHook = options?.initializeHook;
    this.rateLimitsHook = options?.rateLimitsHook;
    this.loginCompletionHook = options?.loginCompletionHook;
  }

  async initialize(): Promise<{codexHome: string}> {
    await this.initializeHook?.();
    return {codexHome: '/sanitized/codex-home'};
  }

  readAccount(): Promise<AccountStatus> {
    this.accountReads++;
    return Promise.resolve(this.account);
  }

  async readRateLimits(): Promise<RateLimitsDTO> {
    this.rateLimitReads++;
    await this.rateLimitsHook?.();
    return this.limits;
  }

  readUsage(): Promise<AccountUsageDTO> {
    this.usageReads++;
    return this.usage instanceof Error
      ? Promise.reject(this.usage)
      : Promise.resolve(this.usage);
  }

  startChatGPTLogin(): Promise<{authUrl: string; loginId: string}> {
    return Promise.resolve({
      authUrl: 'https://example.invalid/authorize',
      loginId: 'fixture-login'
    });
  }

  waitForLoginCompletion(
    _loginId: string,
    signal?: AbortSignal
  ): Promise<void> {
    return this.loginCompletionHook?.(signal) ?? Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeLocalUsageSource implements LocalUsageSource {
  readonly codexHomes: string[] = [];
  private readonly samples: Array<LocalUsageAggregate | undefined>;

  constructor(samples: Array<LocalUsageAggregate | undefined>) {
    this.samples = [...samples];
  }

  readAggregate(codexHome: string): Promise<LocalUsageAggregate | undefined> {
    this.codexHomes.push(codexHome);
    return Promise.resolve(this.samples.shift());
  }
}

describe('RefreshCoordinator', () => {
  it('coalesces concurrent refresh requests', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const client = new FakeClient({initializeHook: () => gate});
    const coordinator = new RefreshCoordinator({
      store: new MemoryStore(),
      discover: () => Promise.resolve(executable),
      createClient: () => client,
      now: () => new Date('2026-07-24T12:00:00Z')
    });
    await coordinator.loadCached();
    const first = coordinator.refresh('launch');
    const second = coordinator.refresh('manual', 'live');
    expect(second).toBe(first);
    release?.();
    await expect(first).resolves.toMatchObject({status: 'fresh'});
    await coordinator.close();
  });

  it('queues exactly one full refresh behind active live work', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const client = new FakeClient({rateLimitsHook: () => gate});
    const coordinator = new RefreshCoordinator({
      store: new MemoryStore(),
      discover: () => Promise.resolve(executable),
      createClient: () => client,
      now: () => new Date('2026-07-27T12:00:00Z')
    });
    await coordinator.loadCached();
    const live = coordinator.refresh('automatic', 'live');
    const firstFull = coordinator.refresh('manual', 'full');
    const secondFull = coordinator.refresh('automatic', 'full');
    expect(firstFull).toBe(secondFull);
    expect(firstFull).not.toBe(live);
    release?.();
    await expect(live).resolves.toMatchObject({status: 'fresh'});
    await expect(firstFull).resolves.toMatchObject({status: 'fresh'});
    expect(client.accountReads).toBe(1);
    expect(client.rateLimitReads).toBe(2);
    expect(client.usageReads).toBe(1);
    await coordinator.close();
  });

  it('keeps fresh limits when daily usage is unavailable', async () => {
    const store = new MemoryStore();
    const client = new FakeClient({
      usage: new AppError('serviceUnavailable', 'raw fixture error')
    });
    const coordinator = new RefreshCoordinator({
      store,
      discover: () => Promise.resolve(executable),
      createClient: () => client,
      now: () => new Date('2026-07-24T12:00:00Z')
    });
    await coordinator.loadCached();
    const state = await coordinator.refresh('launch');
    expect(state.status).toBe('partial');
    expect(state.limits).toHaveLength(1);
    expect(state.warning?.category).toBe('usageUnavailable');
    expect(store.history.dailyUsage).toEqual([]);
    await coordinator.close();
  });

  it('preserves the cached usage summary when the usage call fails', async () => {
    const now = new Date('2026-07-24T12:00:00Z');
    const cached = mergeSuccessfulRefresh(emptyHistory(), {
      observedAt: new Date('2026-07-24T11:00:00Z'),
      codexVersion: '0.144.3',
      authenticationState: 'chatgpt',
      limits: [],
      usageSummary: {
        lifetimeTokens: 1_234,
        currentStreakDays: 4
      },
      dailyUsage: undefined
    });
    const coordinator = new RefreshCoordinator({
      store: new MemoryStore(cached),
      discover: () => Promise.resolve(executable),
      createClient: () =>
        new FakeClient({
          usage: new AppError('serviceUnavailable', 'fixture usage failure')
        }),
      now: () => now
    });
    await coordinator.loadCached();
    const result = await coordinator.refresh('launch');
    expect(result.status).toBe('partial');
    expect(result.usageSummary).toEqual({
      lifetimeTokens: 1_234,
      currentStreakDays: 4
    });
    await coordinator.close();
  });

  it('derives authentication states without erasing cached history', async () => {
    const now = new Date('2026-07-24T12:00:00Z');
    const cached = mergeSuccessfulRefresh(emptyHistory(), {
      observedAt: new Date('2026-07-24T11:00:00Z'),
      codexVersion: '0.144.3',
      authenticationState: 'chatgpt',
      limits: [
        {
          key: 'codex|primary|300',
          limitId: 'codex',
          limitName: 'Codex',
          windowKind: 'primary',
          durationMinutes: 300,
          usedPercent: 25,
          remainingPercent: 75,
          resetsAt: undefined,
          planType: 'plus',
          reachedLimitType: undefined,
          displayName: 'Codex'
        }
      ],
      dailyUsage: undefined
    });
    const coordinator = new RefreshCoordinator({
      store: new MemoryStore(cached),
      discover: () => Promise.resolve(executable),
      createClient: () =>
        new FakeClient({account: {kind: 'apiKeyUnsupported'}}),
      now: () => now
    });
    expect((await coordinator.loadCached()).limits).toHaveLength(1);
    const state = await coordinator.refresh('launch');
    expect(state.status).toBe('unauthenticated');
    expect(state.limits).toHaveLength(1);
    expect(state.warning?.category).toBe('authenticationUnsupported');
    await coordinator.close();
  });

  it('uses bounded process retry delays', async () => {
    const delays: number[] = [];
    let created = 0;
    const coordinator = new RefreshCoordinator({
      store: new MemoryStore(),
      discover: () => Promise.resolve(executable),
      createClient: () => {
        created++;
        return created < 4
          ? new FakeClient({
              initializeHook: () =>
                Promise.reject(
                  new AppError('processFailed', 'fixture process failure')
                )
            })
          : new FakeClient();
      },
      sleep: milliseconds => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
      now: () => new Date('2026-07-24T12:00:00Z')
    });
    await coordinator.loadCached();
    expect((await coordinator.refresh('launch')).status).toBe('fresh');
    expect(delays).toEqual([1_000, 2_000, 4_000]);
    await coordinator.close();
  });

  it('registers one-minute live and five-minute full intervals', async () => {
    const intervals: number[] = [];
    const coordinator = new RefreshCoordinator({
      store: new MemoryStore(),
      discover: () => Promise.resolve(executable),
      createClient: () => new FakeClient(),
      setInterval: (_callback, milliseconds) => {
        intervals.push(milliseconds);
        return {unref: () => undefined} as unknown as NodeJS.Timeout;
      },
      clearInterval: () => undefined
    });
    coordinator.startAutomaticRefresh(() => undefined);
    expect(intervals.sort((left, right) => left - right)).toEqual([
      60 * 1_000,
      5 * 60 * 1_000
    ]);
    await coordinator.close();
  });

  it('tracks local baseline, monotonic increase, no change, and reset', async () => {
    const samples: LocalUsageAggregate[] = [
      {
        aggregateTokens: 1_000,
        sampledAt: '2026-07-27T12:00:00.000Z',
        latestActivityAt: '2026-07-27T11:59:00.000Z'
      },
      {
        aggregateTokens: 1_250,
        sampledAt: '2026-07-27T12:01:00.000Z',
        latestActivityAt: '2026-07-27T12:00:30.000Z'
      },
      {
        aggregateTokens: 1_250,
        sampledAt: '2026-07-27T12:02:00.000Z',
        latestActivityAt: '2026-07-27T12:00:30.000Z'
      },
      {
        aggregateTokens: 100,
        sampledAt: '2026-07-27T12:03:00.000Z'
      },
      {
        aggregateTokens: 150,
        sampledAt: '2026-07-27T12:04:00.000Z'
      }
    ];
    const local = new FakeLocalUsageSource(samples);
    const store = new MemoryStore();
    const coordinator = new RefreshCoordinator({
      store,
      discover: () => Promise.resolve(executable),
      createClient: () => new FakeClient(),
      localUsageSource: local,
      now: () => new Date('2026-07-27T12:00:00Z')
    });
    await coordinator.loadCached();
    expect((await coordinator.refresh('launch')).liveUsage).toMatchObject({
      status: 'baseline',
      aggregateTokens: 1_000
    });
    expect(
      (await coordinator.refresh('automatic', 'live')).liveUsage
    ).toMatchObject({
      status: 'observed',
      deltaTokens: 250,
      intervalStartedAt: '2026-07-27T12:00:00.000Z'
    });
    expect(
      (await coordinator.refresh('automatic', 'live')).liveUsage
    ).toMatchObject({
      status: 'observed',
      deltaTokens: 250,
      intervalStartedAt: '2026-07-27T12:00:00.000Z'
    });
    expect(
      (await coordinator.refresh('automatic', 'live')).liveUsage
    ).toMatchObject({
      status: 'reset',
      aggregateTokens: 100,
      todayObservedTokens: 250,
      todaySampleCount: 4,
      todayResetCount: 1
    });
    expect(
      (await coordinator.refresh('automatic', 'live')).liveUsage
    ).toMatchObject({
      status: 'observed',
      aggregateTokens: 150,
      todayObservedTokens: 300,
      todaySampleCount: 5,
      todayResetCount: 1
    });
    expect(store.history.localUsageDays).toContainEqual(
      expect.objectContaining({
        dayKey: '2026-07-27',
        latestAggregateTokens: 150,
        observedIncreaseTokens: 300
      })
    );
    expect(store.history.localUsageDays).not.toContainEqual({
      dayKey: '2026-07-24'
    });
    expect(local.codexHomes).toEqual(
      Array.from({length: 5}, () => '/sanitized/codex-home')
    );
    await coordinator.close();
  });

  it('keeps service data usable when local sampling is unavailable or disabled', async () => {
    const unavailable = new RefreshCoordinator({
      store: new MemoryStore(),
      discover: () => Promise.resolve(executable),
      createClient: () => new FakeClient(),
      localUsageSource: new FakeLocalUsageSource([undefined]),
      now: () => new Date('2026-07-27T12:00:00Z')
    });
    await unavailable.loadCached();
    const unavailableState = await unavailable.refresh('launch');
    expect(unavailableState.status).toBe('fresh');
    expect(unavailableState.liveUsage.status).toBe('unavailable');
    expect(unavailableState.sourceFreshness).toEqual({
      limitsFetchedAt: '2026-07-27T12:00:00.000Z',
      usageFetchedAt: '2026-07-27T12:00:00.000Z',
      usageDataThroughDay: '2026-07-24'
    });
    await unavailable.close();

    const local = new FakeLocalUsageSource([
      {
        aggregateTokens: 1,
        sampledAt: '2026-07-27T12:00:00.000Z'
      }
    ]);
    const disabled = new RefreshCoordinator({
      store: new MemoryStore(),
      discover: () => Promise.resolve(executable),
      createClient: () => new FakeClient(),
      localUsageSource: local,
      localEnabled: false
    });
    await disabled.loadCached();
    expect((await disabled.refresh('launch')).liveUsage.status).toBe('disabled');
    expect(local.codexHomes).toEqual([]);
    await disabled.close();
  });

  it('continues today’s observed increase from persisted history after restart', async () => {
    const store = new MemoryStore();
    const first = new RefreshCoordinator({
      store,
      discover: () => Promise.resolve(executable),
      createClient: () => new FakeClient(),
      localUsageSource: new FakeLocalUsageSource([
        {
          aggregateTokens: 1_000,
          sampledAt: '2026-07-27T10:00:00.000Z'
        },
        {
          aggregateTokens: 1_250,
          sampledAt: '2026-07-27T10:01:00.000Z'
        }
      ]),
      now: () => new Date('2026-07-27T10:00:00.000Z')
    });
    await first.loadCached();
    await first.refresh('launch');
    const beforeRestart = await first.refresh('automatic', 'live');
    expect(beforeRestart.liveUsage).toMatchObject({
      todayObservedTokens: 250,
      todaySampleCount: 2
    });
    await first.close();

    const restarted = new RefreshCoordinator({
      store,
      discover: () => Promise.resolve(executable),
      createClient: () => new FakeClient(),
      localUsageSource: new FakeLocalUsageSource([
        {
          aggregateTokens: 1_500,
          sampledAt: '2026-07-27T10:02:00.000Z'
        }
      ]),
      now: () => new Date('2026-07-27T10:02:00.000Z')
    });
    expect((await restarted.loadCached()).liveUsage).toMatchObject({
      status: 'observed',
      todayObservedTokens: 250,
      todaySampleCount: 2
    });
    expect((await restarted.refresh('launch')).liveUsage).toMatchObject({
      status: 'observed',
      todayObservedTokens: 500,
      todaySampleCount: 3,
      todayBaselineAt: '2026-07-27T10:00:00.000Z'
    });
    await restarted.close();
  });

  it('keeps delayed service buckets authoritative while limits and local activity advance', async () => {
    let currentTime = new Date('2026-07-27T12:00:00Z');
    const client = new FakeClient();
    const local = new FakeLocalUsageSource([
      {
        aggregateTokens: 1_000,
        sampledAt: '2026-07-27T12:00:00.000Z'
      },
      {
        aggregateTokens: 1_300,
        sampledAt: '2026-07-27T12:01:00.000Z',
        latestActivityAt: '2026-07-27T12:00:45.000Z'
      }
    ]);
    const coordinator = new RefreshCoordinator({
      store: new MemoryStore(),
      discover: () => Promise.resolve(executable),
      createClient: () => client,
      localUsageSource: local,
      now: () => currentTime
    });
    await coordinator.loadCached();
    const full = await coordinator.refresh('launch', 'full');
    expect(full.dailyUsage.map(entry => entry.dayKey)).toEqual(['2026-07-24']);
    expect(full.sourceFreshness).toEqual({
      limitsFetchedAt: '2026-07-27T12:00:00.000Z',
      usageFetchedAt: '2026-07-27T12:00:00.000Z',
      usageDataThroughDay: '2026-07-24'
    });

    const primary = rateLimits.rateLimits.primary;
    if (primary === null) {
      throw new Error('Fixture requires a primary limit.');
    }
    client.limits = {
      ...rateLimits,
      rateLimits: {
        ...rateLimits.rateLimits,
        primary: {
          ...primary,
          usedPercent: 35
        }
      }
    };
    currentTime = new Date('2026-07-27T12:01:00Z');
    const live = await coordinator.refresh('automatic', 'live');
    expect(live.limits[0]?.usedPercent).toBe(35);
    expect(live.dailyUsage.map(entry => entry.dayKey)).toEqual(['2026-07-24']);
    expect(live.sourceFreshness).toEqual({
      limitsFetchedAt: '2026-07-27T12:01:00.000Z',
      usageFetchedAt: '2026-07-27T12:00:00.000Z',
      usageDataThroughDay: '2026-07-24'
    });
    expect(live.liveUsage).toMatchObject({
      status: 'observed',
      deltaTokens: 300
    });
    await coordinator.close();
  });

  it('completes login and refreshes on the same client', async () => {
    const client = new FakeClient({account: {kind: 'signedOut'}});
    client.loginCompletionHook = () => {
      client.account = {kind: 'chatgpt', planType: 'plus'};
      return Promise.resolve();
    };
    const coordinator = new RefreshCoordinator({
      store: new MemoryStore(),
      discover: () => Promise.resolve(executable),
      createClient: () => client,
      now: () => new Date('2026-07-24T12:00:00Z')
    });
    await coordinator.loadCached();
    expect((await coordinator.refresh('launch')).status).toBe('unauthenticated');
    const prompt = await coordinator.startChatGPTLogin();
    expect(prompt.loginId).toBe('fixture-login');
    const result = await coordinator.waitForLoginCompletion(prompt.loginId);
    expect(result).toMatchObject({
      status: 'fresh',
      authenticationState: 'chatgpt'
    });
    expect(client.closed).toBe(false);
    await coordinator.close();
  });

  it('returns to unauthenticated after login timeout', async () => {
    const client = new FakeClient({
      account: {kind: 'signedOut'},
      loginCompletionHook: signal =>
        new Promise((_resolve, reject) => {
          const abort = (): void => reject(signal?.reason);
          signal?.addEventListener('abort', abort, {once: true});
        })
    });
    const coordinator = new RefreshCoordinator({
      store: new MemoryStore(),
      discover: () => Promise.resolve(executable),
      createClient: () => client,
      loginTimeoutMs: 5
    });
    await coordinator.loadCached();
    await coordinator.refresh('launch');
    const prompt = await coordinator.startChatGPTLogin();
    const result = await coordinator.waitForLoginCompletion(prompt.loginId);
    expect(result.status).toBe('unauthenticated');
    expect(result.warning?.message).toMatch(/timed out/u);
    await coordinator.close();
  });
});
