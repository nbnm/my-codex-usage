import {useCallback, useEffect, useMemo, useState} from 'react';
import {Box, Text, useApp, useInput, useStdout} from 'ink';
import {
  formatElapsedSeconds,
  formatDuration,
  formatPercent,
  formatReset,
  formatTokens,
  formatUpdated,
  statusLabel
} from '../domain/format.js';
import {toDisplaySafeError} from '../domain/errors.js';
import type {
  DashboardSnapshot,
  JoinedUsagePeriodPoint,
  NormalizedLimitWindow,
  UsageGranularity,
  UsageRange,
  UsageRefreshCoordinator
} from '../domain/types.js';
import {
  joinedRangeUsageStatistics,
  joinedUsagePeriodPoints,
  observedPeriodLimitChange,
  type JoinedRangeUsageStatistics,
  type ObservedPeriodLimitChange,
} from '../domain/usage.js';
import {
  calculatePlotHeight,
  historySeries,
  joinedUsagePeriodPlot,
  limitHistoryPlot,
  progressBar,
  type PlotRow,
  type PlotTone
} from './charts.js';

type AppProps = {
  coordinator: UsageRefreshCoordinator;
  initialState: DashboardSnapshot;
  initialRange: UsageRange;
  initialGranularity?: UsageGranularity;
  color: boolean;
  terminalSize?: {columns: number; rows: number};
  openUrl?: (url: string) => Promise<void>;
};

type ChartMode = 'activity' | 'history' | 'overview';

export function UsageApp({
  coordinator,
  initialState,
  initialRange,
  initialGranularity = 'day',
  color,
  terminalSize,
  openUrl = async () => undefined
}: AppProps): React.JSX.Element {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const [state, setState] = useState(initialState);
  const [range, setRange] = useState<UsageRange>(initialRange);
  const [granularity, setGranularity] =
    useState<UsageGranularity>(initialGranularity);
  const [chart, setChart] = useState<ChartMode>('activity');
  const [selectedLimit, setSelectedLimit] = useState(0);
  const [selectedDay, setSelectedDay] = useState(
    preferredJoinedPeriodIndex(
      joinedUsagePeriodPoints(
        initialState.dailyUsage,
        initialState.localUsageDays,
        initialRange,
        initialGranularity
      )
    )
  );
  const [selectedObservation, setSelectedObservation] = useState(0);
  const [activitySelectionTouched, setActivitySelectionTouched] =
    useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [loginMessage, setLoginMessage] = useState<string | undefined>();
  const [size, setSize] = useState({
    columns: terminalSize?.columns ?? stdout.columns ?? 80,
    rows: terminalSize?.rows ?? stdout.rows ?? 24
  });
  const currentUtcDay = new Date().toISOString().slice(0, 10);
  const joinedPoints = useMemo(
    () =>
      joinedUsagePeriodPoints(
        state.dailyUsage,
        state.localUsageDays,
        range,
        granularity
      ),
    [currentUtcDay, granularity, range, state.dailyUsage, state.localUsageDays]
  );
  const activityPointCount = joinedPoints.length;
  const selectedLimitValue = state.limits[selectedLimit];
  const displayedSelectedDay = activitySelectionTouched
    ? selectedDay
    : preferredJoinedPeriodIndex(joinedPoints);
  const observations = useMemo(
    () =>
      selectedLimitValue === undefined
        ? []
        : historySeries(state.limitHistory, selectedLimitValue.key, range),
    [range, selectedLimitValue, state.limitHistory]
  );

  const refresh = useCallback(() => {
    setState(current => ({...current, isRefreshing: true}));
    void coordinator.refresh('manual').then(setState);
  }, [coordinator]);

  const login = useCallback(() => {
    if (state.status !== 'unauthenticated' || loginMessage !== undefined) {
      return;
    }
    setLoginMessage('Opening ChatGPT authorization…');
    setState(current => ({
      ...current,
      status: 'authenticating',
      warning: undefined
    }));
    void coordinator
      .startChatGPTLogin()
      .then(async prompt => {
        await openUrl(prompt.authUrl);
        setLoginMessage('Waiting for browser authorization…');
        return coordinator.waitForLoginCompletion(prompt.loginId);
      })
      .then(setState)
      .catch(error => {
        setState(current => ({
          ...current,
          status: 'unauthenticated',
          warning: toDisplaySafeError(error),
          isRefreshing: false
        }));
      })
      .finally(() => {
        setLoginMessage(undefined);
      });
  }, [coordinator, loginMessage, openUrl, state.status]);

  useEffect(() => {
    let active = true;
    setState(current => ({...current, isRefreshing: true}));
    void coordinator.refresh('launch').then(next => {
      if (active) {
        setState(next);
      }
    });
    coordinator.startAutomaticRefresh(next => {
      if (active) {
        setState(next);
      }
    });
    return () => {
      active = false;
    };
  }, [coordinator]);

  useEffect(() => {
    const resized = (): void => {
      if (terminalSize !== undefined) {
        return;
      }
      setSize({columns: stdout.columns ?? 80, rows: stdout.rows ?? 24});
    };
    stdout.on('resize', resized);
    return () => {
      stdout.off('resize', resized);
    };
  }, [stdout, terminalSize]);

  useInput((input, key) => {
    if (input === 'q' || key.escape || (input === 'c' && key.ctrl)) {
      exit();
      return;
    }
    if (input === '?') {
      setShowHelp(current => !current);
      return;
    }
    if (showHelp) {
      return;
    }
    if (input === 'r') {
      refresh();
    } else if (input === 'l') {
      login();
    } else if (key.tab) {
      setChart(current =>
        current === 'activity'
          ? 'history'
          : current === 'history'
            ? 'overview'
            : 'activity'
      );
    } else if (input === 'd') {
      setActivitySelectionTouched(false);
      setRange(current => {
        const next = nextRange(current);
        const nextJoinedPoints = joinedUsagePeriodPoints(
          state.dailyUsage,
          state.localUsageDays,
          next,
          granularity
        );
        setSelectedDay(preferredJoinedPeriodIndex(nextJoinedPoints));
        return next;
      });
    } else if (input === 'w') {
      setActivitySelectionTouched(false);
      setGranularity(current => {
        const next = current === 'day' ? 'week' : 'day';
        const nextJoinedPoints = joinedUsagePeriodPoints(
          state.dailyUsage,
          state.localUsageDays,
          range,
          next
        );
        setSelectedDay(preferredJoinedPeriodIndex(nextJoinedPoints));
        return next;
      });
    } else if (key.upArrow) {
      setSelectedLimit(current =>
        Math.max(0, current - 1)
      );
    } else if (key.downArrow) {
      setSelectedLimit(current =>
        Math.min(Math.max(0, state.limits.length - 1), current + 1)
      );
    } else if (key.leftArrow && chart === 'activity') {
      setActivitySelectionTouched(true);
      setSelectedDay(Math.max(0, displayedSelectedDay - 1));
    } else if (key.rightArrow && chart === 'activity') {
      setActivitySelectionTouched(true);
      setSelectedDay(
        Math.min(
          Math.max(0, activityPointCount - 1),
          displayedSelectedDay + 1
        )
      );
    } else if (key.leftArrow && chart === 'history') {
      setSelectedObservation(current => Math.max(0, current - 1));
    } else if (key.rightArrow && chart === 'history') {
      setSelectedObservation(current =>
        Math.min(Math.max(0, observations.length - 1), current + 1)
      );
    }
  });

  useEffect(() => {
    if (selectedLimit >= state.limits.length) {
      setSelectedLimit(Math.max(0, state.limits.length - 1));
    }
  }, [selectedLimit, state.limits.length]);

  useEffect(() => {
    setSelectedDay(current => {
      if (current >= 0 && current < activityPointCount) {
        return current;
      }
      return preferredJoinedPeriodIndex(joinedPoints);
    });
  }, [
    currentUtcDay,
    activityPointCount,
    joinedPoints,
    state.liveUsage.todayDayKey
  ]);

  useEffect(() => {
    setSelectedObservation(Math.max(0, observations.length - 1));
  }, [observations]);

  if (showHelp) {
    return <HelpView color={color} />;
  }

  const compact = size.columns < 60 || size.rows < 16;
  const shortLayout =
    !compact && (size.rows < 24 || (chart === 'activity' && size.rows < 28));
  const additionalStatusRows =
    (state.warning === undefined
      ? 0
      : state.warning.recovery === undefined
        ? 2
        : 3) +
    (loginMessage === undefined ? 0 : 2);
  const plotHeight =
    chart === 'activity'
      ? calculatePlotHeight(
          size.rows,
          state.limits.length,
          additionalStatusRows +
            (size.rows < 18 ? 1 : size.rows >= 28 ? 8 : 0)
        )
      : calculatePlotHeight(
          size.rows,
          state.limits.length,
          additionalStatusRows +
            calendarGuideRowAdjustment(chart, granularity) +
            1
        );
  return (
    <Box flexDirection="column" paddingX={1} width={size.columns}>
      <Header state={state} color={color} short={shortLayout} />
      <Box marginTop={shortLayout ? 0 : 1} flexDirection="column">
        {!shortLayout && <Text bold>Current limits</Text>}
        {state.limits.length === 0 ? (
          <Text dimColor>No usable current limit data.</Text>
        ) : (
          state.limits.map(limit => (
            <LimitRow
              key={`${limit.key}|${limit.resetsAt ?? ''}`}
              limit={limit}
              compact={compact}
              width={size.columns}
              color={color}
            />
          ))
        )}
      </Box>
      {state.warning !== undefined && (
        <Box marginTop={1} flexDirection="column">
          <Text {...whenColor(color, 'yellow')}>
            {state.warning.message}
          </Text>
          {state.warning.recovery !== undefined && (
            <Text dimColor>{state.warning.recovery}</Text>
          )}
        </Box>
      )}
      {loginMessage !== undefined && (
        <Box marginTop={1}>
          <Text {...whenColor(color, 'cyan')}>{loginMessage}</Text>
        </Box>
      )}
      {compact ? (
        <Box marginTop={1} flexDirection="column">
          {state.liveUsage.todayDayKey === currentUtcDay && (
            <Text {...whenColor(color, 'magenta')}>
              {formatObservedToday(state)}
            </Text>
          )}
          <Text dimColor>
            Resize to at least 60×16 for charts. r refresh{state.status === 'unauthenticated' ? ' · l login' : ''} · ? help · q quit
          </Text>
        </Box>
      ) : (
        <ChartPanel
          state={state}
          mode={chart}
          range={range}
          granularity={granularity}
          joinedPoints={joinedPoints}
          selectedDay={displayedSelectedDay}
          selectedLimit={selectedLimit}
          selectedObservation={selectedObservation}
          width={size.columns}
          height={plotHeight}
          short={shortLayout}
          showStatistics={size.rows >= 24}
          color={color}
        />
      )}
      {!compact && (
        <Box marginTop={shortLayout ? 0 : 1}>
          <Text dimColor>
            {shortLayout || size.columns < 100
              ? `r · Tab · d ${nextRange(range)}d · w ${nextGranularity(granularity)} · arrows · ? · q`
              : `r refresh${state.status === 'unauthenticated' ? ' · l login' : ''} · Tab panel · d ${nextRange(range)}d · w ${nextGranularity(granularity)} · ←/→ time · ↑/↓ limit · ? · q`}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function Header({
  state,
  color,
  short
}: {
  state: DashboardSnapshot;
  color: boolean;
  short: boolean;
}): React.JSX.Element {
  const statusColor =
    state.status === 'fresh'
      ? 'green'
      : state.status === 'loading' || state.status === 'authenticating'
        ? 'cyan'
        : state.status === 'partial' || state.status === 'stale'
          ? 'yellow'
          : 'red';
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold {...whenColor(color, 'cyan')}>My Codex Usage</Text>
        <Text {...whenColor(color, statusColor)}>
          {state.isRefreshing ? 'Refreshing…' : statusLabel(state.status)}
        </Text>
      </Box>
      {!short && (
        <Text dimColor>
          Plan {state.planType ?? state.authenticationState} · Codex {state.codexVersion ?? 'unknown'} · Updated {formatUpdated(state.lastSuccessfulAt)}
        </Text>
      )}
      <Text dimColor>
        {formatSourceFreshnessLine(state, short)}
      </Text>
    </Box>
  );
}

function LimitRow({
  limit,
  compact,
  width,
  color
}: {
  limit: NormalizedLimitWindow;
  compact: boolean;
  width: number;
  color: boolean;
}): React.JSX.Element {
  const percentColor =
    limit.remainingPercent <= 10
      ? 'red'
      : limit.remainingPercent <= 25
        ? 'yellow'
        : 'green';
  if (compact) {
    return (
      <Text wrap="truncate">
        <Text {...whenColor(color, percentColor)}>
          {formatPercent(limit.remainingPercent).padStart(4)}
        </Text>
        {' '}{limit.displayName} · {formatDuration(limit.durationMinutes)} · {formatReset(limit.resetsAt)}
      </Text>
    );
  }
  const duration = formatDuration(limit.durationMinutes);
  const reset = formatReset(limit.resetsAt);
  const percentage = `${formatPercent(limit.remainingPercent)} remaining`;
  const barWidth = Math.max(6, Math.min(16, Math.floor(width * 0.16)));
  const fixedWidth =
    barWidth + duration.length + reset.length + percentage.length + 12;
  const nameWidth = Math.max(8, width - fixedWidth);
  const displayName =
    limit.displayName.length <= nameWidth
      ? limit.displayName
      : `${limit.displayName.slice(0, Math.max(1, nameWidth - 1))}…`;
  return (
    <Text wrap="truncate">
      <Text bold>{displayName}</Text>
      {' · '}
      <Text {...whenColor(color, percentColor)}>
        {progressBar(limit.remainingPercent, barWidth)} {percentage}
      </Text>
      {' · '}{duration} · {reset}
    </Text>
  );
}

function ChartPanel({
  state,
  mode,
  range,
  granularity,
  joinedPoints,
  selectedDay,
  selectedLimit,
  selectedObservation,
  width,
  height,
  short,
  showStatistics,
  color
}: {
  state: DashboardSnapshot;
  mode: ChartMode;
  range: UsageRange;
  granularity: UsageGranularity;
  joinedPoints: JoinedUsagePeriodPoint[];
  selectedDay: number;
  selectedLimit: number;
  selectedObservation: number;
  width: number;
  height: number;
  short: boolean;
  showStatistics: boolean;
  color: boolean;
}): React.JSX.Element {
  const selectedLimitValue = state.limits[selectedLimit];
  const title =
    mode === 'activity'
      ? granularity === 'day'
        ? `Joined token activity · ${range} days${short ? ' · red≠quota' : ''}`
        : `Joined token activity · last ${range} days · weekly${short ? ' · red≠quota' : ''}`
      : mode === 'history'
        ? `Limit history · ${range} days${short && selectedLimitValue !== undefined ? ` · ${selectedLimitValue.displayName}` : ''}`
        : 'Usage overview · account lifetime';
  return (
    <Box
      flexDirection="column"
      marginTop={short ? 0 : 1}
      borderStyle={short ? undefined : 'round'}
      paddingX={1}
    >
      {mode !== 'activity' && (
        <Text bold {...whenColor(color, 'cyan')}>
          {title}
        </Text>
      )}
      {mode === 'activity' && (
        <JoinedActivityChart
          state={state}
          range={range}
          granularity={granularity}
          points={joinedPoints}
          selectedDay={selectedDay}
          selectedLimit={selectedLimit}
          width={width}
          height={height}
          short={short}
          showStatistics={showStatistics}
          color={color}
        />
      )}
      {mode === 'history' && (
        <HistoryChart
          state={state}
          range={range}
          selectedLimit={selectedLimit}
          selectedObservation={selectedObservation}
          width={width}
          height={height}
          short={short}
          color={color}
        />
      )}
      {mode === 'overview' && (
        <OverviewPanel state={state} color={color} />
      )}
    </Box>
  );
}

function JoinedActivityChart({
  state,
  range,
  granularity,
  points,
  selectedDay,
  selectedLimit,
  width,
  height,
  short,
  showStatistics,
  color
}: {
  state: DashboardSnapshot;
  range: UsageRange;
  granularity: UsageGranularity;
  points: JoinedUsagePeriodPoint[];
  selectedDay: number;
  selectedLimit: number;
  width: number;
  height: number;
  short: boolean;
  showStatistics: boolean;
  color: boolean;
}): React.JSX.Element {
  const statistics = joinedRangeUsageStatistics(points);
  const selectedPoint = points[selectedDay];
  const limit = state.limits[selectedLimit];
  const observed =
    selectedPoint === undefined || limit === undefined
      ? undefined
      : observedPeriodLimitChange(
          state.limitHistory,
          limit.key,
          selectedPoint
        );
  const plot = joinedUsagePeriodPlot(
    points,
    selectedDay,
    range,
    Math.max(12, width - 6),
    height
  );
  const micro = short && height < 3;
  return (
    <Box flexDirection="column">
      <Text bold {...whenColor(color, 'blue')}>
        {short
          ? `Joined token activity · ${range}d${granularity === 'week' ? ' weekly' : ''} · red≠quota`
          : `Joined token activity · ${range} days${granularity === 'week' ? ' · weekly' : ''}`}
      </Text>
      {!short && (
        <Text dimColor>
          service for completed reported days; local for today/gaps · not an authoritative service total
        </Text>
      )}
      <PlotRows rows={plot.rows} color={color} />
      {!micro && (
        <Text>
          {short
            ? formatSelectedJoinedCompact(selectedPoint)
            : formatSelectedJoinedPeriod(selectedPoint, statistics)}
        </Text>
      )}
      {showStatistics && (
        <JoinedRangeStatisticsLines
          statistics={statistics}
          width={width}
          short={short}
        />
      )}
      {short && showStatistics && (
        <LiveObservedActivity state={state} color={color} compact />
      )}
      {!short && (
        <>
          <UsageBandLegend
            kind="daily"
            color={color}
            compact={width < 100}
            partial={points.some(point => point.state === 'partial')}
            incomplete={
              points.some(point => point.isIncomplete)
            }
            weekend={granularity === 'day'}
          />
          <Text dimColor>
            <Text {...whenColor(color, 'blue')}>S service</Text>
            {' · '}
            <Text {...whenColor(color, 'magenta')}>L local partial</Text>
            {' · '}
            <Text {...whenColor(color, 'yellow')}>M mixed week</Text>
            {' · · missing · ? pending'}
          </Text>
          {state.liveUsage.status === 'disabled' && (
            <Text dimColor>
              Local sampling disabled; retained history may fill gaps.
            </Text>
          )}
          <LiveObservedActivity
            state={state}
            color={color}
            compact={width < 100}
          />
        </>
      )}
      {!micro && (
        <Text {...whenColor(color, observed === undefined ? 'yellow' : 'magenta')}>
          {short
            ? formatObservedChangeCompact(limit, observed)
            : formatObservedChange(limit, observed)}
        </Text>
      )}
    </Box>
  );
}

function HistoryChart({
  state,
  range,
  selectedLimit,
  selectedObservation,
  width,
  height,
  short,
  color
}: {
  state: DashboardSnapshot;
  range: UsageRange;
  selectedLimit: number;
  selectedObservation: number;
  width: number;
  height: number;
  short: boolean;
  color: boolean;
}): React.JSX.Element {
  const limit = state.limits[selectedLimit];
  if (limit === undefined) {
    return <Text dimColor>No limit history is available.</Text>;
  }
  const observations = historySeries(
    state.limitHistory,
    limit.key,
    range
  );
  const selected = observations[selectedObservation] ?? observations.at(-1);
  const selectedIndex =
    selected === undefined ? 0 : Math.max(0, observations.indexOf(selected));
  const plot = limitHistoryPlot(
    observations,
    selectedIndex,
    range,
    Math.max(12, width - 6),
    height
  );
  return (
    <Box flexDirection="column">
      {!short && (
        <Text>{limit.displayName} ({selectedLimit + 1}/{state.limits.length}) · used capacity</Text>
      )}
      <PlotRows rows={plot.rows} color={color} />
      <UsageBandLegend
        kind="history"
        color={color}
        compact={short || width < 100}
        partial={false}
        incomplete={false}
        weekend
      />
      <Text>
        {selected === undefined
          ? 'No observations in this range.'
          : `${formatObservationTime(selected.observedAt)} · ${formatPercent(100 - selected.remainingPercent)} used · ${formatPercent(selected.remainingPercent)} remaining · ${formatReset(selected.resetsAt)}`}
      </Text>
    </Box>
  );
}

function OverviewPanel({
  state,
  color
}: {
  state: DashboardSnapshot;
  color: boolean;
}): React.JSX.Element {
  const summary = state.usageSummary;
  return (
    <Box flexDirection="column">
      <Text>
        <Text {...whenColor(color, 'blue')}>Lifetime</Text>
        {' '}{formatSummaryTokens(summary.lifetimeTokens)}
        {'  ·  '}
        <Text {...whenColor(color, 'yellow')}>Peak day</Text>
        {' '}{formatSummaryTokens(summary.peakDailyTokens)}
      </Text>
      <Text>
        <Text {...whenColor(color, 'blue')}>Current streak</Text>
        {' '}{formatSummaryDays(summary.currentStreakDays)}
        {'  ·  '}
        <Text {...whenColor(color, 'yellow')}>Longest streak</Text>
        {' '}{formatSummaryDays(summary.longestStreakDays)}
      </Text>
      <Text>
        <Text {...whenColor(color, 'magenta')}>Longest-running turn</Text>
        {' '}{formatElapsedSeconds(summary.longestRunningTurnSeconds)}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text bold {...whenColor(color, 'magenta')}>
          Observed today
        </Text>
        <Text>{formatObservedToday(state)}</Text>
        <Text dimColor>{formatLiveUsageDetails(state)}</Text>
        <Text dimColor>
          local observation—not service-accounted daily usage
        </Text>
        <Text dimColor>{formatSourceFreshnessLine(state, false)}</Text>
      </Box>
      <Text dimColor>
        Aggregate account usage reported by Codex; no model attribution or forecast.
      </Text>
    </Box>
  );
}

function LiveObservedActivity({
  state,
  color,
  compact
}: {
  state: DashboardSnapshot;
  color: boolean;
  compact: boolean;
}): React.JSX.Element {
  return (
    <Text {...whenColor(color, state.liveUsage.status === 'unavailable' ? 'yellow' : 'magenta')}>
      {compact ? 'Today' : 'Observed today'} · {compact ? formatObservedTodayCompact(state) : formatObservedToday(state)} · local observation—not service-accounted daily usage
    </Text>
  );
}

function HelpView({color}: {color: boolean}): React.JSX.Element {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold {...whenColor(color, 'cyan')}>My Codex Usage — keys</Text>
      <Text>r         Refresh usage now</Text>
      <Text>l         Sign in with ChatGPT on this Codex connection</Text>
      <Text>Tab       Cycle activity / limit history / overview</Text>
      <Text>d         Cycle seven / thirty / ninety / one-eighty days</Text>
      <Text>w         Toggle daily / weekly activity</Text>
      <Text>← / →     Select a day, week, or history observation</Text>
      <Text>↑ / ↓     Select a limit</Text>
      <Text>?         Return to dashboard</Text>
      <Text>q / Esc   Quit</Text>
      <Text dimColor>
        Activity joins one value per day: service for completed reported days; local for today or service gaps.
      </Text>
      <Text dimColor>
        S service · L local partial · M mixed week. Same-day values are never added.
      </Text>
      <Text dimColor>
        Today is incomplete; W marks Saturday/Sunday UTC. Red means a joined-range peak, not quota exhaustion.
      </Text>
      <Text dimColor>
        Per-limit daily change is partial local observation.
      </Text>
    </Box>
  );
}

function PlotRows({
  rows,
  color
}: {
  rows: PlotRow[];
  color: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {rows.map((row, rowIndex) => (
        <Text key={rowIndex}>
          {row.segments.map((item, segmentIndex) => (
            <Text
              key={`${segmentIndex}|${item.tone}|${item.text.length}`}
              dimColor={item.tone === 'muted'}
              bold={item.bold || item.tone === 'selected'}
              {...plotToneColor(color, item.tone)}
            >
              {item.text}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

function UsageBandLegend({
  kind,
  color,
  compact,
  partial,
  incomplete,
  weekend
}: {
  kind: 'daily' | 'history';
  color: boolean;
  compact: boolean;
  partial: boolean;
  incomplete: boolean;
  weekend: boolean;
}): React.JSX.Element {
  if (compact) {
    return (
      <Text dimColor>
        <Text {...whenColor(color, 'green')}>░≤50</Text>
        {' '}
        <Text {...whenColor(color, 'yellow')}>▒≤75</Text>
        {' '}
        <Text {...whenColor(color, 'red')}>█&gt;75</Text>
        {partial ? ' · ~partial' : ''}
        {incomplete ? ' · !today' : ''}
        {weekend ? ' · Wweekend' : ''}
        {' · '}
        {kind === 'daily' ? 'relative peak; red≠quota' : 'actual used 0–100%'}
      </Text>
    );
  }
  const suffix =
    kind === 'daily'
      ? partial
        ? 'relative peak; red ≠ quota'
        : 'relative peak; red ≠ quota exhaustion'
      : 'actual used; fixed 0–100% scale';
  return (
    <Text dimColor>
      <Text {...whenColor(color, 'green')}>░ ≤50%</Text>
      {' · '}
      <Text {...whenColor(color, 'yellow')}>▒ 50–75%</Text>
      {' · '}
      <Text {...whenColor(color, 'red')}>█ &gt;75%</Text>
      {partial ? ' · ~ partial' : ''}
      {incomplete ? ' · ! incomplete' : ''}
      {weekend ? ' · W weekend' : ''}
      {' · '}{suffix}
    </Text>
  );
}

function JoinedRangeStatisticsLines({
  statistics,
  width,
  short
}: {
  statistics: JoinedRangeUsageStatistics;
  width: number;
  short: boolean;
}): React.JSX.Element {
  const averageValued = formatOptionalStatistic(
    statistics.averagePerValuedPeriod
  );
  const averageActive = formatOptionalStatistic(
    statistics.averagePerActivePeriod
  );
  const minimum = formatJoinedExtremumValue(statistics.minimum);
  const maximum = formatJoinedExtremumValue(statistics.maximum);
  if (short) {
    return (
      <Text dimColor>
        J V{statistics.valuedPeriods}/A{statistics.activePeriods} · S/L/· {statistics.serviceDays}/{statistics.localDays}/{statistics.missingDays}d · T {formatTokens(statistics.totalTokens)} · AvgV/A {averageValued}/{averageActive} · Min {minimum} · Max {maximum}
      </Text>
    );
  }
  if (width >= 80) {
    return (
      <Text dimColor>
        V{statistics.valuedPeriods} A{statistics.activePeriods} · Coverage S{statistics.serviceDays} L{statistics.localDays} missing {statistics.missingDays}/{statistics.inRangeDays}d · Joined total {formatTokens(statistics.totalTokens)} · AvgV {averageValued} AvgA {averageActive} · Min {minimum} Max {maximum}
      </Text>
    );
  }
  return (
    <>
      <Text dimColor>
        Valued {statistics.valuedPeriods} · Active {statistics.activePeriods} · Joined total {formatTokens(statistics.totalTokens)}
      </Text>
      <Text dimColor>
        Coverage: service {statistics.serviceDays}d · local {statistics.localDays}d · missing {statistics.missingDays}/{statistics.inRangeDays}d
      </Text>
      <Text dimColor>
        Avg/valued {averageValued} · Avg/active {averageActive}
      </Text>
      <Text dimColor>Min {minimum} · Max {maximum}</Text>
    </>
  );
}

function preferredJoinedPeriodIndex(
  points: JoinedUsagePeriodPoint[]
): number {
  for (let index = points.length - 1; index >= 0; index--) {
    if (points[index]?.tokens !== undefined) {
      return index;
    }
  }
  return Math.max(0, points.length - 1);
}

function nextRange(range: UsageRange): UsageRange {
  return range === 7
    ? 30
    : range === 30
      ? 90
      : range === 90
        ? 180
        : 7;
}

function nextGranularity(granularity: UsageGranularity): UsageGranularity {
  return granularity === 'day' ? 'week' : 'day';
}

function formatSelectedJoinedPeriod(
  point: JoinedUsagePeriodPoint | undefined,
  statistics: JoinedRangeUsageStatistics
): string {
  if (point === undefined) {
    return 'No selected period.';
  }
  const label = formatPeriodSpan(point);
  if (point.tokens === undefined) {
    return point.isIncomplete
      ? `${label} · incomplete · no joined value · ${point.state === 'pending' ? '? service pending' : '· service unreported'}`
      : `${label} · no joined value · ${point.state === 'pending' ? '? service pending' : '· service unreported'}`;
  }
  const share =
    statistics.totalTokens <= 0
      ? 0
      : (point.tokens / statistics.totalTokens) * 100;
  const source =
    point.source === 'service'
      ? 'S service'
      : point.source === 'local'
        ? 'L local partial'
        : 'M mixed coverage';
  const coverage =
    point.granularity === 'week'
      ? ` · S${point.serviceDayCount}/L${point.localDayCount}/missing ${point.missingDayCount} of ${point.inRangeDayCount} days`
      : '';
  const localCoverage =
    point.localDayCount === 0
      ? ''
      : point.firstSampleAt === undefined || point.latestSampleAt === undefined
        ? ` · ${point.sampleCount} local samples`
        : ` · ${point.sampleCount} local samples · ${point.resetCount} ${point.resetCount === 1 ? 'reset' : 'resets'} · ${formatObservationRange(point.firstSampleAt, point.latestSampleAt)}`;
  const ignoredCurrentService =
    point.granularity === 'day' &&
    point.source === 'local' &&
    point.serviceReportedDayCount > 0
      ? ` · Codex also reported incomplete ${formatExactTokens(point.serviceAvailableTokens)} tokens; not added`
      : '';
  const partial =
    point.state === 'partial' || point.isIncomplete ? ' · partial' : '';
  return `${label} · ${formatExactTokens(point.tokens)} joined tokens · ${source}${coverage}${localCoverage}${ignoredCurrentService}${partial} · ${share.toFixed(1)}% of joined range`;
}

function formatSelectedJoinedCompact(
  point: JoinedUsagePeriodPoint | undefined
): string {
  if (point === undefined) {
    return 'Joined · no selected period';
  }
  const label = formatPeriodSpan(point);
  if (point.tokens === undefined) {
    return `Joined · ${label} · ${point.isIncomplete ? 'incomplete · ' : ''}${
      point.state === 'pending' ? '? pending' : '· missing'
    }`;
  }
  const marker =
    point.source === 'service'
      ? 'S'
      : point.source === 'local'
        ? 'L'
        : 'M';
  const coverage =
    point.granularity === 'week'
      ? ` · S${point.serviceDayCount}/L${point.localDayCount}/·${point.missingDayCount}d`
      : '';
  const partial = point.state === 'partial' ? ' · partial' : '';
  const incomplete = point.isIncomplete ? ' · incomplete' : '';
  return `Joined · ${label} · ${formatExactTokens(point.tokens)} tokens · ${marker}${coverage}${partial}${incomplete}`;
}

function formatObservedChangeCompact(
  limit: NormalizedLimitWindow | undefined,
  change: ObservedPeriodLimitChange | undefined
): string {
  if (limit === undefined) {
    return 'Limit change · unavailable';
  }
  if (change === undefined) {
    return `${limit.displayName} · limit change unavailable · partial local`;
  }
  return `${limit.displayName} · +${formatPoints(change.percentagePoints)}pp · ${change.observationCount} samples · partial local`;
}

function formatObservedChange(
  limit: NormalizedLimitWindow | undefined,
  change: ObservedPeriodLimitChange | undefined
): string {
  if (limit === undefined) {
    return 'No current limit is available for local period observation.';
  }
  if (change === undefined) {
    return `${limit.displayName} · insufficient same-reset local observations`;
  }
  const coverage =
    change.granularity === 'week'
      ? `${change.contributingDayCount}d/${change.observationCount} samples`
      : `${change.observationCount} samples`;
  return `${limit.displayName} · +${formatPoints(change.percentagePoints)}pp observed · ${coverage} · ${formatObservationRange(change.firstObservedAt, change.lastObservedAt)} · partial local`;
}

function calendarGuideRowAdjustment(
  chart: ChartMode,
  granularity: UsageGranularity
): number {
  return chart === 'history' || (chart === 'activity' && granularity === 'day')
    ? 1
    : 0;
}

function formatPeriodSpan(
  point: {startDayKey: string; endDayKey: string}
): string {
  if (point.startDayKey === point.endDayKey) {
    return point.startDayKey;
  }
  if (point.startDayKey.slice(0, 7) === point.endDayKey.slice(0, 7)) {
    return `${point.startDayKey}–${point.endDayKey.slice(8)}`;
  }
  if (point.startDayKey.slice(0, 4) === point.endDayKey.slice(0, 4)) {
    return `${point.startDayKey}–${point.endDayKey.slice(5)}`;
  }
  return `${point.startDayKey}–${point.endDayKey}`;
}

function formatOptionalStatistic(value: number | undefined): string {
  return value === undefined ? 'n/a' : formatTokens(value);
}

function formatExactTokens(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: 'standard',
    maximumFractionDigits: 0
  }).format(value);
}

function formatJoinedExtremumValue(
  value: JoinedRangeUsageStatistics['minimum']
): string {
  if (value === undefined) {
    return 'n/a';
  }
  const marker =
    value.source === 'service'
      ? 'S'
      : value.source === 'local'
        ? 'L'
        : value.source === 'mixed'
          ? 'M'
          : '·';
  return `${formatTokens(value.tokens)} ${marker}`;
}

function formatObservationRange(first: string, last: string): string {
  if (first.slice(0, 10) === last.slice(0, 10)) {
    return `${first.slice(11, 16)}–${last.slice(11, 16)} UTC`;
  }
  return `${first.slice(5, 16).replace('T', ' ')}–${last.slice(5, 16).replace('T', ' ')} UTC`;
}

function formatObservationTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function formatSummaryTokens(value: number | undefined): string {
  return value === undefined ? 'unavailable' : `${formatTokens(value)} tokens`;
}

function formatSummaryDays(value: number | undefined): string {
  return value === undefined ? 'unavailable' : `${value}d`;
}

function formatObservedToday(state: DashboardSnapshot): string {
  const live = state.liveUsage;
  if (live.status === 'disabled') {
    return 'disabled by --no-local';
  }
  if (
    live.todayObservedTokens === undefined ||
    live.todayBaselineAt === undefined ||
    live.todaySampleCount === undefined
  ) {
    return live.status === 'unavailable'
      ? 'unavailable · no local sample for today'
      : 'waiting for today’s first local sample';
  }
  const resetSuffix =
    (live.todayResetCount ?? 0) === 0
      ? ''
      : ` · ${live.todayResetCount} ${live.todayResetCount === 1 ? 'reset' : 'resets'}`;
  return `+${formatTokens(live.todayObservedTokens)} tokens since ${formatUtcClock(live.todayBaselineAt)} UTC · ${live.todaySampleCount} ${live.todaySampleCount === 1 ? 'sample' : 'samples'} · partial local${resetSuffix}`;
}

function formatObservedTodayCompact(state: DashboardSnapshot): string {
  const live = state.liveUsage;
  if (live.status === 'disabled') {
    return 'sampling disabled';
  }
  if (
    live.todayObservedTokens === undefined ||
    live.todaySampleCount === undefined
  ) {
    return live.status === 'unavailable'
      ? 'unavailable'
      : 'awaiting first sample';
  }
  const resets = live.todayResetCount ?? 0;
  return `+${formatTokens(live.todayObservedTokens)} · ${live.todaySampleCount} ${live.todaySampleCount === 1 ? 'sample' : 'samples'} · partial local${resets === 0 ? '' : ` · ${resets} ${resets === 1 ? 'reset' : 'resets'}`}`;
}

function formatLiveUsageDetails(state: DashboardSnapshot): string {
  const live = state.liveUsage;
  if (live.status === 'disabled') {
    return 'Local aggregate sampling is disabled.';
  }
  if (live.status === 'unavailable' && live.aggregateTokens === undefined) {
    return 'Local aggregate source is unavailable.';
  }
  const aggregate =
    live.aggregateTokens === undefined
      ? 'aggregate unavailable'
      : `indexed ${formatTokens(live.aggregateTokens)}`;
  const activity =
    live.latestActivityAt === undefined
      ? 'activity time unavailable'
      : `activity ${formatUpdated(live.latestActivityAt)}`;
  const sampled =
    live.todayLatestSampleAt === undefined
      ? 'sample unavailable'
      : `latest sample ${formatUtcClock(live.todayLatestSampleAt)} UTC`;
  return `${sampled} · ${aggregate} · ${activity}`;
}

function formatUtcClock(iso: string): string {
  return iso.slice(11, 16);
}

function formatSourceFreshnessLine(
  state: DashboardSnapshot,
  compact: boolean
): string {
  const freshness = state.sourceFreshness;
  const limits = formatUpdated(freshness.limitsFetchedAt);
  const usage = formatUpdated(freshness.usageFetchedAt);
  const through = serviceDataThrough(freshness.usageDataThroughDay);
  return compact
    ? `Limits ${limits} · Daily ${usage} · ${through}`
    : `Limits fetched ${limits} · Daily fetched ${usage} · ${through}`;
}

function serviceDataThrough(dayKey: string | undefined): string {
  if (dayKey === undefined) {
    return 'no service bucket';
  }
  const today = Date.parse(
    `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`
  );
  const through = Date.parse(`${dayKey}T00:00:00.000Z`);
  const lagDays = Number.isNaN(through)
    ? undefined
    : Math.max(0, Math.floor((today - through) / 86_400_000));
  return lagDays === undefined || lagDays === 0
    ? `service through ${dayKey}`
    : `service through ${dayKey} · ${lagDays}d lag`;
}

function formatPoints(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function whenColor(
  enabled: boolean,
  color: 'blue' | 'cyan' | 'green' | 'magenta' | 'red' | 'yellow'
): {} | {color: typeof color} {
  return enabled ? {color} : {};
}

function plotToneColor(
  enabled: boolean,
  tone: PlotTone
): {} | {color: 'blue' | 'cyan' | 'green' | 'magenta' | 'red' | 'yellow'} {
  if (!enabled || tone === 'axis' || tone === 'muted') {
    return {};
  }
  const color =
    tone === 'low'
      ? 'green'
      : tone === 'medium'
        ? 'yellow'
      : tone === 'high'
          ? 'red'
          : tone === 'service'
            ? 'blue'
            : tone === 'local'
              ? 'magenta'
              : tone === 'mixed'
                ? 'yellow'
          : 'cyan';
  return {color};
}
