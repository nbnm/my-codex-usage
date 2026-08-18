import {randomUUID} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink
} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {AppError} from '../domain/errors.js';
import {compareLimits, hourKey} from '../domain/normalization.js';
import type {
  AuthenticationState,
  DailyUsageEntry,
  DiagnosticEntry,
  DisplaySafeError,
  HistoryStore,
  LimitHistoryEntry,
  LocalUsageCheckpoint,
  LocalUsageAggregate,
  LocalUsageDayObservation,
  NormalizedLimitWindow,
  PersistedHistory,
  SourceFreshness,
  UsageSummary
} from '../domain/types.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const DAILY_RETENTION_MS = 365 * DAY_MS;
const LIMIT_RETENTION_MS = 180 * DAY_MS;
const LOCAL_USAGE_RETENTION_MS = 180 * DAY_MS;
const DIAGNOSTIC_RETENTION_MS = 30 * DAY_MS;
const MAX_DIAGNOSTICS = 100;

export function defaultHistoryPath(): string {
  return join(
    homedir(),
    'Library',
    'Application Support',
    'my-codex-usage',
    'history-v4.json'
  );
}

export function defaultLegacyHistoryPath(): string {
  return join(
    homedir(),
    'Library',
    'Application Support',
    'my-codex-usage',
    'history.json'
  );
}

export class FileHistoryStore implements HistoryStore {
  readonly filePath: string;
  readonly legacyFilePath: string;
  private readonly now: () => Date;

  constructor(
    filePath: string = defaultHistoryPath(),
    now: () => Date = () => new Date(),
    legacyFilePath: string =
      filePath === defaultHistoryPath()
        ? defaultLegacyHistoryPath()
        : join(dirname(filePath), 'history.json')
  ) {
    this.filePath = filePath;
    this.legacyFilePath = legacyFilePath;
    this.now = now;
  }

  async load(): Promise<PersistedHistory> {
    await this.ensureDirectory();
    try {
      const text = await readFile(this.filePath, 'utf8');
      return pruneHistory(parsePersistedHistory(JSON.parse(text) as unknown), this.now());
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        return this.loadLegacy();
      }
      if (error instanceof SyntaxError || error instanceof AppError) {
        await this.quarantineCorruptFile();
        return appendDiagnostic(
          emptyHistory(),
          {
            category: 'historyCorrupt',
            message: 'Local usage history was corrupt and has been reset.',
            recovery: undefined
          },
          this.now()
        );
      }
      throw new AppError(
        'historyUnavailable',
        'Local usage history could not be read.',
        'Check permissions for the application support directory.',
        {cause: error}
      );
    }
  }

  private async loadLegacy(): Promise<PersistedHistory> {
    if (this.legacyFilePath === this.filePath) {
      return emptyHistory();
    }
    try {
      const text = await readFile(this.legacyFilePath, 'utf8');
      return pruneHistory(parsePersistedHistory(JSON.parse(text) as unknown), this.now());
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        return emptyHistory();
      }
      if (error instanceof SyntaxError || error instanceof AppError) {
        return appendDiagnostic(
          emptyHistory(),
          {
            category: 'historyCorrupt',
            message: 'Legacy usage history could not be migrated.',
            recovery: undefined
          },
          this.now()
        );
      }
      throw new AppError(
        'historyUnavailable',
        'Legacy usage history could not be read.',
        'Check permissions for the application support directory.',
        {cause: error}
      );
    }
  }

  async save(history: PersistedHistory): Promise<void> {
    await this.ensureDirectory();
    const safeHistory = pruneHistory(history, this.now());
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporaryPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600
      );
      await handle.writeFile(`${JSON.stringify(safeHistory, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw new AppError(
        'historyUnavailable',
        'Local usage history could not be saved.',
        'Check permissions for the application support directory.',
        {cause: error}
      );
    }
  }

  async quarantineCorruptFile(): Promise<void> {
    const suffix = this.now().toISOString().replaceAll(':', '-');
    try {
      await rename(this.filePath, `${this.filePath}.${suffix}.corrupt`);
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) {
        throw new AppError(
          'historyUnavailable',
          'Corrupt local history could not be quarantined.',
          'Check permissions for the application support directory.',
          {cause: error}
        );
      }
    }
  }

  private async ensureDirectory(): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, {recursive: true, mode: 0o700});
    await chmod(directory, 0o700);
  }
}

export function emptyHistory(): PersistedHistory {
  return {
    schemaVersion: 4,
    lastAttemptAt: undefined,
    lastSuccessfulAt: undefined,
    detectedCodexVersion: undefined,
    authenticationState: 'unknown',
    usageSummary: {},
    sourceFreshness: {},
    localUsageDays: [],
    dailyUsage: [],
    limitHistory: [],
    diagnostics: []
  };
}

export function mergeSuccessfulRefresh(
  history: PersistedHistory,
  input: {
    observedAt: Date;
    codexVersion: string;
    authenticationState: AuthenticationState;
    limits: NormalizedLimitWindow[];
    usageSummary?: UsageSummary | undefined;
    dailyUsage: DailyUsageEntry[] | undefined;
    sourceFreshness?: SourceFreshness;
  }
): PersistedHistory {
  const observedAt = input.observedAt.toISOString();
  const dailyByKey = new Map(history.dailyUsage.map(entry => [entry.dayKey, entry]));
  for (const entry of input.dailyUsage ?? []) {
    dailyByKey.set(entry.dayKey, entry);
  }

  const hourlyByKey = new Map(
    history.limitHistory.map(entry => [
      `${entry.hourKey}|${entry.limitKey}`,
      entry
    ])
  );
  for (const limit of input.limits) {
    const entry: LimitHistoryEntry = {
      hourKey: hourKey(input.observedAt),
      observedAt,
      limitKey: limit.key,
      limitId: limit.limitId,
      displayName: limit.displayName,
      windowKind: limit.windowKind,
      durationMinutes: limit.durationMinutes,
      remainingPercent: limit.remainingPercent,
      resetsAt: limit.resetsAt
    };
    hourlyByKey.set(`${entry.hourKey}|${entry.limitKey}`, entry);
  }

  return pruneHistory(
    {
      ...history,
      lastAttemptAt: observedAt,
      lastSuccessfulAt: observedAt,
      detectedCodexVersion: input.codexVersion,
      authenticationState: input.authenticationState,
      usageSummary: input.usageSummary ?? history.usageSummary,
      sourceFreshness: input.sourceFreshness ?? history.sourceFreshness,
      dailyUsage: [...dailyByKey.values()].sort((a, b) =>
        a.dayKey.localeCompare(b.dayKey)
      ),
      limitHistory: [...hourlyByKey.values()].sort((a, b) =>
        a.observedAt.localeCompare(b.observedAt)
      )
    },
    input.observedAt
  );
}

export type LocalUsageSampleResult = {
  history: PersistedHistory;
  observation: LocalUsageDayObservation;
  sampleStatus: 'baseline' | 'observed' | 'reset';
};

export function recordLocalUsageSample(
  history: PersistedHistory,
  sample: LocalUsageAggregate
): LocalUsageSampleResult {
  const dayKey = sample.sampledAt.slice(0, 10);
  const existing = history.localUsageDays.find(entry => entry.dayKey === dayKey);
  if (
    existing !== undefined &&
    Date.parse(sample.sampledAt) <= Date.parse(existing.latestSampledAt)
  ) {
    return {
      history,
      observation: existing,
      sampleStatus:
        existing.observedIncreaseTokens > 0 ? 'observed' : 'baseline'
    };
  }

  let observation: LocalUsageDayObservation;
  let sampleStatus: LocalUsageSampleResult['sampleStatus'];
  if (existing === undefined) {
    observation = {
      dayKey,
      baselineAggregateTokens: sample.aggregateTokens,
      baselineSampledAt: sample.sampledAt,
      latestAggregateTokens: sample.aggregateTokens,
      latestSampledAt: sample.sampledAt,
      observedIncreaseTokens: 0,
      sampleCount: 1,
      resetCount: 0,
      ...(sample.latestActivityAt === undefined
        ? {}
        : {latestActivityAt: sample.latestActivityAt})
    };
    sampleStatus = 'baseline';
  } else {
    const reset = sample.aggregateTokens < existing.latestAggregateTokens;
    const increase = reset
      ? 0
      : sample.aggregateTokens - existing.latestAggregateTokens;
    observation = {
      ...existing,
      latestAggregateTokens: sample.aggregateTokens,
      latestSampledAt: sample.sampledAt,
      observedIncreaseTokens: existing.observedIncreaseTokens + increase,
      sampleCount: existing.sampleCount + 1,
      resetCount: existing.resetCount + (reset ? 1 : 0),
      ...(sample.latestActivityAt === undefined
        ? {}
        : {latestActivityAt: sample.latestActivityAt})
    };
    sampleStatus = reset ? 'reset' : 'observed';
  }

  const localUsageDays = history.localUsageDays
    .filter(entry => entry.dayKey !== dayKey)
    .concat(observation)
    .sort((left, right) => left.dayKey.localeCompare(right.dayKey));
  return {
    history: pruneHistory({...history, localUsageDays}, new Date(sample.sampledAt)),
    observation,
    sampleStatus
  };
}

export function recordAttempt(
  history: PersistedHistory,
  attemptedAt: Date,
  authenticationState?: AuthenticationState
): PersistedHistory {
  return {
    ...history,
    lastAttemptAt: attemptedAt.toISOString(),
    authenticationState: authenticationState ?? history.authenticationState
  };
}

export function appendDiagnostic(
  history: PersistedHistory,
  error: DisplaySafeError,
  occurredAt: Date
): PersistedHistory {
  const entry: DiagnosticEntry = {
    occurredAt: occurredAt.toISOString(),
    category: error.category
  };
  return pruneHistory(
    {...history, diagnostics: [...history.diagnostics, entry]},
    occurredAt
  );
}

export function pruneHistory(
  history: PersistedHistory,
  now: Date
): PersistedHistory {
  const nowMs = now.getTime();
  return {
    ...history,
    dailyUsage: history.dailyUsage.filter(entry =>
      isWithin(entry.dayKey, DAILY_RETENTION_MS, nowMs)
    ),
    limitHistory: history.limitHistory.filter(entry =>
      isWithin(entry.observedAt, LIMIT_RETENTION_MS, nowMs)
    ),
    localUsageDays: history.localUsageDays.filter(entry =>
      isWithin(entry.dayKey, LOCAL_USAGE_RETENTION_MS, nowMs)
    ),
    diagnostics: history.diagnostics
      .filter(entry => isWithin(entry.occurredAt, DIAGNOSTIC_RETENTION_MS, nowMs))
      .slice(-MAX_DIAGNOSTICS)
  };
}

export function latestLimitsFromHistory(
  entries: LimitHistoryEntry[]
): NormalizedLimitWindow[] {
  const latest = new Map<string, LimitHistoryEntry>();
  for (const entry of entries) {
    const existing = latest.get(entry.limitKey);
    if (existing === undefined || entry.observedAt > existing.observedAt) {
      latest.set(entry.limitKey, entry);
    }
  }
  return [...latest.values()]
    .map(entry => ({
      key: entry.limitKey,
      limitId: entry.limitId,
      limitName: undefined,
      windowKind: entry.windowKind,
      durationMinutes: entry.durationMinutes,
      usedPercent: 100 - entry.remainingPercent,
      remainingPercent: entry.remainingPercent,
      resetsAt: entry.resetsAt,
      planType: undefined,
      reachedLimitType: undefined,
      displayName: entry.displayName
    }))
    .sort((left, right) => compareLimits(left, right));
}

function parsePersistedHistory(value: unknown): PersistedHistory {
  const object = record(value);
  if (
    object.schemaVersion !== 1 &&
    object.schemaVersion !== 2 &&
    object.schemaVersion !== 3 &&
    object.schemaVersion !== 4
  ) {
    throw corrupt();
  }
  const dailyUsage = array(object.dailyUsage).map(parseDailyUsage);
  const lastSuccessfulAt = optionalIso(object.lastSuccessfulAt);
  return {
    schemaVersion: 4,
    lastAttemptAt: optionalIso(object.lastAttemptAt),
    lastSuccessfulAt,
    detectedCodexVersion: optionalString(object.detectedCodexVersion),
    authenticationState: parseAuthenticationState(object.authenticationState),
    usageSummary:
      object.schemaVersion === 1
        ? {}
        : parseUsageSummary(object.usageSummary),
    sourceFreshness:
      object.schemaVersion === 3 || object.schemaVersion === 4
        ? parseSourceFreshness(object.sourceFreshness)
        : migrateSourceFreshness(lastSuccessfulAt, dailyUsage),
    localUsageDays:
      object.schemaVersion === 4
        ? array(object.localUsageDays).map(parseLocalUsageDay)
        : object.schemaVersion === 3
          ? migrateLocalUsageCheckpoint(
              parseLocalUsageCheckpoint(object.localUsageCheckpoint)
            )
          : [],
    dailyUsage,
    limitHistory: array(object.limitHistory).map(parseLimitHistory),
    diagnostics: array(object.diagnostics).map(parseDiagnostic)
  };
}

function migrateLocalUsageCheckpoint(
  checkpoint: LocalUsageCheckpoint | undefined
): LocalUsageDayObservation[] {
  if (checkpoint === undefined) {
    return [];
  }
  return [
    {
      dayKey: checkpoint.sampledAt.slice(0, 10),
      baselineAggregateTokens: checkpoint.aggregateTokens,
      baselineSampledAt: checkpoint.sampledAt,
      latestAggregateTokens: checkpoint.aggregateTokens,
      latestSampledAt: checkpoint.sampledAt,
      observedIncreaseTokens: 0,
      sampleCount: 1,
      resetCount: 0,
      ...(checkpoint.latestActivityAt === undefined
        ? {}
        : {latestActivityAt: checkpoint.latestActivityAt})
    }
  ];
}

function parseSourceFreshness(value: unknown): SourceFreshness {
  const object = record(value);
  const freshness: SourceFreshness = {};
  const limitsFetchedAt = optionalIso(object.limitsFetchedAt);
  const usageFetchedAt = optionalIso(object.usageFetchedAt);
  const usageDataThroughDay = optionalDayKey(object.usageDataThroughDay);
  if (limitsFetchedAt !== undefined) {
    freshness.limitsFetchedAt = limitsFetchedAt;
  }
  if (usageFetchedAt !== undefined) {
    freshness.usageFetchedAt = usageFetchedAt;
  }
  if (usageDataThroughDay !== undefined) {
    freshness.usageDataThroughDay = usageDataThroughDay;
  }
  return freshness;
}

function migrateSourceFreshness(
  lastSuccessfulAt: string | undefined,
  dailyUsage: DailyUsageEntry[]
): SourceFreshness {
  const freshness: SourceFreshness = {};
  if (lastSuccessfulAt !== undefined) {
    freshness.limitsFetchedAt = lastSuccessfulAt;
  }
  const latestFetch = dailyUsage
    .map(entry => entry.fetchedAt)
    .sort()
    .at(-1);
  const latestDay = dailyUsage
    .map(entry => entry.dayKey)
    .sort()
    .at(-1);
  if (latestFetch !== undefined) {
    freshness.usageFetchedAt = latestFetch;
  }
  if (latestDay !== undefined) {
    freshness.usageDataThroughDay = latestDay;
  }
  return freshness;
}

function parseLocalUsageCheckpoint(
  value: unknown
): LocalUsageCheckpoint | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const object = record(value);
  const checkpoint: LocalUsageCheckpoint = {
    aggregateTokens: requiredNonNegativeInteger(object.aggregateTokens),
    sampledAt: requiredIso(object.sampledAt)
  };
  const latestActivityAt = optionalIso(object.latestActivityAt);
  if (latestActivityAt !== undefined) {
    checkpoint.latestActivityAt = latestActivityAt;
  }
  return checkpoint;
}

function parseLocalUsageDay(value: unknown): LocalUsageDayObservation {
  const object = record(value);
  const dayKey = optionalDayKey(object.dayKey);
  if (dayKey === undefined) {
    throw corrupt();
  }
  const observation: LocalUsageDayObservation = {
    dayKey,
    baselineAggregateTokens: requiredNonNegativeInteger(
      object.baselineAggregateTokens
    ),
    baselineSampledAt: requiredIso(object.baselineSampledAt),
    latestAggregateTokens: requiredNonNegativeInteger(
      object.latestAggregateTokens
    ),
    latestSampledAt: requiredIso(object.latestSampledAt),
    observedIncreaseTokens: requiredNonNegativeInteger(
      object.observedIncreaseTokens
    ),
    sampleCount: requiredPositiveInteger(object.sampleCount),
    resetCount: requiredNonNegativeInteger(object.resetCount)
  };
  const latestActivityAt = optionalIso(object.latestActivityAt);
  if (latestActivityAt !== undefined) {
    observation.latestActivityAt = latestActivityAt;
  }
  if (
    observation.baselineSampledAt.slice(0, 10) !== dayKey ||
    observation.latestSampledAt.slice(0, 10) !== dayKey ||
    observation.latestSampledAt < observation.baselineSampledAt
  ) {
    throw corrupt();
  }
  return observation;
}

function parseUsageSummary(value: unknown): UsageSummary {
  const object = record(value);
  const summary: UsageSummary = {};
  const lifetimeTokens = optionalNonNegativeInteger(object.lifetimeTokens);
  const currentStreakDays = optionalNonNegativeInteger(
    object.currentStreakDays
  );
  const longestStreakDays = optionalNonNegativeInteger(
    object.longestStreakDays
  );
  const peakDailyTokens = optionalNonNegativeInteger(object.peakDailyTokens);
  const longestRunningTurnSeconds = optionalNonNegativeInteger(
    object.longestRunningTurnSeconds
  );
  if (lifetimeTokens !== undefined) {
    summary.lifetimeTokens = lifetimeTokens;
  }
  if (currentStreakDays !== undefined) {
    summary.currentStreakDays = currentStreakDays;
  }
  if (longestStreakDays !== undefined) {
    summary.longestStreakDays = longestStreakDays;
  }
  if (peakDailyTokens !== undefined) {
    summary.peakDailyTokens = peakDailyTokens;
  }
  if (longestRunningTurnSeconds !== undefined) {
    summary.longestRunningTurnSeconds = longestRunningTurnSeconds;
  }
  return summary;
}

function parseDailyUsage(value: unknown): DailyUsageEntry {
  const object = record(value);
  return {
    dayKey: requiredString(object.dayKey),
    tokens: requiredNonNegativeInteger(object.tokens),
    fetchedAt: requiredIso(object.fetchedAt)
  };
}

function parseLimitHistory(value: unknown): LimitHistoryEntry {
  const object = record(value);
  const kind = object.windowKind;
  if (kind !== 'primary' && kind !== 'secondary') {
    throw corrupt();
  }
  return {
    hourKey: requiredString(object.hourKey),
    observedAt: requiredIso(object.observedAt),
    limitKey: requiredString(object.limitKey),
    limitId: requiredString(object.limitId),
    displayName: requiredString(object.displayName),
    windowKind: kind,
    durationMinutes: optionalNonNegativeInteger(object.durationMinutes),
    remainingPercent: requiredNonNegativeNumber(object.remainingPercent),
    resetsAt: optionalIso(object.resetsAt)
  };
}

function parseDiagnostic(value: unknown): DiagnosticEntry {
  const object = record(value);
  const category = object.category;
  if (!isErrorCategory(category)) {
    throw corrupt();
  }
  return {
    occurredAt: requiredIso(object.occurredAt),
    category
  };
}

function parseAuthenticationState(value: unknown): AuthenticationState {
  if (
    value === 'unknown' ||
    value === 'chatgpt' ||
    value === 'signedOut' ||
    value === 'apiKeyUnsupported' ||
    value === 'unsupported'
  ) {
    return value;
  }
  throw corrupt();
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw corrupt();
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw corrupt();
  }
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') {
    throw corrupt();
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredString(value);
}

function requiredIso(value: unknown): string {
  const text = requiredString(value);
  if (Number.isNaN(Date.parse(text))) {
    throw corrupt();
  }
  return text;
}

function optionalIso(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredIso(value);
}

function optionalDayKey(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const text = requiredString(value);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(text) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== text
  ) {
    throw corrupt();
  }
  return text;
}

function requiredNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw corrupt();
  }
  return value as number;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return value === undefined ? undefined : requiredNonNegativeInteger(value);
}

function requiredPositiveInteger(value: unknown): number {
  const integer = requiredNonNegativeInteger(value);
  if (integer === 0) {
    throw corrupt();
  }
  return integer;
}

function requiredNonNegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw corrupt();
  }
  return value;
}

function corrupt(): AppError {
  return new AppError(
    'historyCorrupt',
    'Local usage history is invalid.',
    undefined
  );
}

function isWithin(value: string, retentionMs: number, nowMs: number): boolean {
  const timestamp = Date.parse(
    /^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00.000Z` : value
  );
  return !Number.isNaN(timestamp) && timestamp >= nowMs - retentionMs;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function isErrorCategory(value: unknown): value is DiagnosticEntry['category'] {
  return (
    value === 'cliMissing' ||
    value === 'cliInvalid' ||
    value === 'cliIncompatible' ||
    value === 'unauthenticated' ||
    value === 'authenticationUnsupported' ||
    value === 'processFailed' ||
    value === 'requestTimeout' ||
    value === 'protocolMalformed' ||
    value === 'protocolIncompatible' ||
    value === 'usageUnavailable' ||
    value === 'serviceUnavailable' ||
    value === 'historyCorrupt' ||
    value === 'historyUnavailable'
  );
}
