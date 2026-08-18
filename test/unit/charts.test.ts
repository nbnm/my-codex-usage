import {describe, expect, it} from 'vitest';
import {plainExitCode, renderPlain} from '../../src/plain/render.js';
import {
  dailyUsagePoints,
  joinedRangeUsageStatistics,
  joinedUsagePeriodPoints,
  localRangeUsageStatistics,
  localUsagePeriodPoints,
  observedDailyLimitChange,
  observedPeriodLimitChange,
  rangeUsageStatistics,
  usagePeriodPoints,
  type UsagePeriodPoint
} from '../../src/domain/usage.js';
import {
  bandGlyph,
  calculatePlotHeight,
  joinedUsagePeriodPlot,
  limitHistoryPlot,
  plotRowText,
  progressBar,
  usageBand,
  usagePeriodPlot
} from '../../src/tui/charts.js';
import type {
  DashboardSnapshot,
  DailyUsageEntry,
  LimitHistoryEntry,
  LocalUsageDayObservation,
  UsageRange
} from '../../src/domain/types.js';

describe('terminal plot geometry', () => {
  it('calculates responsive heights for baseline, wide, short, and compact terminals', () => {
    expect(calculatePlotHeight(24, 1)).toBe(6);
    expect(calculatePlotHeight(40, 1)).toBe(16);
    expect(calculatePlotHeight(20, 1)).toBe(6);
    expect(calculatePlotHeight(16, 1)).toBe(5);
    expect(calculatePlotHeight(12, 1)).toBe(0);
    expect(calculatePlotHeight(24, 3)).toBe(4);
  });

  it('renders one full-height joined plot with source provenance', () => {
    const now = new Date('2026-04-30T12:00:00.000Z');
    const points = joinedUsagePeriodPoints(
      entries([['2026-04-24', 1_000]]),
      [
        {
          dayKey: '2026-04-29',
          baselineAggregateTokens: 10,
          baselineSampledAt: '2026-04-29T00:00:00.000Z',
          latestAggregateTokens: 110,
          latestSampledAt: '2026-04-29T01:00:00.000Z',
          observedIncreaseTokens: 100,
          sampleCount: 2,
          resetCount: 0
        },
        {
          dayKey: '2026-04-30',
          baselineAggregateTokens: 110,
          baselineSampledAt: '2026-04-30T00:00:00.000Z',
          latestAggregateTokens: 360,
          latestSampledAt: '2026-04-30T01:00:00.000Z',
          observedIncreaseTokens: 250,
          sampleCount: 2,
          resetCount: 0
        }
      ],
      7,
      'day',
      now
    );
    const plot = joinedUsagePeriodPlot(points, 6, 7, 100, 8);
    const sourceGuide = plotRowText(plot.rows.at(-3)!);

    expect(plot.rangeMaximum).toBe(1_000);
    expect(plot.rows.every(row => plotRowText(row).length === 100)).toBe(true);
    expect(sourceGuide).toContain('S');
    expect(sourceGuide.match(/L/gu)).toHaveLength(2);
    expect(sourceGuide).toContain('?');
    const tones = new Set(
      plot.rows.flatMap(row => row.segments.map(segment => segment.tone))
    );
    expect(tones).toContain('service');
    expect(tones).toContain('local');
  });

  it('renders fixed-width progress and exact band boundaries', () => {
    expect(progressBar(50, 10)).toBe('█████░░░░░');
    expect(progressBar(200, 4)).toBe('████');
    expect(usageBand(0)).toBe('low');
    expect(usageBand(0.5)).toBe('low');
    expect(usageBand(0.5001)).toBe('medium');
    expect(usageBand(0.75)).toBe('medium');
    expect(usageBand(0.7501)).toBe('high');
    expect(bandGlyph('low')).toBe('░');
    expect(bandGlyph('medium')).toBe('▒');
    expect(bandGlyph('high')).toBe('█');
  });

  it.each([7, 30] as const)(
    'distributes every %i-day point with identical bars across the complete plot width',
    range => {
      const points = reportedPeriods(range);
      const plot = usagePeriodPlot(points, range - 1, range, 74, 6);
      expect(plot.viewportStart).toBe(0);
      expect(plot.viewportEnd).toBe(range);
      expect(plot.rows.every(row => plotRowText(row).length === 74)).toBe(true);
      expect(plot.plotWidth / 74).toBeGreaterThan(0.9);
      const bottomBars =
        plotRowText(plot.rows[5]!).match(/[░▒█]+/gu) ?? [];
      expect(bottomBars).toHaveLength(range);
      expect(new Set(bottomBars.map(bar => bar.length))).toEqual(
        new Set([plot.barWidth])
      );
      const axis = plotRowText(plot.rows.at(-1)!);
      expect(axis).toContain(range === 7 ? 'Wed 1' : 'Apr');
      expect(axis).toContain(range === 7 ? 'Tue 7' : 'Apr 30');
    }
  );

  it('centers and clamps a two-column 180-day viewport while preserving scale', () => {
    const points = reportedPeriods(180);
    const firstPoint = points[0];
    if (
      firstPoint === undefined ||
      (firstPoint.state !== 'reported' && firstPoint.state !== 'partial')
    ) {
      throw new Error('Expected a reported first point.');
    }
    points[0] = {...firstPoint, tokens: 180_000};
    const middle = usagePeriodPlot(points, 90, 180, 74, 8);
    const start = usagePeriodPlot(points, 0, 180, 74, 8);
    const end = usagePeriodPlot(points, 179, 180, 74, 8);

    expect(middle.viewportStart).toBeGreaterThan(0);
    expect(middle.viewportStart).toBeLessThan(90);
    expect(middle.viewportEnd).toBeGreaterThan(90);
    expect(middle.viewportEnd - middle.viewportStart).toBeLessThanOrEqual(
      Math.floor(middle.plotWidth / 2)
    );
    expect(start.viewportStart).toBe(0);
    expect(start.hasEarlier).toBe(false);
    expect(start.hasLater).toBe(true);
    expect(end.viewportEnd).toBe(180);
    expect(end.hasEarlier).toBe(true);
    expect(end.hasLater).toBe(false);
    expect(middle.rangeMaximum).toBe(180_000);
    expect(start.rangeMaximum).toBe(180_000);
    expect(end.rangeMaximum).toBe(180_000);
    const middleBars =
      plotRowText(middle.rows[7]!).match(/[░▒█]+/gu) ?? [];
    expect(new Set(middleBars.map(bar => bar.length))).toEqual(
      new Set([middle.barWidth])
    );
  });

  it('shows axes, selection, missing states, and partial weeks without color', () => {
    const points: UsagePeriodPoint[] = [
      reportedPeriod('2026-07-20', 1_000),
      unavailablePeriod('2026-07-21', 'unreported'),
      unavailablePeriod('2026-07-22', 'pending'),
      {
        ...reportedPeriod('2026-07-23', 500),
        tokens: 500,
        state: 'partial',
        granularity: 'week',
        startDayKey: '2026-07-20',
        endDayKey: '2026-07-26',
        includedEndDayKey: '2026-07-23',
        reportedDayCount: 1,
        inRangeDayCount: 4,
        isBoundaryPeriod: true
      }
    ];
    const plot = usagePeriodPlot(points, 0, 30, 60, 6);
    const text = plot.rows.map(plotRowText).join('\n');
    expect(text).toContain('1k');
    expect(text).toContain('500');
    expect(text).toContain('0 └');
    expect(text).toContain('^');
    expect(text).toContain('·');
    expect(text).toContain('?');
    expect(text).toContain('~');
    expect(text).toContain('░');
    expect(text).toContain('▒');
    expect(text).toContain('█');
    const tones = new Set(
      plot.rows.flatMap(row => row.segments.map(item => item.tone))
    );
    expect(tones).toEqual(
      new Set(['axis', 'high', 'medium', 'low', 'muted', 'selected'])
    );
  });

  it('maps history over fixed time, leaves gaps, and resolves collisions to maximum used', () => {
    const now = new Date('2026-07-24T12:00:00.000Z');
    const entries: LimitHistoryEntry[] = [
      observation(
        '12:00',
        90,
        '2026-07-25T12:00:00.000Z',
        '2026-07-20T12:00:00.000Z'
      ),
      observation(
        '12:00',
        60,
        '2026-07-25T12:00:00.000Z',
        '2026-07-24T00:00:00.000Z'
      ),
      observation(
        '12:00',
        0,
        '2026-07-25T12:00:00.000Z',
        '2026-07-24T00:00:00.000Z'
      )
    ];
    const plot = limitHistoryPlot(entries, 2, 7, 74, 8, now);
    const top = plotRowText(plot.rows[0]!);
    const lowBand = plotRowText(plot.rows[7]!);

    expect(plot.rows.every(row => plotRowText(row).length === 74)).toBe(true);
    expect(plot.plotWidth / 74).toBeGreaterThan(0.9);
    expect(top).toContain('100%');
    expect(top[plot.selectedColumn! + 6]).toBe('█');
    expect(lowBand.match(/[░▒█]/gu)?.length).toBe(2);
    expect(plotRowText(plot.rows.at(-3)!)).toContain('^');
    expect(plotRowText(plot.rows.at(-2)!)).toContain('W');
    expect(plotRowText(plot.rows.at(-1)!)).toContain('Jul 17');
    expect(plotRowText(plot.rows.at(-1)!)).toContain('Jul 24');
  });

  it('labels a seven-day UTC calendar and marks weekend cells', () => {
    const points = usagePeriodPoints(
      entries([
        ['2026-07-20', 1],
        ['2026-07-21', 2],
        ['2026-07-22', 3],
        ['2026-07-23', 4],
        ['2026-07-24', 5],
        ['2026-07-25', 6],
        ['2026-07-26', 7]
      ]),
      7,
      'day',
      new Date('2026-07-26T12:00:00Z')
    );
    const plot = usagePeriodPlot(points, 4, 7, 100, 6);
    const weekend = plotRowText(plot.rows.at(-2)!);
    const axis = plotRowText(plot.rows.at(-1)!);

    expect(weekend.match(/W/gu)).toHaveLength(2);
    expect(axis).toContain('Mon 20');
    expect(axis).toContain('Tue 21');
    expect(axis).toContain('Sun 26');
    expect(axis.length).toBe(100);
  });
});

describe('usage interpretation', () => {
  it('distinguishes reported, unreported, and pending daily points', () => {
    const points = dailyUsagePoints(
      [
        {
          dayKey: '2026-07-22',
          tokens: 10,
          fetchedAt: '2026-07-24T12:00:00.000Z'
        }
      ],
      7,
      new Date('2026-07-24T12:00:00Z')
    );
    expect(points.map(point => point.state)).toEqual([
      'unreported',
      'unreported',
      'unreported',
      'unreported',
      'reported',
      'pending',
      'pending'
    ]);
    expect(points.slice(0, -1).every(point => !point.isCurrentPeriod)).toBe(
      true
    );
    expect(points.at(-1)).toMatchObject({
      dayKey: '2026-07-24',
      state: 'pending',
      isCurrentPeriod: true,
      isIncomplete: true
    });
  });

  it('keeps a reported current day exact but incomplete and re-evaluates after midnight', () => {
    const entriesForToday = entries([['2026-07-24', 456]]);
    const beforeMidnight = usagePeriodPoints(
      entriesForToday,
      7,
      'day',
      new Date('2026-07-24T23:59:59Z')
    );
    expect(beforeMidnight.at(-1)).toMatchObject({
      state: 'reported',
      tokens: 456,
      isCurrentPeriod: true,
      isIncomplete: true
    });

    const afterMidnight = usagePeriodPoints(
      entriesForToday,
      7,
      'day',
      new Date('2026-07-25T00:00:01Z')
    );
    expect(afterMidnight.at(-2)).toMatchObject({
      periodKey: '2026-07-24',
      state: 'reported',
      isCurrentPeriod: false,
      isIncomplete: false
    });
    expect(afterMidnight.at(-1)).toMatchObject({
      periodKey: '2026-07-25',
      state: 'pending',
      isCurrentPeriod: true,
      isIncomplete: true
    });
  });

  it('groups Monday-Sunday UTC weeks across month and year boundaries', () => {
    const monthPoints = usagePeriodPoints(
      entries([
        ['2026-07-02', 0],
        ['2026-07-03', 100],
        ['2026-07-06', 300],
        ['2026-07-07', 400]
      ]),
      7,
      'week',
      new Date('2026-07-08T12:00:00Z')
    );
    expect(monthPoints).toHaveLength(2);
    expect(monthPoints[0]).toMatchObject({
      startDayKey: '2026-06-29',
      endDayKey: '2026-07-05',
      state: 'partial',
      tokens: 100,
      reportedDayCount: 2,
      activeDayCount: 1,
      inRangeDayCount: 4,
      isBoundaryPeriod: true
    });
    expect(monthPoints[1]).toMatchObject({
      startDayKey: '2026-07-06',
      endDayKey: '2026-07-12',
      state: 'partial',
      tokens: 700,
      reportedDayCount: 2,
      inRangeDayCount: 3,
      isBoundaryPeriod: true
    });
    expect(rangeUsageStatistics(monthPoints).maximum).toMatchObject({
      tokens: 700,
      isPartial: true
    });
    expect(
      usagePeriodPoints([], 7, 'week', new Date('2026-07-08T12:00:00Z'))
        .every(point => point.state === 'pending')
    ).toBe(true);

    const yearPoints = usagePeriodPoints(
      entries([['2026-12-31', 50], ['2027-01-01', 75]]),
      7,
      'week',
      new Date('2027-01-04T12:00:00Z')
    );
    expect(yearPoints.map(point => point.startDayKey)).toEqual([
      '2026-12-28',
      '2027-01-04'
    ]);
  });

  it('calculates both averages and deterministic extrema without fabricating missing zeroes', () => {
    const statistics = rangeUsageStatistics([
      reportedPeriod('2026-07-20', 0),
      unavailablePeriod('2026-07-21', 'unreported'),
      reportedPeriod('2026-07-22', 300),
      unavailablePeriod('2026-07-23', 'pending'),
      reportedPeriod('2026-07-24', 300)
    ]);
    expect(statistics).toEqual({
      totalTokens: 600,
      reportedPeriods: 3,
      activePeriods: 2,
      averagePerReportedPeriod: 200,
      averagePerActivePeriod: 300,
      minimum: {
        periodKey: '2026-07-20',
        startDayKey: '2026-07-20',
        endDayKey: '2026-07-20',
        tokens: 0,
        isPartial: false
      },
      maximum: {
        periodKey: '2026-07-24',
        startDayKey: '2026-07-24',
        endDayKey: '2026-07-24',
        tokens: 300,
        isPartial: false
      }
    });
    expect(
      rangeUsageStatistics([
        unavailablePeriod('2026-07-23', 'unreported')
      ])
    ).toMatchObject({
      totalTokens: 0,
      reportedPeriods: 0,
      averagePerReportedPeriod: undefined,
      minimum: undefined,
      maximum: undefined
    });
  });

  it('derives separate local daily points with observed zeroes and missing dates', () => {
    const now = new Date('2026-07-28T12:00:00Z');
    const points = localUsagePeriodPoints(
      [
        localObservation('2026-07-27', 125, 4),
        localObservation('2026-07-28', 0, 1)
      ],
      7,
      'day',
      now
    );
    const yesterday = points.find(point => point.periodKey === '2026-07-27');
    const today = points.find(point => point.periodKey === '2026-07-28');
    const missing = points.find(point => point.periodKey === '2026-07-26');
    expect(yesterday).toMatchObject({
      observedTokens: 125,
      observedDayCount: 1,
      sampleCount: 4
    });
    expect(today).toMatchObject({
      observedTokens: 0,
      observedDayCount: 1,
      isCurrentPeriod: true
    });
    expect(missing?.observedTokens).toBeUndefined();

    const statistics = localRangeUsageStatistics(points);
    expect(statistics).toMatchObject({
      totalObservedTokens: 125,
      observedPeriods: 2,
      activePeriods: 1,
      observedDays: 2,
      inRangeDays: 7,
      averagePerObservedPeriod: 62.5,
      averagePerActivePeriod: 125
    });
    expect(statistics.minimum).toMatchObject({
      periodKey: '2026-07-28',
      observedTokens: 0
    });
  });

  it('aggregates local observations into partial Monday-Sunday UTC weeks', () => {
    const points = localUsagePeriodPoints(
      [
        localObservation('2026-06-30', 100, 2, 1),
        localObservation('2026-07-01', 50, 3)
      ],
      7,
      'week',
      new Date('2026-07-02T12:00:00Z')
    );
    const observedWeek = points.find(
      point => point.periodKey === '2026-06-29'
    );
    expect(observedWeek).toMatchObject({
      startDayKey: '2026-06-29',
      endDayKey: '2026-07-05',
      observedTokens: 150,
      observedDayCount: 2,
      sampleCount: 5,
      resetCount: 1,
      isCurrentPeriod: true
    });
    expect(localRangeUsageStatistics(points)).toMatchObject({
      totalObservedTokens: 150,
      observedPeriods: 1,
      observedDays: 2,
      inRangeDays: 7
    });
  });

  it('joins one source per day without adding overlapping values', () => {
    const now = new Date('2026-07-28T12:00:00Z');
    const local = [
      localObservation('2026-07-25', 50, 2),
      localObservation('2026-07-27', 75, 3),
      localObservation('2026-07-28', 125, 4, 1)
    ];
    const points = joinedUsagePeriodPoints(
      entries([
        ['2026-07-27', 200],
        ['2026-07-28', 300]
      ]),
      local,
      7,
      'day',
      now
    );

    expect(points.find(point => point.periodKey === '2026-07-25')).toMatchObject({
      source: 'local',
      tokens: 50,
      state: 'partial',
      serviceDayCount: 0,
      localDayCount: 1
    });
    expect(points.find(point => point.periodKey === '2026-07-27')).toMatchObject({
      source: 'service',
      tokens: 200,
      state: 'complete',
      serviceContributionTokens: 200,
      localContributionTokens: 0
    });
    expect(points.find(point => point.periodKey === '2026-07-28')).toMatchObject({
      source: 'local',
      tokens: 125,
      state: 'partial',
      serviceAvailableTokens: 300,
      serviceContributionTokens: 0,
      localContributionTokens: 125,
      sampleCount: 4,
      resetCount: 1
    });
    expect(points.find(point => point.periodKey === '2026-07-28')?.tokens).not.toBe(
      425
    );

    const delayed = joinedUsagePeriodPoints(
      entries([
        ['2026-07-25', 500],
        ['2026-07-27', 200],
        ['2026-07-28', 300]
      ]),
      local,
      7,
      'day',
      now
    );
    expect(delayed.find(point => point.periodKey === '2026-07-25')).toMatchObject({
      source: 'service',
      tokens: 500,
      serviceContributionTokens: 500,
      localContributionTokens: 0
    });
  });

  it('sums selected daily values into partial mixed weeks and joined statistics', () => {
    const now = new Date('2026-07-08T12:00:00Z');
    const points = joinedUsagePeriodPoints(
      entries([
        ['2026-07-02', 0],
        ['2026-07-06', 300]
      ]),
      [
        localObservation('2026-07-03', 100, 2),
        localObservation('2026-07-08', 50, 3)
      ],
      7,
      'week',
      now
    );
    expect(points[0]).toMatchObject({
      source: 'mixed',
      tokens: 100,
      serviceDayCount: 1,
      localDayCount: 1,
      missingDayCount: 2,
      activeDayCount: 1,
      state: 'partial'
    });
    expect(points[1]).toMatchObject({
      source: 'mixed',
      tokens: 350,
      serviceDayCount: 1,
      localDayCount: 1,
      missingDayCount: 1,
      state: 'partial',
      isCurrentPeriod: true
    });
    expect(joinedRangeUsageStatistics(points)).toEqual({
      totalTokens: 450,
      valuedPeriods: 2,
      activePeriods: 2,
      serviceDays: 2,
      localDays: 2,
      missingDays: 3,
      inRangeDays: 7,
      averagePerValuedPeriod: 225,
      averagePerActivePeriod: 225,
      minimum: {
        periodKey: '2026-06-29',
        startDayKey: '2026-06-29',
        endDayKey: '2026-07-05',
        tokens: 100,
        source: 'mixed',
        isPartial: true
      },
      maximum: {
        periodKey: '2026-07-06',
        startDayKey: '2026-07-06',
        endDayKey: '2026-07-12',
        tokens: 350,
        source: 'mixed',
        isPartial: true
      }
    });
    const plot = joinedUsagePeriodPlot(points, 1, 7, 74, 6);
    expect(plotRowText(plot.rows.at(-2)!)).toContain('M');
    expect(
      plot.rows.flatMap(row => row.segments.map(segment => segment.tone))
    ).toContain('mixed');
  });

  it('includes explicit joined zeroes and resolves extrema ties to the latest period', () => {
    const points = joinedUsagePeriodPoints(
      entries([
        ['2026-07-26', 0],
        ['2026-07-27', 300],
        ['2026-07-28', 300]
      ]),
      [],
      7,
      'day',
      new Date('2026-07-28T12:00:00Z')
    );
    expect(joinedRangeUsageStatistics(points)).toMatchObject({
      totalTokens: 600,
      valuedPeriods: 3,
      activePeriods: 2,
      averagePerValuedPeriod: 200,
      averagePerActivePeriod: 300,
      minimum: {
        periodKey: '2026-07-26',
        tokens: 0,
        source: 'service'
      },
      maximum: {
        periodKey: '2026-07-28',
        tokens: 300,
        source: 'service'
      }
    });
  });

  it('plots the joined range against one selected-value peak', () => {
    const points = joinedUsagePeriodPoints(
      entries([['2026-07-27', 100]]),
      [
        localObservation('2026-07-27', 100, 2),
        localObservation('2026-07-28', 250, 3)
      ],
      7,
      'day',
      new Date('2026-07-28T12:00:00Z')
    );
    const plot = joinedUsagePeriodPlot(points, 6, 7, 74, 6);
    expect(plot.rangeMaximum).toBe(250);
    expect(plot.rows.every(row => plotRowText(row).length === 74)).toBe(true);
    const text = plot.rows.map(plotRowText).join('\n');
    expect(text).toContain('S');
    expect(text).toContain('L');
  });

  it('derives daily and weekly same-reset observed limit increases', () => {
    const entries = [
      observation('08:00', 80, '2026-07-24T12:00:00.000Z'),
      observation('10:00', 70, '2026-07-24T12:00:00.000Z'),
      observation('13:00', 95, '2026-07-25T12:00:00.000Z'),
      observation('16:00', 90, '2026-07-25T12:00:00.000Z'),
      observation(
        '08:00',
        90,
        '2026-07-26T12:00:00.000Z',
        '2026-07-25T08:00:00.000Z'
      ),
      observation(
        '10:00',
        75,
        '2026-07-26T12:00:00.000Z',
        '2026-07-25T10:00:00.000Z'
      )
    ];
    expect(
      observedDailyLimitChange(entries, 'codex|primary|300', '2026-07-24')
    ).toMatchObject({
      percentagePoints: 15,
      observationCount: 4,
      segmentCount: 2
    });
    const week = {
      ...reportedPeriod('2026-07-24', 100),
      granularity: 'week' as const,
      startDayKey: '2026-07-20',
      endDayKey: '2026-07-26',
      includedStartDayKey: '2026-07-20',
      includedEndDayKey: '2026-07-26',
      inRangeDayCount: 7
    };
    expect(
      observedPeriodLimitChange(entries, 'codex|primary|300', week)
    ).toMatchObject({
      percentagePoints: 30,
      contributingDayCount: 2,
      observationCount: 6
    });
  });

  it('keeps negative corrections at zero and supports missing reset metadata', () => {
    const entries = [
      observation('08:00', 60, undefined),
      observation('10:00', 70, undefined)
    ];
    expect(
      observedDailyLimitChange(entries, 'codex|primary|300', '2026-07-24')
        ?.percentagePoints
    ).toBe(0);
  });

  it('keeps weekly plain output ANSI-free and reports partial coverage and extrema', () => {
    const state: DashboardSnapshot = {
      status: 'unauthenticated',
      limits: [],
      usageSummary: {},
      dailyUsage: entries([['2026-07-22', 10]]),
      localUsageDays: [],
      limitHistory: [],
      lastAttemptAt: '2026-07-24T12:00:00.000Z',
      lastSuccessfulAt: undefined,
      codexVersion: '0.144.3',
      planType: undefined,
      authenticationState: 'signedOut',
      sourceFreshness: {},
      liveUsage: {status: 'unavailable'},
      warning: {
        category: 'unauthenticated',
        message: 'Sign in required.',
        recovery: 'Run codex login.'
      },
      isRefreshing: false
    };
    const output = renderPlain(
      state,
      7,
      'week',
      new Date('2026-07-24T12:00:00Z')
    );
    expect(output).toContain('Joined token activity (week, 7 trailing days)');
    expect(output).toContain('Average per valued period');
    expect(output).toContain('Minimum joined period');
    expect(output).toContain('1 service/0 local/4 missing of 5 days');
    expect(output).toContain('Service source audit');
    expect(output).not.toMatch(/\u001B\[/u);
  });

  it('keeps plain current-day output exact and never fabricates a missing value', () => {
    const baseState: DashboardSnapshot = {
      status: 'fresh',
      limits: [],
      usageSummary: {},
      dailyUsage: [],
      localUsageDays: [],
      limitHistory: [],
      lastAttemptAt: '2026-07-24T12:00:00.000Z',
      lastSuccessfulAt: '2026-07-24T12:00:00.000Z',
      codexVersion: '0.144.3',
      planType: 'plus',
      authenticationState: 'chatgpt',
      sourceFreshness: {
        limitsFetchedAt: '2026-07-24T12:00:00.000Z',
        usageFetchedAt: '2026-07-24T12:00:00.000Z'
      },
      liveUsage: {status: 'disabled'},
      warning: undefined,
      isRefreshing: false
    };
    const now = new Date('2026-07-24T12:00:00Z');
    const reported = renderPlain(
      {...baseState, dailyUsage: entries([['2026-07-24', 456]])},
      7,
      'day',
      now
    );
    expect(reported).toContain(
      '2026-07-24: 456 joined tokens; S service; partial'
    );
    expect(reported).toContain(
      '2026-07-24: 456 service tokens; partial/incomplete'
    );

    const absent = renderPlain(baseState, 7, 'day', now);
    expect(absent).toContain(
      '2026-07-24: ? pending; incomplete'
    );
    expect(absent).not.toContain('2026-07-24: 0');
  });

  it('prints joined lagging usage first and preserves source audits', () => {
    const now = new Date('2026-07-27T12:00:00Z');
    const output = renderPlain(
      {
        status: 'fresh',
        limits: [],
        usageSummary: {},
        dailyUsage: entries([['2026-07-24', 456]]),
        localUsageDays: [localObservation('2026-07-26', 125, 4)],
        limitHistory: [],
        lastAttemptAt: now.toISOString(),
        lastSuccessfulAt: now.toISOString(),
        codexVersion: '0.144.3',
        planType: 'plus',
        authenticationState: 'chatgpt',
        sourceFreshness: {
          limitsFetchedAt: now.toISOString(),
          usageFetchedAt: now.toISOString(),
          usageDataThroughDay: '2026-07-24'
        },
        liveUsage: {
          status: 'observed',
          aggregateTokens: 10_000,
          deltaTokens: 250,
          intervalStartedAt: '2026-07-27T11:00:00.000Z',
          sampledAt: now.toISOString(),
          latestActivityAt: '2026-07-27T11:59:00.000Z',
          todayDayKey: '2026-07-27',
          todayObservedTokens: 250,
          todayBaselineAt: '2026-07-27T11:00:00.000Z',
          todayLatestSampleAt: now.toISOString(),
          todayCoverageStartedAt: '2026-07-27T11:00:00.000Z',
          todaySampleCount: 2,
          todayResetCount: 0
        },
        warning: undefined,
        isRefreshing: false
      },
      7,
      'day',
      now
    );
    expect(output).toContain('Service daily data: through 2026-07-24 (3d behind today)');
    expect(output).toContain('Live observed activity:');
    expect(output).toContain(
      'Scope: local observation—not service-accounted daily usage'
    );
    expect(output).toContain(
      'Observed today: +250 tokens since 11:00 UTC · 2 samples · partial local'
    );
    expect(output).toContain('Joined total: 581 tokens');
    expect(output).toContain('Service source audit:');
    expect(output).toContain('Raw reported total: 456 tokens');
    expect(output).toContain('Local source audit:');
    expect(output).toContain('2026-07-26: +125 observed tokens');
    expect(output).toContain('Covered days: 1/7');
    expect(output).toContain(
      '2026-07-27: ? pending; incomplete'
    );
    expect(output.indexOf('Joined token activity')).toBeLessThan(
      output.indexOf('Service source audit')
    );
    expect(output.indexOf('Service source audit')).toBeLessThan(
      output.indexOf('Local source audit')
    );
    expect(output).not.toMatch(/\u001B\[/u);
  });

  it('treats retained local history as usable plain output without service data', () => {
    const emptyService: DashboardSnapshot = {
      status: 'stale',
      limits: [],
      usageSummary: {},
      dailyUsage: [],
      localUsageDays: [localObservation('2026-07-27', 50, 2)],
      limitHistory: [],
      lastAttemptAt: '2026-07-28T12:00:00.000Z',
      lastSuccessfulAt: undefined,
      codexVersion: '0.144.3',
      planType: undefined,
      authenticationState: 'unknown',
      sourceFreshness: {},
      liveUsage: {status: 'disabled'},
      warning: undefined,
      isRefreshing: false
    };
    expect(plainExitCode(emptyService)).toBe(0);
    expect(
      renderPlain(
        emptyService,
        7,
        'day',
        new Date('2026-07-28T12:00:00Z')
      )
    ).toContain('2026-07-27: +50 observed tokens');
  });
});

function reportedPeriods(range: UsageRange): UsagePeriodPoint[] {
  const now = new Date(
    Date.UTC(2026, 3, 1 + range - 1, 12)
  );
  const dailyEntries = Array.from({length: range}, (_value, index) => {
    const dayKey = new Date(Date.UTC(2026, 3, 1 + index))
      .toISOString()
      .slice(0, 10);
    return {
      dayKey,
      tokens: (index + 1) * 1_000,
      fetchedAt: now.toISOString()
    };
  });
  return usagePeriodPoints(dailyEntries, range, 'day', now);
}

function localObservation(
  dayKey: string,
  observedIncreaseTokens: number,
  sampleCount: number,
  resetCount: number = 0
): LocalUsageDayObservation {
  return {
    dayKey,
    baselineAggregateTokens: 1_000,
    baselineSampledAt: `${dayKey}T08:00:00.000Z`,
    latestAggregateTokens: 1_000 + observedIncreaseTokens,
    latestSampledAt: `${dayKey}T12:00:00.000Z`,
    observedIncreaseTokens,
    sampleCount,
    resetCount
  };
}

function reportedPeriod(dayKey: string, tokens: number): UsagePeriodPoint {
  return {
    periodKey: dayKey,
    startDayKey: dayKey,
    endDayKey: dayKey,
    includedStartDayKey: dayKey,
    includedEndDayKey: dayKey,
    granularity: 'day',
    state: 'reported',
    tokens,
    reportedDayCount: 1,
    activeDayCount: tokens > 0 ? 1 : 0,
    inRangeDayCount: 1,
    isBoundaryPeriod: false,
    isCurrentPeriod: false,
    isIncomplete: false
  };
}

function unavailablePeriod(
  dayKey: string,
  state: 'unreported' | 'pending'
): UsagePeriodPoint {
  return {
    periodKey: dayKey,
    startDayKey: dayKey,
    endDayKey: dayKey,
    includedStartDayKey: dayKey,
    includedEndDayKey: dayKey,
    granularity: 'day',
    state,
    reportedDayCount: 0,
    activeDayCount: 0,
    inRangeDayCount: 1,
    isBoundaryPeriod: false,
    isCurrentPeriod: false,
    isIncomplete: false
  };
}

function entries(
  values: Array<readonly [string, number]>
): DailyUsageEntry[] {
  return values.map(([dayKey, tokens]) => ({
    dayKey,
    tokens,
    fetchedAt: `${dayKey}T12:00:00.000Z`
  }));
}

function observation(
  time: string,
  remainingPercent: number,
  resetsAt: string | undefined,
  observedAt: string = `2026-07-24T${time}:00.000Z`
): LimitHistoryEntry {
  return {
    hourKey: observedAt.slice(0, 13),
    observedAt,
    limitKey: 'codex|primary|300',
    limitId: 'codex',
    displayName: 'Codex',
    windowKind: 'primary',
    durationMinutes: 300,
    remainingPercent,
    resetsAt
  };
}
