import {clamp} from '../domain/normalization.js';
import type {
  JoinedUsagePeriodPoint,
  LimitHistoryEntry,
  UsageRange
} from '../domain/types.js';
import type {UsagePeriodPoint} from '../domain/usage.js';

const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

export type PlotTone =
  | 'low'
  | 'medium'
  | 'high'
  | 'axis'
  | 'muted'
  | 'selected'
  | 'service'
  | 'local'
  | 'mixed';

export type PlotSegment = {
  text: string;
  tone: PlotTone;
  bold: boolean;
};

export type PlotRow = {
  segments: PlotSegment[];
};

export type DailyPlot = {
  rows: PlotRow[];
  width: number;
  axisWidth: number;
  plotWidth: number;
  barWidth: number;
  rangeMaximum: number;
  viewportStart: number;
  viewportEnd: number;
  hasEarlier: boolean;
  hasLater: boolean;
};

export type ActivityPlotOptions = {
  axisWidth?: number;
  includeGuides?: boolean;
  sourceMarkers?: ActivitySourceMarker[];
};

export type ActivitySourceMarker = {
  glyph: 'S' | 'L' | 'M' | '·' | '?';
  tone: 'service' | 'local' | 'mixed' | 'muted';
};

export type HistoryPlot = {
  rows: PlotRow[];
  width: number;
  plotWidth: number;
  selectedColumn: number | undefined;
};

type PlotCell = {
  start: number;
  width: number;
  center: number;
  barStart: number;
  barWidth: number;
};

type AxisLabelCandidate = {
  center: number;
  label: string;
  priority: number;
};

export function progressBar(percent: number, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const filled = Math.round((clamp(percent, 0, 100) / 100) * safeWidth);
  return `${'█'.repeat(filled)}${'░'.repeat(safeWidth - filled)}`;
}

export function calculatePlotHeight(
  terminalRows: number,
  limitCount: number,
  additionalStatusRows: number = 0
): number {
  if (terminalRows < 16) {
    return 0;
  }
  const short = terminalRows < 24;
  const reservedRows =
    (short ? 10 : 17) + Math.max(1, limitCount) + additionalStatusRows;
  const availableRows = Math.max(0, terminalRows - reservedRows);
  const target = Math.floor(terminalRows * 0.4);
  const lower = short ? 3 : 6;
  const upper = short ? 6 : 18;
  if (availableRows < lower) {
    return Math.max(1, availableRows);
  }
  return Math.min(upper, Math.max(lower, target), availableRows);
}

export function usageBand(normalized: number): 'low' | 'medium' | 'high' {
  const bounded = clamp(normalized, 0, 1);
  if (bounded <= 0.5) {
    return 'low';
  }
  if (bounded <= 0.75) {
    return 'medium';
  }
  return 'high';
}

export function bandGlyph(tone: 'low' | 'medium' | 'high'): string {
  return tone === 'low' ? '░' : tone === 'medium' ? '▒' : '█';
}

export function usagePeriodPlot(
  points: UsagePeriodPoint[],
  selectedIndex: number,
  range: UsageRange,
  width: number,
  height: number,
  options: ActivityPlotOptions = {}
): DailyPlot {
  const safeWidth = Math.max(12, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const rangeMaximum = Math.max(
    1,
    ...points.map(point =>
      point.state === 'reported' || point.state === 'partial'
        ? point.tokens
        : 0
    )
  );
  const axisLabels = [
    formatAxisTokens(rangeMaximum),
    formatAxisTokens(rangeMaximum / 2),
    '0'
  ];
  const naturalAxisWidth =
    Math.max(...axisLabels.map(label => label.length)) + 2;
  const axisWidth = Math.max(
    naturalAxisWidth,
    Math.floor(options.axisWidth ?? naturalAxisWidth)
  );
  const plotWidth = Math.max(2, safeWidth - axisWidth);
  const safeSelected = Math.floor(
    clamp(selectedIndex, 0, Math.max(0, points.length - 1))
  );
  const usesScrollablePeriods =
    range >= 90 || points.some(point => point.granularity === 'week');
  const visibleCount =
    usesScrollablePeriods && points.length * 2 > plotWidth
      ? Math.max(1, Math.min(points.length, Math.floor(plotWidth / 2)))
      : points.length;
  const viewportStart =
    points.length <= visibleCount
      ? 0
      : Math.max(
          0,
          Math.min(
            points.length - visibleCount,
            safeSelected - Math.floor(visibleCount / 2)
          )
        );
  const viewportEnd = Math.min(points.length, viewportStart + visibleCount);
  const visible = points.slice(viewportStart, viewportEnd);
  const cells = plotCells(plotWidth, visible.length);
  const barWidth = cells[0]?.barWidth ?? 0;
  const rows: PlotRow[] = [];

  for (let rowIndex = 0; rowIndex < safeHeight; rowIndex++) {
    const rowLevel = (safeHeight - rowIndex) / safeHeight;
    const axisLabel =
      rowIndex === 0
        ? axisLabels[0] ?? ''
        : rowIndex === Math.floor(safeHeight / 2)
          ? axisLabels[1] ?? ''
          : '';
    const segments: PlotSegment[] = [
      segment(`${axisLabel.padStart(axisWidth - 2)} ${axisLabel === '' ? '│' : '┤'}`, 'axis')
    ];
    for (let index = 0; index < visible.length; index++) {
      const point = visible[index];
      const cell = cells[index];
      if (cell === undefined || cell.width <= 0) {
        continue;
      }
      if (point === undefined) {
        appendSegment(segments, ' '.repeat(cell.width), 'muted');
        continue;
      }
      const normalized =
        point.state === 'reported' || point.state === 'partial'
          ? clamp(point.tokens / rangeMaximum, 0, 1)
          : 0;
      const filledRows =
        normalized <= 0 ? 0 : Math.max(1, Math.ceil(normalized * safeHeight));
      if (
        (point.state === 'reported' || point.state === 'partial') &&
        safeHeight - rowIndex <= filledRows
      ) {
        const tone = usageBand(rowLevel);
        appendBarCell(segments, cell, bandGlyph(tone), tone);
      } else {
        appendSegment(segments, ' '.repeat(cell.width), 'muted');
      }
    }
    rows.push({segments});
  }

  const baseline: PlotSegment[] = [
    segment(`${'0'.padStart(axisWidth - 2)} └`, 'axis')
  ];
  appendSegment(baseline, '─'.repeat(plotWidth), 'axis');
  rows.push({segments: baseline});

  if (options.includeGuides !== false) {
    const markerRow: PlotSegment[] = [segment(' '.repeat(axisWidth), 'muted')];
    for (let index = 0; index < visible.length; index++) {
      const point = visible[index];
      const absoluteIndex = viewportStart + index;
      const cell = cells[index];
      if (cell === undefined || cell.width <= 0) {
        continue;
      }
      const glyph =
        absoluteIndex === safeSelected
          ? '^'
          : point?.isIncomplete === true
            ? '!'
            : point?.state === 'partial' || point?.isBoundaryPeriod === true
              ? '~'
              : point?.state === 'unreported'
                ? '·'
                : point?.state === 'pending'
                  ? '?'
                  : ' ';
      appendSegment(
        markerRow,
        centerInCell(glyph, cell.width),
        absoluteIndex === safeSelected ? 'selected' : 'muted',
        absoluteIndex === safeSelected
      );
    }
    rows.push({segments: markerRow});
  }

  if (
    options.includeGuides !== false &&
    options.sourceMarkers !== undefined
  ) {
    const sourceRow: PlotSegment[] = [segment(' '.repeat(axisWidth), 'muted')];
    for (let index = 0; index < visible.length; index++) {
      const absoluteIndex = viewportStart + index;
      const cell = cells[index];
      if (cell === undefined || cell.width <= 0) {
        continue;
      }
      const marker = options.sourceMarkers[absoluteIndex] ?? {
        glyph: '·',
        tone: 'muted'
      };
      appendSegment(
        sourceRow,
        centerInCell(marker.glyph, cell.width),
        marker.tone
      );
    }
    rows.push({segments: sourceRow});
  }

  if (
    options.includeGuides !== false &&
    visible[0]?.granularity === 'day'
  ) {
    rows.push({
      segments: [
        segment(' '.repeat(axisWidth), 'muted'),
        segment(activityWeekendGuide(visible, cells, plotWidth), 'muted')
      ]
    });
  }

  if (options.includeGuides !== false) {
    rows.push({
      segments: [
        segment(' '.repeat(axisWidth), 'muted'),
        segment(
          activityCalendarAxis(
            visible,
            cells,
            plotWidth,
            viewportStart > 0,
            viewportEnd < points.length
          ),
          'axis'
        )
      ]
    });
  }

  return {
    rows,
    width: safeWidth,
    axisWidth,
    plotWidth,
    barWidth,
    rangeMaximum,
    viewportStart,
    viewportEnd,
    hasEarlier: viewportStart > 0,
    hasLater: viewportEnd < points.length
  };
}

export function joinedUsagePeriodPlot(
  points: JoinedUsagePeriodPoint[],
  selectedIndex: number,
  range: UsageRange,
  width: number,
  height: number,
  options: ActivityPlotOptions = {}
): DailyPlot {
  const adapted: UsagePeriodPoint[] = points.map(point => {
    const base = {
      periodKey: point.periodKey,
      startDayKey: point.startDayKey,
      endDayKey: point.endDayKey,
      includedStartDayKey: point.startDayKey,
      includedEndDayKey: point.endDayKey,
      granularity: point.granularity,
      reportedDayCount: point.serviceDayCount + point.localDayCount,
      activeDayCount: point.activeDayCount,
      inRangeDayCount: point.inRangeDayCount,
      isBoundaryPeriod: point.isBoundaryPeriod,
      isCurrentPeriod: point.isCurrentPeriod,
      isIncomplete: point.isCurrentPeriod
    };
    return point.tokens === undefined
      ? {
          ...base,
          state:
            point.state === 'pending'
              ? ('pending' as const)
              : ('unreported' as const)
        }
      : {
          ...base,
          state:
            point.state === 'complete'
              ? ('reported' as const)
              : ('partial' as const),
          tokens: point.tokens
        };
  });
  const sourceMarkers: ActivitySourceMarker[] = points.map(point => {
    if (point.source === 'service') {
      return {glyph: 'S', tone: 'service'};
    }
    if (point.source === 'local') {
      return {glyph: 'L', tone: 'local'};
    }
    if (point.source === 'mixed') {
      return {glyph: 'M', tone: 'mixed'};
    }
    return point.state === 'pending'
      ? {glyph: '?', tone: 'muted'}
      : {glyph: '·', tone: 'muted'};
  });
  return usagePeriodPlot(
    adapted,
    selectedIndex,
    range,
    width,
    height,
    {...options, sourceMarkers}
  );
}

export function historySeries(
  entries: LimitHistoryEntry[],
  limitKey: string,
  range: UsageRange,
  now: Date = new Date()
): LimitHistoryEntry[] {
  const start = now.getTime() - range * DAY_MILLISECONDS;
  const end = now.getTime();
  return entries
    .filter(entry => {
      const observedAt = Date.parse(entry.observedAt);
      return (
        entry.limitKey === limitKey &&
        observedAt >= start &&
        observedAt <= end
      );
    })
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
}

export function limitHistoryPlot(
  entries: LimitHistoryEntry[],
  selectedIndex: number,
  range: UsageRange,
  width: number,
  height: number,
  now: Date = new Date()
): HistoryPlot {
  const safeWidth = Math.max(12, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const axisWidth = 6;
  const plotWidth = Math.max(2, safeWidth - axisWidth);
  const rangeEnd = now.getTime();
  const rangeStart = rangeEnd - range * DAY_MILLISECONDS;
  const columnValues = new Map<number, number>();
  const safeSelected =
    entries.length === 0
      ? 0
      : Math.floor(clamp(selectedIndex, 0, entries.length - 1));
  let selectedColumn: number | undefined;

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry === undefined) {
      continue;
    }
    const timestamp = Date.parse(entry.observedAt);
    if (timestamp < rangeStart || timestamp > rangeEnd) {
      continue;
    }
    const ratio = (timestamp - rangeStart) / Math.max(1, rangeEnd - rangeStart);
    const column = Math.round(ratio * (plotWidth - 1));
    const usedPercent = clamp(100 - entry.remainingPercent, 0, 100);
    columnValues.set(
      column,
      Math.max(columnValues.get(column) ?? 0, usedPercent)
    );
    if (index === safeSelected) {
      selectedColumn = column;
    }
  }

  const rows: PlotRow[] = [];
  for (let rowIndex = 0; rowIndex < safeHeight; rowIndex++) {
    const rowLevel = (safeHeight - rowIndex) / safeHeight;
    const axisLabel =
      rowIndex === 0
        ? '100%'
        : rowIndex === Math.floor(safeHeight / 2)
          ? '50%'
          : '';
    const segments: PlotSegment[] = [
      segment(`${axisLabel.padStart(axisWidth - 2)} ${axisLabel === '' ? '│' : '┤'}`, 'axis')
    ];
    for (let column = 0; column < plotWidth; column++) {
      const value = columnValues.get(column);
      const filledRows =
        value === undefined || value <= 0
          ? 0
          : Math.max(1, Math.ceil((value / 100) * safeHeight));
      if (safeHeight - rowIndex <= filledRows) {
        const tone = usageBand(rowLevel);
        appendSegment(segments, bandGlyph(tone), tone);
      } else {
        appendSegment(segments, ' ', 'muted');
      }
    }
    rows.push({segments});
  }

  const baseline: PlotSegment[] = [segment('  0% └', 'axis')];
  appendSegment(baseline, '─'.repeat(plotWidth), 'axis');
  rows.push({segments: baseline});

  const marker: PlotSegment[] = [segment(' '.repeat(axisWidth), 'muted')];
  for (let column = 0; column < plotWidth; column++) {
    appendSegment(
      marker,
      selectedColumn === column ? '^' : ' ',
      selectedColumn === column ? 'selected' : 'muted',
      selectedColumn === column
    );
  }
  rows.push({segments: marker});

  rows.push({
    segments: [
      segment(' '.repeat(axisWidth), 'muted'),
      segment(historyWeekendGuide(rangeStart, rangeEnd, plotWidth), 'muted')
    ]
  });

  rows.push({
    segments: [
      segment(' '.repeat(axisWidth), 'muted'),
      segment(
        historyCalendarAxis(rangeStart, rangeEnd, range, plotWidth),
        'axis'
      )
    ]
  });

  return {rows, width: safeWidth, plotWidth, selectedColumn};
}

export function plotRowText(row: PlotRow): string {
  return row.segments.map(item => item.text).join('');
}

function formatAxisTokens(value: number): string {
  const rounded = Math.round(value);
  if (rounded >= 1_000_000_000) {
    return `${trimDecimal(rounded / 1_000_000_000)}B`;
  }
  if (rounded >= 1_000_000) {
    return `${trimDecimal(rounded / 1_000_000)}M`;
  }
  if (rounded >= 1_000) {
    return `${trimDecimal(rounded / 1_000)}k`;
  }
  return String(rounded);
}

function trimDecimal(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/u, '');
}

function distributeWidth(totalWidth: number, itemCount: number): number[] {
  if (itemCount <= 0) {
    return [];
  }
  const base = Math.floor(totalWidth / itemCount);
  const remainder = totalWidth % itemCount;
  return Array.from(
    {length: itemCount},
    (_value, index) => base + (index < remainder ? 1 : 0)
  );
}

function plotCells(totalWidth: number, itemCount: number): PlotCell[] {
  const widths = distributeWidth(totalWidth, itemCount);
  const barWidth =
    widths.length === 0 ? 0 : Math.max(1, Math.min(...widths) - 1);
  let start = 0;
  return widths.map(width => {
    const barStart = Math.floor((width - barWidth) / 2);
    const cell = {
      start,
      width,
      center: start + Math.floor((width - 1) / 2),
      barStart,
      barWidth
    };
    start += width;
    return cell;
  });
}

function appendBarCell(
  segments: PlotSegment[],
  cell: PlotCell,
  glyph: string,
  tone: 'low' | 'medium' | 'high'
): void {
  appendSegment(segments, ' '.repeat(cell.barStart), 'muted');
  appendSegment(segments, glyph.repeat(cell.barWidth), tone);
  appendSegment(
    segments,
    ' '.repeat(cell.width - cell.barStart - cell.barWidth),
    'muted'
  );
}

function centerInCell(value: string, width: number): string {
  if (width <= value.length) {
    return value.slice(0, width);
  }
  const left = Math.floor((width - value.length) / 2);
  return `${' '.repeat(left)}${value}${' '.repeat(width - value.length - left)}`;
}

function activityWeekendGuide(
  points: UsagePeriodPoint[],
  cells: PlotCell[],
  width: number,
): string {
  const characters = Array.from({length: width}, () => ' ');
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const cell = cells[index];
    if (
      point !== undefined &&
      cell !== undefined &&
      isWeekendDay(point.startDayKey)
    ) {
      characters[cell.center] = 'W';
    }
  }
  return characters.join('');
}

function activityCalendarAxis(
  points: UsagePeriodPoint[],
  cells: PlotCell[],
  width: number,
  hasEarlier: boolean,
  hasLater: boolean
): string {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return ' '.repeat(width);
  }
  const candidates: AxisLabelCandidate[] = [];
  const firstCell = cells[0];
  const lastCell = cells.at(-1);
  const labelEveryDailyPoint =
    first.granularity === 'day' && points.length <= 7;
  if (firstCell !== undefined) {
    candidates.push({
      center: firstCell.center,
      label: `${hasEarlier ? '‹' : ''}${
        labelEveryDailyPoint
          ? formatWeekdayDay(first.includedStartDayKey)
          : formatMonthDay(first.includedStartDayKey)
      }`,
      priority: 100
    });
  }
  if (lastCell !== undefined) {
    candidates.push({
      center: lastCell.center,
      label: `${
        labelEveryDailyPoint
          ? formatWeekdayDay(last.includedEndDayKey)
          : formatMonthDay(last.includedEndDayKey)
      }${hasLater ? '›' : ''}`,
      priority: 100
    });
  }

  const isDaily = first.granularity === 'day';
  for (let index = 0; index < points.length; index++) {
    if (index === 0 || index === points.length - 1) {
      continue;
    }
    const point = points[index];
    const cell = cells[index];
    if (point === undefined || cell === undefined) {
      continue;
    }
    const date = utcDate(point.startDayKey);
    if (isDaily && points.length <= 7) {
      candidates.push({
        center: cell.center,
        label: formatWeekdayDay(point.startDayKey),
        priority: 80
      });
    } else if (isDaily && date.getUTCDate() === 1) {
      candidates.push({
        center: cell.center,
        label: formatMonthDay(point.startDayKey),
        priority: 70
      });
    } else if (isDaily && date.getUTCDay() === 1) {
      candidates.push({
        center: cell.center,
        label: formatMonthDay(point.startDayKey),
        priority: 50
      });
    } else if (
      !isDaily &&
      point.startDayKey.slice(0, 7) !==
        points[index - 1]?.startDayKey.slice(0, 7)
    ) {
      candidates.push({
        center: cell.center,
        label: formatMonthDay(point.startDayKey),
        priority: 70
      });
    }
  }
  return placeAxisLabels(width, candidates);
}

function historyWeekendGuide(
  rangeStart: number,
  rangeEnd: number,
  width: number
): string {
  const characters = Array.from({length: width}, () => ' ');
  for (let column = 0; column < width; column++) {
    const ratio = width <= 1 ? 0 : column / (width - 1);
    const timestamp = rangeStart + (rangeEnd - rangeStart) * ratio;
    if (isWeekendDay(new Date(timestamp).toISOString().slice(0, 10))) {
      characters[column] = 'W';
    }
  }
  return characters.join('');
}

function historyCalendarAxis(
  rangeStart: number,
  rangeEnd: number,
  range: UsageRange,
  width: number
): string {
  const startDayKey = new Date(rangeStart).toISOString().slice(0, 10);
  const endDayKey = new Date(rangeEnd).toISOString().slice(0, 10);
  const candidates: AxisLabelCandidate[] = [
    {
      center: 0,
      label: formatMonthDay(startDayKey),
      priority: 100
    },
    {
      center: width - 1,
      label: formatMonthDay(endDayKey),
      priority: 100
    }
  ];
  const firstMidnight = Date.parse(`${startDayKey}T00:00:00.000Z`);
  for (
    let timestamp = firstMidnight + DAY_MILLISECONDS;
    timestamp < rangeEnd;
    timestamp += DAY_MILLISECONDS
  ) {
    const dayKey = new Date(timestamp).toISOString().slice(0, 10);
    const date = utcDate(dayKey);
    const include =
      range <= 7 || date.getUTCDate() === 1 || date.getUTCDay() === 1;
    if (!include) {
      continue;
    }
    const ratio = (timestamp - rangeStart) / Math.max(1, rangeEnd - rangeStart);
    candidates.push({
      center: Math.round(ratio * (width - 1)),
      label:
        range <= 7 ? formatWeekdayDay(dayKey) : formatMonthDay(dayKey),
      priority: date.getUTCDate() === 1 ? 70 : 50
    });
  }
  return placeAxisLabels(width, candidates);
}

function placeAxisLabels(
  width: number,
  candidates: AxisLabelCandidate[]
): string {
  const characters = Array.from({length: width}, () => ' ');
  const occupied = Array.from({length: width}, () => false);
  const ordered = [...candidates].sort(
    (left, right) =>
      right.priority - left.priority || left.center - right.center
  );
  for (const candidate of ordered) {
    if (candidate.label.length > width) {
      continue;
    }
    const start = Math.max(
      0,
      Math.min(
        width - candidate.label.length,
        candidate.center - Math.floor(candidate.label.length / 2)
      )
    );
    const end = start + candidate.label.length;
    const collisionStart = Math.max(0, start - 1);
    const collisionEnd = Math.min(width, end + 1);
    if (occupied.slice(collisionStart, collisionEnd).some(Boolean)) {
      continue;
    }
    for (let index = start; index < end; index++) {
      characters[index] = candidate.label[index - start] ?? ' ';
      occupied[index] = true;
    }
  }
  return characters.join('');
}

function isWeekendDay(dayKey: string): boolean {
  const day = utcDate(dayKey).getUTCDay();
  return day === 0 || day === 6;
}

function utcDate(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

function formatMonthDay(dayKey: string): string {
  const date = utcDate(dayKey);
  return `${MONTH_NAMES[date.getUTCMonth()] ?? ''} ${date.getUTCDate()}`;
}

function formatWeekdayDay(dayKey: string): string {
  const date = utcDate(dayKey);
  return `${WEEKDAY_NAMES[date.getUTCDay()] ?? ''} ${date.getUTCDate()}`;
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
] as const;

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function segment(
  text: string,
  tone: PlotTone,
  bold: boolean = false
): PlotSegment {
  return {text, tone, bold};
}

function appendSegment(
  segments: PlotSegment[],
  text: string,
  tone: PlotTone,
  bold: boolean = false
): void {
  if (text.length === 0) {
    return;
  }
  const previous = segments.at(-1);
  if (previous !== undefined && previous.tone === tone && previous.bold === bold) {
    previous.text += text;
    return;
  }
  segments.push(segment(text, tone, bold));
}
