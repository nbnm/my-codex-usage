import type {
  AccountUsageDTO,
  DailyUsageEntry,
  LimitWindowKind,
  NormalizedLimitWindow,
  RateLimitSnapshotDTO,
  RateLimitsDTO,
  UsageSummary
} from './types.js';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u;

export function normalizeRateLimits(
  response: RateLimitsDTO,
  now: Date = new Date()
): NormalizedLimitWindow[] {
  const candidates: Array<{
    fallbackId: string;
    snapshot: RateLimitSnapshotDTO;
    priority: number;
  }> = [];

  if (response.rateLimitsByLimitId !== null) {
    for (const [limitId, snapshot] of Object.entries(response.rateLimitsByLimitId)) {
      candidates.push({fallbackId: limitId, snapshot, priority: 0});
    }
  }
  candidates.push({fallbackId: 'default', snapshot: response.rateLimits, priority: 1});

  const deduped = new Map<string, {limit: NormalizedLimitWindow; priority: number}>();
  for (const candidate of candidates) {
    for (const kind of ['primary', 'secondary'] as const) {
      const window = candidate.snapshot[kind];
      if (window === null) {
        continue;
      }

      const limitId = nonEmpty(candidate.snapshot.limitId) ?? candidate.fallbackId;
      const resetsAt = epochSecondsToIso(window.resetsAt);
      const durationMinutes =
        window.windowDurationMins !== null && window.windowDurationMins > 0
          ? window.windowDurationMins
          : undefined;
      const usedPercent = window.usedPercent;
      const remainingPercent = clamp(100 - usedPercent, 0, 100);
      const limitName = nonEmpty(candidate.snapshot.limitName);
      const stableKey = [limitId, kind, durationMinutes ?? 'unknown'].join('|');
      const identity = [stableKey, resetsAt ?? 'unknown'].join('|');
      const displayName = makeDisplayName(limitName, limitId, kind, durationMinutes);
      const limit: NormalizedLimitWindow = {
        key: stableKey,
        limitId,
        limitName,
        windowKind: kind,
        durationMinutes,
        usedPercent,
        remainingPercent,
        resetsAt,
        planType: nonEmpty(candidate.snapshot.planType),
        reachedLimitType: nonEmpty(candidate.snapshot.rateLimitReachedType),
        displayName
      };

      const existing = deduped.get(identity);
      if (existing === undefined || candidate.priority < existing.priority) {
        deduped.set(identity, {limit, priority: candidate.priority});
      }
    }
  }

  return [...deduped.values()]
    .map(({limit}) => limit)
    .sort((left, right) => compareLimits(left, right, now));
}

export function normalizeDailyUsage(
  response: AccountUsageDTO,
  fetchedAt: Date = new Date()
): DailyUsageEntry[] {
  const entries = new Map<string, DailyUsageEntry>();
  for (const bucket of response.dailyUsageBuckets ?? []) {
    if (!isValidDayKey(bucket.startDate) || !Number.isSafeInteger(bucket.tokens) || bucket.tokens < 0) {
      continue;
    }
    entries.set(bucket.startDate, {
      dayKey: bucket.startDate,
      tokens: bucket.tokens,
      fetchedAt: fetchedAt.toISOString()
    });
  }
  return [...entries.values()].sort((left, right) => left.dayKey.localeCompare(right.dayKey));
}

export function normalizeUsageSummary(
  response: AccountUsageDTO
): UsageSummary {
  const summary: UsageSummary = {};
  if (response.summary.lifetimeTokens !== null) {
    summary.lifetimeTokens = response.summary.lifetimeTokens;
  }
  if (response.summary.currentStreakDays !== null) {
    summary.currentStreakDays = response.summary.currentStreakDays;
  }
  if (response.summary.longestStreakDays !== null) {
    summary.longestStreakDays = response.summary.longestStreakDays;
  }
  if (response.summary.peakDailyTokens !== null) {
    summary.peakDailyTokens = response.summary.peakDailyTokens;
  }
  if (response.summary.longestRunningTurnSec !== null) {
    summary.longestRunningTurnSeconds =
      response.summary.longestRunningTurnSec;
  }
  return summary;
}

export function compareLimits(
  left: NormalizedLimitWindow,
  right: NormalizedLimitWindow,
  now: Date = new Date()
): number {
  const leftActive = left.resetsAt === undefined || Date.parse(left.resetsAt) > now.getTime();
  const rightActive = right.resetsAt === undefined || Date.parse(right.resetsAt) > now.getTime();
  if (leftActive !== rightActive) {
    return leftActive ? -1 : 1;
  }

  const durationDifference =
    (left.durationMinutes ?? Number.POSITIVE_INFINITY) -
    (right.durationMinutes ?? Number.POSITIVE_INFINITY);
  if (durationDifference !== 0) {
    return durationDifference;
  }

  if (left.windowKind !== right.windowKind) {
    return left.windowKind === 'primary' ? -1 : 1;
  }
  return left.limitId.localeCompare(right.limitId);
}

export function isValidDayKey(value: string): boolean {
  if (!DAY_KEY.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function hourKey(date: Date): string {
  return date.toISOString().slice(0, 13);
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function makeDisplayName(
  name: string | undefined,
  limitId: string,
  kind: LimitWindowKind,
  durationMinutes: number | undefined
): string {
  if (name !== undefined) {
    return name;
  }

  const humanId = humanize(limitId);
  const base =
    humanId !== '' && limitId !== 'default'
      ? humanId
      : `${capitalize(kind)} usage limit`;
  return durationMinutes === undefined ? base : `${base} (${formatDuration(durationMinutes)})`;
}

function humanize(value: string): string {
  return value
    .replace(/[_-]+/gu, ' ')
    .trim()
    .replace(/\b\p{L}/gu, character => character.toUpperCase());
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

function formatDuration(minutes: number): string {
  if (minutes % 10_080 === 0) {
    return `${minutes / 10_080}w`;
  }
  if (minutes % 1_440 === 0) {
    return `${minutes / 1_440}d`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  return `${minutes}m`;
}

function epochSecondsToIso(value: number | null): string | undefined {
  if (value === null || !Number.isSafeInteger(value)) {
    return undefined;
  }
  const date = new Date(value * 1_000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function nonEmpty(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
