import type {
  DailyUsageEntry,
  JoinedUsagePeriodPoint,
  JoinedUsageSource,
  LimitHistoryEntry,
  LocalUsageDayObservation,
  LocalUsagePeriodPoint,
  UsageGranularity,
  UsageRange
} from './types.js';

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

type DailyUsagePointBase = {
  dayKey: string;
  isCurrentPeriod: boolean;
  isIncomplete: boolean;
};

export type DailyUsagePoint =
  | (DailyUsagePointBase & {state: 'reported'; tokens: number})
  | (DailyUsagePointBase & {state: 'unreported'})
  | (DailyUsagePointBase & {state: 'pending'});

type UsagePeriodBase = {
  periodKey: string;
  startDayKey: string;
  endDayKey: string;
  includedStartDayKey: string;
  includedEndDayKey: string;
  granularity: UsageGranularity;
  reportedDayCount: number;
  activeDayCount: number;
  inRangeDayCount: number;
  isBoundaryPeriod: boolean;
  isCurrentPeriod: boolean;
  isIncomplete: boolean;
};

export type UsagePeriodPoint =
  | (UsagePeriodBase & {
      state: 'reported' | 'partial';
      tokens: number;
    })
  | (UsagePeriodBase & {
      state: 'unreported' | 'pending';
    });

export type UsagePeriodExtremum = {
  periodKey: string;
  startDayKey: string;
  endDayKey: string;
  tokens: number;
  isPartial: boolean;
};

export type RangeUsageStatistics = {
  totalTokens: number;
  reportedPeriods: number;
  activePeriods: number;
  averagePerReportedPeriod: number | undefined;
  averagePerActivePeriod: number | undefined;
  minimum: UsagePeriodExtremum | undefined;
  maximum: UsagePeriodExtremum | undefined;
};

export type LocalUsagePeriodExtremum = {
  periodKey: string;
  startDayKey: string;
  endDayKey: string;
  observedTokens: number;
  isPartial: boolean;
};

export type LocalRangeUsageStatistics = {
  totalObservedTokens: number;
  observedPeriods: number;
  activePeriods: number;
  observedDays: number;
  inRangeDays: number;
  averagePerObservedPeriod: number | undefined;
  averagePerActivePeriod: number | undefined;
  minimum: LocalUsagePeriodExtremum | undefined;
  maximum: LocalUsagePeriodExtremum | undefined;
};

export type JoinedUsagePeriodExtremum = {
  periodKey: string;
  startDayKey: string;
  endDayKey: string;
  tokens: number;
  source: JoinedUsageSource;
  isPartial: boolean;
};

export type JoinedRangeUsageStatistics = {
  totalTokens: number;
  valuedPeriods: number;
  activePeriods: number;
  serviceDays: number;
  localDays: number;
  missingDays: number;
  inRangeDays: number;
  averagePerValuedPeriod: number | undefined;
  averagePerActivePeriod: number | undefined;
  minimum: JoinedUsagePeriodExtremum | undefined;
  maximum: JoinedUsagePeriodExtremum | undefined;
};

export type ObservedDailyLimitChange = {
  limitKey: string;
  dayKey: string;
  percentagePoints: number;
  observationCount: number;
  segmentCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
};

export type ObservedPeriodLimitChange = {
  limitKey: string;
  granularity: UsageGranularity;
  startDayKey: string;
  endDayKey: string;
  percentagePoints: number;
  observationCount: number;
  segmentCount: number;
  contributingDayCount: number;
  firstObservedAt: string;
  lastObservedAt: string;
};

export function dailyUsagePoints(
  entries: DailyUsageEntry[],
  range: UsageRange,
  now: Date = new Date()
): DailyUsagePoint[] {
  const byDay = new Map(entries.map(entry => [entry.dayKey, entry.tokens]));
  const latestReportedDay = entries
    .map(entry => entry.dayKey)
    .sort()
    .at(-1);
  const currentDayKey = now.toISOString().slice(0, 10);
  const end = new Date(`${currentDayKey}T00:00:00.000Z`);
  const points: DailyUsagePoint[] = [];

  for (let offset = range - 1; offset >= 0; offset--) {
    const day = new Date(end);
    day.setUTCDate(day.getUTCDate() - offset);
    const dayKey = day.toISOString().slice(0, 10);
    const tokens = byDay.get(dayKey);
    const currentMetadata = {
      isCurrentPeriod: dayKey === currentDayKey,
      isIncomplete: dayKey === currentDayKey
    };
    if (tokens !== undefined) {
      points.push({dayKey, state: 'reported', tokens, ...currentMetadata});
    } else if (latestReportedDay === undefined || dayKey > latestReportedDay) {
      points.push({dayKey, state: 'pending', ...currentMetadata});
    } else {
      points.push({dayKey, state: 'unreported', ...currentMetadata});
    }
  }
  return points;
}

export function usagePeriodPoints(
  entries: DailyUsageEntry[],
  range: UsageRange,
  granularity: UsageGranularity,
  now: Date = new Date()
): UsagePeriodPoint[] {
  const daily = dailyUsagePoints(entries, range, now);
  if (granularity === 'day') {
    return daily.map(point => dailyPeriod(point));
  }
  return weeklyPeriods(daily);
}

export function rangeUsageStatistics(
  points: UsagePeriodPoint[]
): RangeUsageStatistics {
  const reported = points.filter(hasReportedTokens);
  const active = reported.filter(point => point.tokens > 0);
  const totalTokens = reported.reduce((sum, point) => sum + point.tokens, 0);
  let minimum: UsagePeriodExtremum | undefined;
  let maximum: UsagePeriodExtremum | undefined;

  for (const point of reported) {
    const candidate = extremum(point);
    if (
      minimum === undefined ||
      candidate.tokens < minimum.tokens ||
      (candidate.tokens === minimum.tokens &&
        candidate.periodKey > minimum.periodKey)
    ) {
      minimum = candidate;
    }
    if (
      maximum === undefined ||
      candidate.tokens > maximum.tokens ||
      (candidate.tokens === maximum.tokens &&
        candidate.periodKey > maximum.periodKey)
    ) {
      maximum = candidate;
    }
  }

  return {
    totalTokens,
    reportedPeriods: reported.length,
    activePeriods: active.length,
    averagePerReportedPeriod:
      reported.length === 0 ? undefined : totalTokens / reported.length,
    averagePerActivePeriod:
      active.length === 0 ? undefined : totalTokens / active.length,
    minimum,
    maximum
  };
}

export function localUsagePeriodPoints(
  observations: LocalUsageDayObservation[],
  range: UsageRange,
  granularity: UsageGranularity,
  now: Date = new Date()
): LocalUsagePeriodPoint[] {
  const byDay = new Map(
    observations.map(observation => [observation.dayKey, observation])
  );
  const currentDayKey = now.toISOString().slice(0, 10);
  const end = new Date(`${currentDayKey}T00:00:00.000Z`);
  const daily: LocalUsagePeriodPoint[] = [];

  for (let offset = range - 1; offset >= 0; offset--) {
    const day = new Date(end);
    day.setUTCDate(day.getUTCDate() - offset);
    const dayKey = day.toISOString().slice(0, 10);
    const observation = byDay.get(dayKey);
    daily.push({
      periodKey: dayKey,
      startDayKey: dayKey,
      endDayKey: dayKey,
      granularity: 'day',
      ...(observation === undefined
        ? {}
        : {
            observedTokens: observation.observedIncreaseTokens,
            firstSampleAt: observation.baselineSampledAt,
            latestSampleAt: observation.latestSampledAt
          }),
      observedDayCount: observation === undefined ? 0 : 1,
      inRangeDayCount: 1,
      sampleCount: observation?.sampleCount ?? 0,
      resetCount: observation?.resetCount ?? 0,
      isCurrentPeriod: dayKey === currentDayKey,
      isBoundaryPeriod: false
    });
  }

  return granularity === 'day' ? daily : weeklyLocalPeriods(daily);
}

export function localRangeUsageStatistics(
  points: LocalUsagePeriodPoint[]
): LocalRangeUsageStatistics {
  const observed = points.filter(
    (
      point
    ): point is LocalUsagePeriodPoint & {observedTokens: number} =>
      point.observedTokens !== undefined
  );
  const active = observed.filter(point => point.observedTokens > 0);
  const totalObservedTokens = observed.reduce(
    (sum, point) => sum + point.observedTokens,
    0
  );
  let minimum: LocalUsagePeriodExtremum | undefined;
  let maximum: LocalUsagePeriodExtremum | undefined;

  for (const point of observed) {
    const candidate = localExtremum(point);
    if (
      minimum === undefined ||
      candidate.observedTokens < minimum.observedTokens ||
      (candidate.observedTokens === minimum.observedTokens &&
        candidate.periodKey > minimum.periodKey)
    ) {
      minimum = candidate;
    }
    if (
      maximum === undefined ||
      candidate.observedTokens > maximum.observedTokens ||
      (candidate.observedTokens === maximum.observedTokens &&
        candidate.periodKey > maximum.periodKey)
    ) {
      maximum = candidate;
    }
  }

  return {
    totalObservedTokens,
    observedPeriods: observed.length,
    activePeriods: active.length,
    observedDays: points.reduce(
      (sum, point) => sum + point.observedDayCount,
      0
    ),
    inRangeDays: points.reduce((sum, point) => sum + point.inRangeDayCount, 0),
    averagePerObservedPeriod:
      observed.length === 0
        ? undefined
        : totalObservedTokens / observed.length,
    averagePerActivePeriod:
      active.length === 0 ? undefined : totalObservedTokens / active.length,
    minimum,
    maximum
  };
}

export function joinedUsagePeriodPoints(
  entries: DailyUsageEntry[],
  observations: LocalUsageDayObservation[],
  range: UsageRange,
  granularity: UsageGranularity,
  now: Date = new Date()
): JoinedUsagePeriodPoint[] {
  const localByDay = new Map(
    observations.map(observation => [observation.dayKey, observation])
  );
  const daily: JoinedUsagePeriodPoint[] = dailyUsagePoints(
    entries,
    range,
    now
  ).map(servicePoint => {
    const local = localByDay.get(servicePoint.dayKey);
    const serviceReported = servicePoint.state === 'reported';
    const useLocal =
      local !== undefined &&
      (servicePoint.isCurrentPeriod || !serviceReported);
    const useService = serviceReported && !useLocal;
    const source: JoinedUsageSource = useLocal
      ? 'local'
      : useService
        ? 'service'
        : 'missing';
    const tokens = useLocal
      ? local.observedIncreaseTokens
      : serviceReported
        ? servicePoint.tokens
        : undefined;
    const state: JoinedUsagePeriodPoint['state'] =
      tokens === undefined
        ? servicePoint.state === 'pending'
          ? 'pending'
          : 'unreported'
        : source === 'local' || servicePoint.isIncomplete
          ? 'partial'
          : 'complete';
    return {
      periodKey: servicePoint.dayKey,
      startDayKey: servicePoint.dayKey,
      endDayKey: servicePoint.dayKey,
      includedStartDayKey: servicePoint.dayKey,
      includedEndDayKey: servicePoint.dayKey,
      granularity: 'day' as const,
      state,
      source,
      tokens,
      serviceContributionTokens:
        useService && serviceReported ? servicePoint.tokens : 0,
      localContributionTokens:
        useLocal && local !== undefined ? local.observedIncreaseTokens : 0,
      serviceAvailableTokens: serviceReported ? servicePoint.tokens : 0,
      serviceReportedDayCount: serviceReported ? 1 : 0,
      serviceDayCount: useService ? 1 : 0,
      localDayCount: useLocal ? 1 : 0,
      missingDayCount: tokens === undefined ? 1 : 0,
      activeDayCount: tokens !== undefined && tokens > 0 ? 1 : 0,
      inRangeDayCount: 1,
      sampleCount: useLocal && local !== undefined ? local.sampleCount : 0,
      resetCount: useLocal && local !== undefined ? local.resetCount : 0,
      firstSampleAt:
        useLocal && local !== undefined ? local.baselineSampledAt : undefined,
      latestSampleAt:
        useLocal && local !== undefined ? local.latestSampledAt : undefined,
      isCurrentPeriod: servicePoint.isCurrentPeriod,
      isBoundaryPeriod: false,
      isIncomplete: servicePoint.isIncomplete
    };
  });

  return granularity === 'day' ? daily : weeklyJoinedPeriods(daily);
}

export function joinedRangeUsageStatistics(
  points: JoinedUsagePeriodPoint[]
): JoinedRangeUsageStatistics {
  const valued = points.filter(hasJoinedTokens);
  const active = valued.filter(point => point.tokens > 0);
  const totalTokens = valued.reduce((sum, point) => sum + point.tokens, 0);
  let minimum: JoinedUsagePeriodExtremum | undefined;
  let maximum: JoinedUsagePeriodExtremum | undefined;

  for (const point of valued) {
    const candidate = joinedExtremum(point);
    if (
      minimum === undefined ||
      candidate.tokens < minimum.tokens ||
      (candidate.tokens === minimum.tokens &&
        candidate.periodKey > minimum.periodKey)
    ) {
      minimum = candidate;
    }
    if (
      maximum === undefined ||
      candidate.tokens > maximum.tokens ||
      (candidate.tokens === maximum.tokens &&
        candidate.periodKey > maximum.periodKey)
    ) {
      maximum = candidate;
    }
  }

  return {
    totalTokens,
    valuedPeriods: valued.length,
    activePeriods: active.length,
    serviceDays: points.reduce(
      (sum, point) => sum + point.serviceDayCount,
      0
    ),
    localDays: points.reduce((sum, point) => sum + point.localDayCount, 0),
    missingDays: points.reduce(
      (sum, point) => sum + point.missingDayCount,
      0
    ),
    inRangeDays: points.reduce((sum, point) => sum + point.inRangeDayCount, 0),
    averagePerValuedPeriod:
      valued.length === 0 ? undefined : totalTokens / valued.length,
    averagePerActivePeriod:
      active.length === 0 ? undefined : totalTokens / active.length,
    minimum,
    maximum
  };
}

export function observedDailyLimitChange(
  entries: LimitHistoryEntry[],
  limitKey: string,
  dayKey: string
): ObservedDailyLimitChange | undefined {
  const observations = entries
    .filter(
      entry =>
        entry.limitKey === limitKey &&
        entry.observedAt.slice(0, 10) === dayKey
    )
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
  if (observations.length < 2) {
    return undefined;
  }

  const byReset = new Map<string, LimitHistoryEntry[]>();
  for (const observation of observations) {
    const resetKey = observation.resetsAt ?? 'unknown';
    const segment = byReset.get(resetKey) ?? [];
    segment.push(observation);
    byReset.set(resetKey, segment);
  }

  let percentagePoints = 0;
  let segmentCount = 0;
  for (const segment of byReset.values()) {
    const first = segment.at(0);
    const last = segment.at(-1);
    if (first === undefined || last === undefined || segment.length < 2) {
      continue;
    }
    percentagePoints += Math.max(
      0,
      first.remainingPercent - last.remainingPercent
    );
    segmentCount++;
  }
  if (segmentCount === 0) {
    return undefined;
  }
  const firstObservation = observations[0];
  const lastObservation = observations.at(-1);
  if (firstObservation === undefined || lastObservation === undefined) {
    return undefined;
  }

  return {
    limitKey,
    dayKey,
    percentagePoints,
    observationCount: observations.length,
    segmentCount,
    firstObservedAt: firstObservation.observedAt,
    lastObservedAt: lastObservation.observedAt
  };
}

export function observedPeriodLimitChange(
  entries: LimitHistoryEntry[],
  limitKey: string,
  point: Pick<
    UsagePeriodPoint | JoinedUsagePeriodPoint,
    'granularity' | 'includedStartDayKey' | 'includedEndDayKey'
  >
): ObservedPeriodLimitChange | undefined {
  const changes = dayKeysBetween(
    point.includedStartDayKey,
    point.includedEndDayKey
  )
    .map(dayKey => observedDailyLimitChange(entries, limitKey, dayKey))
    .filter(
      (change): change is ObservedDailyLimitChange => change !== undefined
    );
  if (changes.length === 0) {
    return undefined;
  }
  const first = changes
    .map(change => change.firstObservedAt)
    .sort()
    .at(0);
  const last = changes
    .map(change => change.lastObservedAt)
    .sort()
    .at(-1);
  if (first === undefined || last === undefined) {
    return undefined;
  }
  return {
    limitKey,
    granularity: point.granularity,
    startDayKey: point.includedStartDayKey,
    endDayKey: point.includedEndDayKey,
    percentagePoints: changes.reduce(
      (sum, change) => sum + change.percentagePoints,
      0
    ),
    observationCount: changes.reduce(
      (sum, change) => sum + change.observationCount,
      0
    ),
    segmentCount: changes.reduce(
      (sum, change) => sum + change.segmentCount,
      0
    ),
    contributingDayCount: changes.length,
    firstObservedAt: first,
    lastObservedAt: last
  };
}

function dailyPeriod(point: DailyUsagePoint): UsagePeriodPoint {
  const base: UsagePeriodBase = {
    periodKey: point.dayKey,
    startDayKey: point.dayKey,
    endDayKey: point.dayKey,
    includedStartDayKey: point.dayKey,
    includedEndDayKey: point.dayKey,
    granularity: 'day',
    reportedDayCount: point.state === 'reported' ? 1 : 0,
    activeDayCount:
      point.state === 'reported' && point.tokens > 0 ? 1 : 0,
    inRangeDayCount: 1,
    isBoundaryPeriod: false,
    isCurrentPeriod: point.isCurrentPeriod,
    isIncomplete: point.isIncomplete
  };
  if (point.state === 'reported') {
    return {...base, state: 'reported', tokens: point.tokens};
  }
  return {...base, state: point.state};
}

function weeklyPeriods(daily: DailyUsagePoint[]): UsagePeriodPoint[] {
  const groups = new Map<string, DailyUsagePoint[]>();
  for (const point of daily) {
    const weekStart = mondayFor(point.dayKey);
    const group = groups.get(weekStart) ?? [];
    group.push(point);
    groups.set(weekStart, group);
  }

  return [...groups.entries()].map(([weekStart, points]) => {
    const weekEnd = addDays(weekStart, 6);
    const first = points.at(0);
    const last = points.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error('Weekly aggregation requires at least one daily point.');
    }
    const reported = points.filter(
      (point): point is Extract<DailyUsagePoint, {state: 'reported'}> =>
        point.state === 'reported'
    );
    const tokens = reported.reduce((sum, point) => sum + point.tokens, 0);
    const isCurrentPeriod = points.some(point => point.isCurrentPeriod);
    const base: UsagePeriodBase = {
      periodKey: weekStart,
      startDayKey: weekStart,
      endDayKey: weekEnd,
      includedStartDayKey: first.dayKey,
      includedEndDayKey: last.dayKey,
      granularity: 'week',
      reportedDayCount: reported.length,
      activeDayCount: reported.filter(point => point.tokens > 0).length,
      inRangeDayCount: points.length,
      isBoundaryPeriod:
        first.dayKey !== weekStart || last.dayKey !== weekEnd,
      isCurrentPeriod,
      isIncomplete: isCurrentPeriod
    };
    if (reported.length > 0) {
      return {
        ...base,
        state: reported.length === points.length ? 'reported' : 'partial',
        tokens
      };
    }
    return {
      ...base,
      state: points.every(point => point.state === 'pending')
        ? 'pending'
        : 'unreported'
    };
  });
}

function weeklyLocalPeriods(
  daily: LocalUsagePeriodPoint[]
): LocalUsagePeriodPoint[] {
  const groups = new Map<string, LocalUsagePeriodPoint[]>();
  for (const point of daily) {
    const weekStart = mondayFor(point.startDayKey);
    const group = groups.get(weekStart) ?? [];
    group.push(point);
    groups.set(weekStart, group);
  }

  return [...groups.entries()].map(([weekStart, points]) => {
    const first = points.at(0);
    const last = points.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error('Weekly local aggregation requires a daily point.');
    }
    const observed = points.filter(
      (
        point
      ): point is LocalUsagePeriodPoint & {observedTokens: number} =>
        point.observedTokens !== undefined
    );
    const firstSampleAt = observed
      .flatMap(point =>
        point.firstSampleAt === undefined ? [] : [point.firstSampleAt]
      )
      .sort()
      .at(0);
    const latestSampleAt = observed
      .flatMap(point =>
        point.latestSampleAt === undefined ? [] : [point.latestSampleAt]
      )
      .sort()
      .at(-1);
    return {
      periodKey: weekStart,
      startDayKey: weekStart,
      endDayKey: addDays(weekStart, 6),
      granularity: 'week',
      ...(observed.length === 0
        ? {}
        : {
            observedTokens: observed.reduce(
              (sum, point) => sum + point.observedTokens,
              0
            )
          }),
      ...(firstSampleAt === undefined ? {} : {firstSampleAt}),
      ...(latestSampleAt === undefined ? {} : {latestSampleAt}),
      observedDayCount: observed.length,
      inRangeDayCount: points.length,
      sampleCount: points.reduce((sum, point) => sum + point.sampleCount, 0),
      resetCount: points.reduce((sum, point) => sum + point.resetCount, 0),
      isCurrentPeriod: points.some(point => point.isCurrentPeriod),
      isBoundaryPeriod:
        first.startDayKey !== weekStart ||
        last.endDayKey !== addDays(weekStart, 6)
    };
  });
}

function weeklyJoinedPeriods(
  daily: JoinedUsagePeriodPoint[]
): JoinedUsagePeriodPoint[] {
  const groups = new Map<string, JoinedUsagePeriodPoint[]>();
  for (const point of daily) {
    const weekStart = mondayFor(point.startDayKey);
    const group = groups.get(weekStart) ?? [];
    group.push(point);
    groups.set(weekStart, group);
  }

  return [...groups.entries()].map(([weekStart, points]) => {
    const first = points.at(0);
    const last = points.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error('Weekly joined aggregation requires a daily point.');
    }
    const valued = points.filter(hasJoinedTokens);
    const serviceDayCount = points.reduce(
      (sum, point) => sum + point.serviceDayCount,
      0
    );
    const localDayCount = points.reduce(
      (sum, point) => sum + point.localDayCount,
      0
    );
    const missingDayCount = points.reduce(
      (sum, point) => sum + point.missingDayCount,
      0
    );
    const source: JoinedUsageSource =
      serviceDayCount > 0 && localDayCount > 0
        ? 'mixed'
        : serviceDayCount > 0
          ? 'service'
          : localDayCount > 0
            ? 'local'
            : 'missing';
    const firstSampleAt = points
      .flatMap(point =>
        point.firstSampleAt === undefined ? [] : [point.firstSampleAt]
      )
      .sort()
      .at(0);
    const latestSampleAt = points
      .flatMap(point =>
        point.latestSampleAt === undefined ? [] : [point.latestSampleAt]
      )
      .sort()
      .at(-1);
    const weekEnd = addDays(weekStart, 6);
    const isBoundaryPeriod =
      first.startDayKey !== weekStart || last.endDayKey !== weekEnd;
    const isCurrentPeriod = points.some(point => point.isCurrentPeriod);
    const tokens =
      valued.length === 0
        ? undefined
        : valued.reduce((sum, point) => sum + point.tokens, 0);
    const state =
      tokens === undefined
        ? points.every(point => point.state === 'pending')
          ? 'pending'
          : 'unreported'
        : localDayCount > 0 ||
            missingDayCount > 0 ||
            isBoundaryPeriod ||
            isCurrentPeriod
          ? 'partial'
          : 'complete';
    return {
      periodKey: weekStart,
      startDayKey: weekStart,
      endDayKey: weekEnd,
      includedStartDayKey: first.startDayKey,
      includedEndDayKey: last.endDayKey,
      granularity: 'week',
      state,
      source,
      tokens,
      serviceContributionTokens: points.reduce(
        (sum, point) => sum + point.serviceContributionTokens,
        0
      ),
      localContributionTokens: points.reduce(
        (sum, point) => sum + point.localContributionTokens,
        0
      ),
      serviceAvailableTokens: points.reduce(
        (sum, point) => sum + point.serviceAvailableTokens,
        0
      ),
      serviceReportedDayCount: points.reduce(
        (sum, point) => sum + point.serviceReportedDayCount,
        0
      ),
      serviceDayCount,
      localDayCount,
      missingDayCount,
      activeDayCount: points.reduce(
        (sum, point) => sum + point.activeDayCount,
        0
      ),
      inRangeDayCount: points.length,
      sampleCount: points.reduce((sum, point) => sum + point.sampleCount, 0),
      resetCount: points.reduce((sum, point) => sum + point.resetCount, 0),
      firstSampleAt,
      latestSampleAt,
      isCurrentPeriod,
      isBoundaryPeriod,
      isIncomplete: isCurrentPeriod
    };
  });
}

function hasReportedTokens(
  point: UsagePeriodPoint
): point is Extract<UsagePeriodPoint, {state: 'reported' | 'partial'}> {
  return point.state === 'reported' || point.state === 'partial';
}

function hasJoinedTokens(
  point: JoinedUsagePeriodPoint
): point is JoinedUsagePeriodPoint & {tokens: number} {
  return point.tokens !== undefined;
}

function extremum(
  point: Extract<UsagePeriodPoint, {state: 'reported' | 'partial'}>
): UsagePeriodExtremum {
  return {
    periodKey: point.periodKey,
    startDayKey: point.startDayKey,
    endDayKey: point.endDayKey,
    tokens: point.tokens,
    isPartial:
      point.state === 'partial' ||
      point.isBoundaryPeriod ||
      point.isIncomplete
  };
}

function joinedExtremum(
  point: JoinedUsagePeriodPoint & {tokens: number}
): JoinedUsagePeriodExtremum {
  return {
    periodKey: point.periodKey,
    startDayKey: point.startDayKey,
    endDayKey: point.endDayKey,
    tokens: point.tokens,
    source: point.source,
    isPartial: point.state === 'partial'
  };
}

function localExtremum(
  point: LocalUsagePeriodPoint & {observedTokens: number}
): LocalUsagePeriodExtremum {
  return {
    periodKey: point.periodKey,
    startDayKey: point.startDayKey,
    endDayKey: point.endDayKey,
    observedTokens: point.observedTokens,
    isPartial:
      point.isBoundaryPeriod ||
      point.isCurrentPeriod ||
      point.observedDayCount < point.inRangeDayCount
  };
}

function mondayFor(dayKey: string): string {
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

function addDays(dayKey: string, count: number): string {
  const timestamp = Date.parse(`${dayKey}T00:00:00.000Z`);
  return new Date(timestamp + count * DAY_MILLISECONDS)
    .toISOString()
    .slice(0, 10);
}

function dayKeysBetween(startDayKey: string, endDayKey: string): string[] {
  const keys: string[] = [];
  for (
    let timestamp = Date.parse(`${startDayKey}T00:00:00.000Z`);
    timestamp <= Date.parse(`${endDayKey}T00:00:00.000Z`);
    timestamp += DAY_MILLISECONDS
  ) {
    keys.push(new Date(timestamp).toISOString().slice(0, 10));
  }
  return keys;
}
