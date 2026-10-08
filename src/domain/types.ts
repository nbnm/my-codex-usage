export const PACKAGE_NAME = 'my-codex-usage';
export const PACKAGE_VERSION = '0.2.0';
export const MINIMUM_CODEX_VERSION = '0.144.3';

export type UsageRange = 7 | 30 | 90 | 180;
export type UsageGranularity = 'day' | 'week';
export type RefreshScope = 'full' | 'live';

export type LimitWindowKind = 'primary' | 'secondary';

export type AccountStatus =
  | {kind: 'chatgpt'; planType: string}
  | {kind: 'signedOut'}
  | {kind: 'apiKeyUnsupported'}
  | {kind: 'unsupported'; accountType: string};

export type ErrorCategory =
  | 'cliMissing'
  | 'cliInvalid'
  | 'cliIncompatible'
  | 'unauthenticated'
  | 'authenticationUnsupported'
  | 'processFailed'
  | 'requestTimeout'
  | 'protocolMalformed'
  | 'protocolIncompatible'
  | 'usageUnavailable'
  | 'serviceUnavailable'
  | 'historyCorrupt'
  | 'historyUnavailable';

export type DisplaySafeError = {
  category: ErrorCategory;
  message: string;
  recovery: string | undefined;
};

export type NormalizedLimitWindow = {
  key: string;
  limitId: string;
  limitName: string | undefined;
  windowKind: LimitWindowKind;
  durationMinutes: number | undefined;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | undefined;
  planType: string | undefined;
  reachedLimitType: string | undefined;
  displayName: string;
};

export type DailyUsageEntry = {
  dayKey: string;
  tokens: number;
  fetchedAt: string;
};

export type UsageSummary = {
  lifetimeTokens?: number;
  currentStreakDays?: number;
  longestStreakDays?: number;
  peakDailyTokens?: number;
  longestRunningTurnSeconds?: number;
};

export type CodexRuntimeInfo = {
  codexHome: string;
};

export type LocalUsageAggregate = {
  aggregateTokens: number;
  sampledAt: string;
  latestActivityAt?: string;
};

export type LocalUsageCheckpoint = LocalUsageAggregate;

export type TokenBreakdown = {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export type RatedCreditRate = {
  kind: 'rated';
  id: string;
  displayName: string;
  aliases: readonly string[];
  inputCreditsPerMillion: number;
  cachedInputCreditsPerMillion: number;
  outputCreditsPerMillion: number;
};

export type UnpricedCreditRate = {
  kind: 'researchPreview';
  id: string;
  displayName: string;
  aliases: readonly string[];
};

export type CreditRate = RatedCreditRate | UnpricedCreditRate;

export type CreditEstimate =
  | {
      status: 'estimated';
      rateName: string;
      uncachedInputTokens: number;
      inputCredits: number;
      cachedInputCredits: number;
      outputCredits: number;
      totalCredits: number;
    }
  | {
      status: 'unpriced';
      rateName: string | undefined;
      reason: 'unknownModel' | 'researchPreview' | 'inconsistentCounters';
    };

export type CreditEstimateSummary = {
  estimatedCredits: number;
  pricedGroupCount: number;
  unpricedGroupCount: number;
};

export type TodayUsageGroup = TokenBreakdown & {
  projectFolder: string;
  worktreePath?: string;
  model: string;
  effort: string;
  eventCount: number;
};

export type TodayUsageSnapshot = {
  status: 'ready' | 'unavailable';
  dayKey: string;
  sampledAt: string;
  groups: TodayUsageGroup[];
  total: TokenBreakdown;
  scannedFileCount: number;
  tokenEventCount: number;
  skippedRecordCount: number;
  skippedFileCount: number;
  warning: string | undefined;
};

export type LocalUsageDayObservation = {
  dayKey: string;
  baselineAggregateTokens: number;
  baselineSampledAt: string;
  latestAggregateTokens: number;
  latestSampledAt: string;
  observedIncreaseTokens: number;
  sampleCount: number;
  resetCount: number;
  latestActivityAt?: string;
};

export type LocalUsagePeriodPoint = {
  periodKey: string;
  startDayKey: string;
  endDayKey: string;
  granularity: UsageGranularity;
  observedTokens?: number;
  observedDayCount: number;
  inRangeDayCount: number;
  sampleCount: number;
  resetCount: number;
  firstSampleAt?: string;
  latestSampleAt?: string;
  isCurrentPeriod: boolean;
  isBoundaryPeriod: boolean;
};

export type JoinedUsageSource = 'service' | 'local' | 'mixed' | 'missing';

export type JoinedUsagePeriodPoint = {
  periodKey: string;
  startDayKey: string;
  endDayKey: string;
  includedStartDayKey: string;
  includedEndDayKey: string;
  granularity: UsageGranularity;
  state: 'complete' | 'partial' | 'pending' | 'unreported';
  source: JoinedUsageSource;
  tokens: number | undefined;
  serviceContributionTokens: number;
  localContributionTokens: number;
  serviceAvailableTokens: number;
  serviceReportedDayCount: number;
  serviceDayCount: number;
  localDayCount: number;
  missingDayCount: number;
  activeDayCount: number;
  inRangeDayCount: number;
  sampleCount: number;
  resetCount: number;
  firstSampleAt: string | undefined;
  latestSampleAt: string | undefined;
  isCurrentPeriod: boolean;
  isBoundaryPeriod: boolean;
  isIncomplete: boolean;
};

export type LiveUsageState = {
  status: 'observed' | 'baseline' | 'reset' | 'unavailable' | 'disabled';
  aggregateTokens?: number;
  deltaTokens?: number;
  intervalStartedAt?: string;
  sampledAt?: string;
  latestActivityAt?: string;
  todayDayKey?: string;
  todayObservedTokens?: number;
  todayBaselineAt?: string;
  todayLatestSampleAt?: string;
  todayCoverageStartedAt?: string;
  todaySampleCount?: number;
  todayResetCount?: number;
};

export type SourceFreshness = {
  limitsFetchedAt?: string;
  usageFetchedAt?: string;
  usageDataThroughDay?: string;
};

export type LimitHistoryEntry = {
  hourKey: string;
  observedAt: string;
  limitKey: string;
  limitId: string;
  displayName: string;
  windowKind: LimitWindowKind;
  durationMinutes: number | undefined;
  remainingPercent: number;
  resetsAt: string | undefined;
};

export type DiagnosticEntry = {
  occurredAt: string;
  category: ErrorCategory;
};

export type AuthenticationState =
  | 'unknown'
  | 'chatgpt'
  | 'signedOut'
  | 'apiKeyUnsupported'
  | 'unsupported';

export type PersistedHistory = {
  schemaVersion: 4;
  lastAttemptAt: string | undefined;
  lastSuccessfulAt: string | undefined;
  detectedCodexVersion: string | undefined;
  authenticationState: AuthenticationState;
  usageSummary: UsageSummary;
  sourceFreshness: SourceFreshness;
  localUsageDays: LocalUsageDayObservation[];
  dailyUsage: DailyUsageEntry[];
  limitHistory: LimitHistoryEntry[];
  diagnostics: DiagnosticEntry[];
};

export type DashboardStatus =
  | 'loading'
  | 'authenticating'
  | 'fresh'
  | 'partial'
  | 'stale'
  | 'unauthenticated'
  | 'unavailable'
  | 'incompatible';

export type DashboardSnapshot = {
  status: DashboardStatus;
  limits: NormalizedLimitWindow[];
  usageSummary: UsageSummary;
  dailyUsage: DailyUsageEntry[];
  localUsageDays: LocalUsageDayObservation[];
  limitHistory: LimitHistoryEntry[];
  lastAttemptAt: string | undefined;
  lastSuccessfulAt: string | undefined;
  codexVersion: string | undefined;
  planType: string | undefined;
  authenticationState: AuthenticationState;
  sourceFreshness: SourceFreshness;
  liveUsage: LiveUsageState;
  warning: DisplaySafeError | undefined;
  isRefreshing: boolean;
};

export type RefreshTrigger = 'launch' | 'manual' | 'automatic';

export type LoginPrompt = {
  authUrl: string;
  loginId: string;
};

export type ServerNotification = {
  method: string;
  params: unknown;
};

export interface JsonRpcTransport {
  connect(signal?: AbortSignal): Promise<void>;
  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T>;
  notify(method: string, params?: unknown): Promise<void>;
  notifications(): AsyncIterable<ServerNotification>;
  close(): Promise<void>;
}

export interface CodexAccountClient {
  initialize(signal?: AbortSignal): Promise<CodexRuntimeInfo>;
  readAccount(signal?: AbortSignal): Promise<AccountStatus>;
  readRateLimits(signal?: AbortSignal): Promise<RateLimitsDTO>;
  readUsage(signal?: AbortSignal): Promise<AccountUsageDTO>;
  startChatGPTLogin(signal?: AbortSignal): Promise<LoginPrompt>;
  waitForLoginCompletion(loginId: string, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface LocalUsageSource {
  readAggregate(
    codexHome: string,
    signal?: AbortSignal
  ): Promise<LocalUsageAggregate | undefined>;
}

export interface TodayUsageSource {
  readToday(
    codexHome: string,
    signal?: AbortSignal
  ): Promise<TodayUsageSnapshot>;
}

export interface HistoryStore {
  load(): Promise<PersistedHistory>;
  save(history: PersistedHistory): Promise<void>;
  quarantineCorruptFile(): Promise<void>;
}

export interface UsageRefreshCoordinator {
  loadCached(): Promise<DashboardSnapshot>;
  refresh(
    trigger: RefreshTrigger,
    scope?: RefreshScope
  ): Promise<DashboardSnapshot>;
  startChatGPTLogin(): Promise<LoginPrompt>;
  waitForLoginCompletion(loginId: string): Promise<DashboardSnapshot>;
  startAutomaticRefresh(callback: (state: DashboardSnapshot) => void): void;
  close(): Promise<void>;
}

export type RateLimitWindowDTO = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type RateLimitSnapshotDTO = {
  limitId: string | null;
  limitName: string | null;
  planType: string | null;
  primary: RateLimitWindowDTO | null;
  secondary: RateLimitWindowDTO | null;
  rateLimitReachedType: string | null;
};

export type RateLimitsDTO = {
  rateLimits: RateLimitSnapshotDTO;
  rateLimitsByLimitId: Record<string, RateLimitSnapshotDTO> | null;
};

export type AccountUsageDTO = {
  summary: {
    lifetimeTokens: number | null;
    currentStreakDays: number | null;
    longestStreakDays: number | null;
    peakDailyTokens: number | null;
    longestRunningTurnSec: number | null;
  };
  dailyUsageBuckets: Array<{startDate: string; tokens: number}> | null;
};

export type CodexExecutable = {
  path: string;
  version: string;
};
