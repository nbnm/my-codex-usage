import {
  formatElapsedSeconds,
  formatDuration,
  formatPercent,
  formatReset,
  formatTokens,
  formatUpdated,
  statusLabel
} from '../domain/format.js';
import type {
  DashboardSnapshot,
  LocalUsagePeriodPoint,
  UsageGranularity,
  UsageRange
} from '../domain/types.js';
import {
  joinedRangeUsageStatistics,
  joinedUsagePeriodPoints,
  localRangeUsageStatistics,
  localUsagePeriodPoints,
  observedPeriodLimitChange,
  rangeUsageStatistics,
  usagePeriodPoints,
  type JoinedUsagePeriodExtremum,
  type UsagePeriodPoint
} from '../domain/usage.js';

export function renderPlain(
  state: DashboardSnapshot,
  range: UsageRange,
  granularity: UsageGranularity = 'day',
  now: Date = new Date()
): string {
  const lines = [
    'My Codex Usage',
    `Status: ${statusLabel(state.status)}`,
    `Updated: ${formatUpdated(state.lastSuccessfulAt, now)}`,
    `Codex: ${state.codexVersion ?? 'unknown'}`,
    `Plan: ${state.planType ?? state.authenticationState}`,
    `Current limits fetched: ${formatSourceTime(state.sourceFreshness.limitsFetchedAt, now)}`,
    `Daily response fetched: ${formatSourceTime(state.sourceFreshness.usageFetchedAt, now)}`,
    `Service daily data: ${formatServiceDataThrough(state.sourceFreshness.usageDataThroughDay, now)}`
  ];

  if (state.warning !== undefined) {
    lines.push(`Warning: ${state.warning.message}`);
    if (state.warning.recovery !== undefined) {
      lines.push(`Recovery: ${state.warning.recovery}`);
    }
  }

  lines.push('', 'Current limits:');
  if (state.limits.length === 0) {
    lines.push('  No usable limit data.');
  } else {
    for (const limit of state.limits) {
      lines.push(
        `  ${limit.displayName} [${limit.windowKind}, ${formatDuration(limit.durationMinutes)}]`,
        `    Remaining: ${formatPercent(limit.remainingPercent)}; Used: ${formatPercent(limit.usedPercent)}; ${formatReset(limit.resetsAt, now)}`
      );
    }
  }

  const summary = state.usageSummary;
  lines.push(
    '',
    'Usage overview:',
    `  Lifetime tokens: ${formatOptionalTokens(summary.lifetimeTokens)}`,
    `  Current streak: ${formatOptionalDays(summary.currentStreakDays)}`,
    `  Longest streak: ${formatOptionalDays(summary.longestStreakDays)}`,
    `  Peak daily tokens: ${formatOptionalTokens(summary.peakDailyTokens)}`,
    `  Longest-running turn: ${formatElapsedSeconds(summary.longestRunningTurnSeconds)}`
  );
  lines.push('', 'Live observed activity:');
  lines.push(
    '  Scope: local observation—not service-accounted daily usage',
    ...plainLiveUsageLines(state, now)
  );

  const servicePeriods = usagePeriodPoints(
    state.dailyUsage,
    range,
    granularity,
    now
  );
  const localPeriods = localUsagePeriodPoints(
    state.localUsageDays,
    range,
    granularity,
    now
  );
  const joinedPeriods = joinedUsagePeriodPoints(
    state.dailyUsage,
    state.localUsageDays,
    range,
    granularity,
    now
  );
  const joinedStatistics = joinedRangeUsageStatistics(joinedPeriods);
  lines.push(
    '',
    `Joined token activity (${granularity}, ${range} trailing days):`,
    '  Rule: service for completed reported days; local for today or service gaps; same-day values are never added',
    '  Scope: not an authoritative service total'
  );
  lines.push(
    `  Joined total: ${formatTokens(joinedStatistics.totalTokens)} tokens`,
    `  Valued periods: ${joinedStatistics.valuedPeriods}`,
    `  Active periods: ${joinedStatistics.activePeriods}`,
    `  Coverage: ${joinedStatistics.serviceDays} service days; ${joinedStatistics.localDays} local days; ${joinedStatistics.missingDays}/${joinedStatistics.inRangeDays} missing days`,
    `  Average per valued period: ${
      joinedStatistics.averagePerValuedPeriod === undefined
        ? 'unavailable'
        : `${formatTokens(joinedStatistics.averagePerValuedPeriod)} tokens`
    }`,
    `  Average per active period: ${
      joinedStatistics.averagePerActivePeriod === undefined
        ? 'unavailable'
        : `${formatTokens(joinedStatistics.averagePerActivePeriod)} tokens`
    }`,
    `  Minimum joined period: ${formatJoinedExtremum(joinedStatistics.minimum)}`,
    `  Maximum joined period: ${formatJoinedExtremum(joinedStatistics.maximum)}`
  );
  for (const point of joinedPeriods) {
    const label = periodLabel(point);
    if (point.tokens === undefined) {
      lines.push(
        `  ${label}: ${point.state === 'pending' ? '? pending' : '· missing'}${point.isIncomplete ? '; incomplete' : ''}`
      );
      continue;
    }
    const source =
      point.source === 'service'
        ? 'S service'
        : point.source === 'local'
          ? 'L local partial'
          : 'M mixed';
    const coverage =
      point.granularity === 'week'
        ? `; ${point.serviceDayCount} service/${point.localDayCount} local/${point.missingDayCount} missing of ${point.inRangeDayCount} days`
        : '';
    const localCoverage =
      point.localDayCount === 0
        ? ''
        : `; ${point.sampleCount} ${pluralize('sample', point.sampleCount)}; ${point.resetCount} ${pluralize('reset', point.resetCount)}; ${
            point.firstSampleAt === undefined || point.latestSampleAt === undefined
              ? 'sample times unavailable'
              : formatObservationRange(point.firstSampleAt, point.latestSampleAt)
          }`;
    const ignoredCurrentService =
      point.granularity === 'day' &&
      point.source === 'local' &&
      point.serviceReportedDayCount > 0
        ? `; Codex also reported incomplete ${formatExactTokens(point.serviceAvailableTokens)} tokens; not added`
        : '';
    lines.push(
      `  ${label}: ${formatExactTokens(point.tokens)} joined tokens; ${source}${coverage}${localCoverage}${ignoredCurrentService}${point.state === 'partial' ? '; partial' : ''}`
    );
  }

  const serviceStatistics = rangeUsageStatistics(servicePeriods);
  const localStatistics = localRangeUsageStatistics(localPeriods);
  lines.push(
    '',
    'Service source audit:',
    `  Fetched: ${formatSourceTime(state.sourceFreshness.usageFetchedAt, now)}; ${formatServiceDataThrough(state.sourceFreshness.usageDataThroughDay, now)}`,
    `  Raw reported total: ${formatTokens(serviceStatistics.totalTokens)} tokens across ${serviceStatistics.reportedPeriods} periods`
  );
  const reportedService = servicePeriods.filter(
    (
      point
    ): point is Extract<
      UsagePeriodPoint,
      {state: 'reported' | 'partial'}
    > => point.state === 'reported' || point.state === 'partial'
  );
  if (reportedService.length === 0) {
    lines.push('  No reported service periods in range.');
  } else {
    for (const point of reportedService) {
      lines.push(
        `  ${periodLabel(point)}: ${formatExactTokens(point.tokens)} service tokens${point.state === 'partial' || point.isIncomplete ? '; partial/incomplete' : ''}`
      );
    }
  }

  lines.push(
    '',
    'Local source audit:',
    '  Scope: partial local coverage from each day’s first sample; not service-accounted daily usage',
    ...(state.liveUsage.status === 'disabled'
      ? ['  Sampling: disabled by --no-local; showing persisted history only']
      : []),
    `  Partial observed total: ${formatExactTokens(localStatistics.totalObservedTokens)} tokens across ${localStatistics.observedPeriods} periods`,
    `  Covered days: ${localStatistics.observedDays}/${localStatistics.inRangeDays}`
  );
  const observedLocal = localPeriods.filter(
    (
      point
    ): point is LocalUsagePeriodPoint & {observedTokens: number} =>
      point.observedTokens !== undefined
  );
  if (observedLocal.length === 0) {
    lines.push('  No local observations in range.');
  }
  for (const point of observedLocal) {
    const label = periodLabel(point);
    const coverage =
      point.granularity === 'week'
        ? `; ${point.observedDayCount}/${point.inRangeDayCount} days observed`
        : '';
    const sampleRange =
      point.firstSampleAt === undefined || point.latestSampleAt === undefined
        ? 'sample times unavailable'
        : formatObservationRange(point.firstSampleAt, point.latestSampleAt);
    const incomplete = point.isCurrentPeriod ? '; incomplete' : '';
    lines.push(
      `  ${label}: +${formatExactTokens(point.observedTokens)} observed tokens${coverage}; ` +
      `${point.sampleCount} ${pluralize('sample', point.sampleCount)}; ` +
      `${point.resetCount} ${pluralize('reset', point.resetCount)}; ` +
      `${sampleRange}${incomplete}; partial local`
    );
  }

  lines.push(
    '',
    `Observed ${granularity === 'day' ? 'daily' : 'weekly'} limit changes (partial local history):`
  );
  const changes = observedChangesForRange(state, servicePeriods);
  if (changes.length === 0) {
    lines.push('  No periods have sufficient same-reset local observations.');
  } else {
    for (const change of changes) {
      lines.push(
        `  ${change.periodLabel} · ${change.displayName}: +${formatPoints(change.percentagePoints)} pp ` +
        `(${change.contributingDayCount} contributing ${pluralize('day', change.contributingDayCount)}, ${change.observationCount} observations, ` +
        `${formatObservationRange(change.firstObservedAt, change.lastObservedAt)})`
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function plainLiveUsageLines(
  state: DashboardSnapshot,
  now: Date
): string[] {
  const live = state.liveUsage;
  if (live.status === 'disabled') {
    return ['  State: disabled by --no-local'];
  }
  const observedToday =
    live.todayObservedTokens === undefined ||
    live.todayBaselineAt === undefined ||
    live.todaySampleCount === undefined
      ? undefined
      : `  Observed today: +${formatTokens(live.todayObservedTokens)} tokens since ${formatUtcClock(live.todayBaselineAt)} UTC · ${live.todaySampleCount} ${pluralize('sample', live.todaySampleCount)} · partial local` +
        ((live.todayResetCount ?? 0) === 0
          ? ''
          : ` · ${live.todayResetCount} ${pluralize('reset', live.todayResetCount ?? 0)}`);
  if (live.status === 'unavailable') {
    return [
      ...(observedToday === undefined ? [] : [observedToday]),
      `  State: unavailable${live.sampledAt === undefined ? '' : `; last sample ${formatUpdated(live.sampledAt, now)}`}`,
      ...(live.latestActivityAt === undefined
        ? []
        : [`  Latest local activity: ${formatSourceTime(live.latestActivityAt, now)}`])
    ];
  }
  const lines = [
    ...(observedToday === undefined
      ? ['  Observed today: waiting for today’s first local sample']
      : [observedToday]),
    `  State: ${live.status}`,
    `  Indexed local aggregate: ${formatTokens(live.aggregateTokens ?? 0)} tokens`,
    `  Sampled: ${formatSourceTime(live.sampledAt, now)}`,
    `  Latest local activity: ${formatSourceTime(live.latestActivityAt, now)}`
  ];
  if (live.todayLatestSampleAt !== undefined) {
    lines.push(
      `  Today latest sample: ${formatUtcClock(live.todayLatestSampleAt)} UTC`
    );
  }
  if (live.status === 'reset') {
    lines.push('  Latest sample began a new aggregate segment; prior positive observed usage was preserved');
  }
  return lines;
}

function formatSourceTime(
  value: string | undefined,
  now: Date
): string {
  return value === undefined ? 'unavailable' : formatUpdated(value, now);
}

function formatServiceDataThrough(
  dayKey: string | undefined,
  now: Date
): string {
  if (dayKey === undefined) {
    return 'no bucket reported';
  }
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );
  const through = Date.parse(`${dayKey}T00:00:00.000Z`);
  const lagDays = Number.isNaN(through)
    ? undefined
    : Math.max(0, Math.floor((today - through) / 86_400_000));
  return lagDays === undefined || lagDays === 0
    ? `through ${dayKey}`
    : `through ${dayKey} (${lagDays}d behind today)`;
}

export function plainExitCode(state: DashboardSnapshot): 0 | 1 {
  return state.limits.length > 0 ||
    state.dailyUsage.length > 0 ||
    state.localUsageDays.length > 0
    ? 0
    : 1;
}

function observedChangesForRange(
  state: DashboardSnapshot,
  periods: UsagePeriodPoint[]
): Array<{
  periodLabel: string;
  displayName: string;
  percentagePoints: number;
  observationCount: number;
  contributingDayCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
}> {
  const limits = new Map(
    state.limitHistory.map(entry => [
      entry.limitKey,
      entry.displayName
    ])
  );
  const changes = [];
  for (const period of periods) {
    for (const [limitKey, displayName] of limits) {
      const change = observedPeriodLimitChange(
        state.limitHistory,
        limitKey,
        period
      );
      if (change !== undefined) {
        changes.push({
          ...change,
          periodLabel: periodLabel(period),
          displayName
        });
      }
    }
  }
  return changes;
}

function formatOptionalTokens(value: number | undefined): string {
  return value === undefined ? 'unavailable' : `${formatTokens(value)} tokens`;
}

function formatExactTokens(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: 'standard',
    maximumFractionDigits: 0
  }).format(value);
}

function formatOptionalDays(value: number | undefined): string {
  return value === undefined ? 'unavailable' : `${value}d`;
}

function formatPoints(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function periodLabel(
  point: {startDayKey: string; endDayKey: string}
): string {
  return point.startDayKey === point.endDayKey
    ? point.startDayKey
    : `${point.startDayKey}–${point.endDayKey}`;
}

function formatJoinedExtremum(
  value: JoinedUsagePeriodExtremum | undefined
): string {
  if (value === undefined) {
    return 'unavailable';
  }
  const label =
    value.startDayKey === value.endDayKey
      ? value.startDayKey
      : `${value.startDayKey}–${value.endDayKey}`;
  const marker =
    value.source === 'service'
      ? 'S service'
      : value.source === 'local'
        ? 'L local'
        : value.source === 'mixed'
          ? 'M mixed'
          : 'missing';
  return `${label} (${formatTokens(value.tokens)} tokens; ${marker}${value.isPartial ? '; partial' : ''})`;
}

function formatObservationRange(first: string, last: string): string {
  if (first.slice(0, 10) === last.slice(0, 10)) {
    return `${first.slice(11, 16)}–${last.slice(11, 16)} UTC`;
  }
  return `${first.slice(0, 16).replace('T', ' ')}–${last.slice(0, 16).replace('T', ' ')} UTC`;
}

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

function formatUtcClock(iso: string): string {
  return iso.slice(11, 16);
}
