import {useCallback, useEffect, useRef, useState} from 'react';
import {Box, Text, useApp, useInput, useStdout} from 'ink';
import {
  describeUnpricedEstimate,
  estimateCredits,
  summarizeCreditEstimates
} from '../domain/credits.js';
import type {
  TodayUsageSnapshot,
  TodayUsageSource,
  TokenBreakdown
} from '../domain/types.js';

const DEFAULT_REFRESH_INTERVAL_MS = 10_000;
const integer = new Intl.NumberFormat('en-US', {maximumFractionDigits: 0});

type TodayUsageAppProps = {
  source: TodayUsageSource;
  codexHome: string;
  codexVersion: string | undefined;
  color: boolean;
  refreshIntervalMs?: number;
  terminalSize?: {columns: number; rows: number};
};

export function TodayUsageApp({
  source,
  codexHome,
  codexVersion,
  color,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  terminalSize
}: TodayUsageAppProps): React.JSX.Element {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const [snapshot, setSnapshot] = useState<TodayUsageSnapshot | undefined>();
  const [refreshing, setRefreshing] = useState(false);
  const [warning, setWarning] = useState<string | undefined>();
  const [showHelp, setShowHelp] = useState(false);
  const [size, setSize] = useState({
    columns: terminalSize?.columns ?? stdout.columns ?? 80,
    rows: terminalSize?.rows ?? stdout.rows ?? 24
  });
  const mounted = useRef(true);
  const inFlight = useRef<Promise<void> | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current !== undefined) {
      return inFlight.current;
    }
    setRefreshing(true);
    const nextController = new AbortController();
    controller.current = nextController;
    const task = source
      .readToday(codexHome, nextController.signal)
      .then(next => {
        if (!mounted.current) {
          return;
        }
        setSnapshot(current =>
          next.status === 'unavailable' && current?.status === 'ready'
            ? current
            : next
        );
        setWarning(next.warning);
      })
      .catch(() => {
        if (mounted.current) {
          setWarning('Current-day local token metadata is temporarily unavailable.');
        }
      })
      .finally(() => {
        if (mounted.current) {
          setRefreshing(false);
        }
        if (inFlight.current === task) {
          inFlight.current = undefined;
        }
      });
    inFlight.current = task;
    return task;
  }, [codexHome, source]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, refreshIntervalMs);
    timer.unref();
    return () => {
      mounted.current = false;
      clearInterval(timer);
      controller.current?.abort();
    };
  }, [refresh, refreshIntervalMs]);

  useEffect(() => {
    const resized = (): void => {
      if (terminalSize === undefined) {
        setSize({columns: stdout.columns ?? 80, rows: stdout.rows ?? 24});
      }
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
    if (!showHelp && input === 'r') {
      void refresh();
    }
  });

  if (showHelp) {
    return <TodayHelp color={color} />;
  }

  const narrow = size.columns < 180;
  const compact = size.columns < 60 || size.rows < 14;
  return (
    <Box flexDirection="column" paddingX={1} width={size.columns}>
      <Box justifyContent="space-between">
        <Text bold {...colorProps(color, 'cyan')}>
          My Codex Usage · today by project/worktree, model, and effort
        </Text>
        <Text {...colorProps(color, refreshing ? 'yellow' : 'green')}>
          {refreshing ? 'Refreshing…' : snapshot?.status === 'unavailable' ? 'Unavailable' : 'Live'}
        </Text>
      </Box>
      <Text dimColor>
        {snapshot?.dayKey ?? utcDay()} UTC · Codex {codexVersion ?? 'unknown'} · local partial observation
      </Text>
      <Text dimColor>
        Project = final folder · Worktree = Codex-home-relative path · embedded base rates
      </Text>

      {warning !== undefined && (
        <Box marginTop={1}>
          <Text {...colorProps(color, 'yellow')}>{warning}</Text>
        </Box>
      )}
      <Box
        flexDirection="column"
        marginTop={1}
        borderStyle={compact ? undefined : 'round'}
        paddingX={compact ? 0 : 1}
      >
        {snapshot === undefined ? (
          <Text dimColor>Scanning current-day local token events…</Text>
        ) : snapshot.status === 'unavailable' ? (
          <Text dimColor>No readable local Codex session metadata.</Text>
        ) : snapshot.groups.length === 0 ? (
          <Text dimColor>No local token events found for this UTC day.</Text>
        ) : narrow ? (
          <NarrowRows snapshot={snapshot} color={color} compact={compact} />
        ) : (
          <WideTable snapshot={snapshot} color={color} width={size.columns} />
        )}
      </Box>

      {snapshot !== undefined && (
        <Box marginTop={compact ? 0 : 1} flexDirection="column">
          <Text>
            <Text bold {...colorProps(color, 'cyan')}>TOTAL</Text>
            {' · '}{formatBreakdown(snapshot.total)}
          </Text>
          <CreditSummary snapshot={snapshot} color={color} />
          <Text dimColor>
            {snapshot.tokenEventCount} events · {snapshot.scannedFileCount} files · {snapshot.skippedRecordCount} skipped records · {snapshot.skippedFileCount} skipped files · scanned {formatUtcTime(snapshot.sampledAt)}
          </Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          Local partial snapshot—not service-accounted · credit estimate is not an invoice · r refresh · ? help · q quit
        </Text>
      </Box>
    </Box>
  );
}

function WideTable({
  snapshot,
  color,
  width
}: {
  snapshot: TodayUsageSnapshot;
  color: boolean;
  width: number;
}): React.JSX.Element {
  const projectWidth = Math.max(14, Math.min(24, Math.floor(width * 0.14)));
  const worktreeWidth = Math.max(26, Math.min(42, Math.floor(width * 0.2)));
  const modelWidth = Math.max(18, Math.min(26, Math.floor(width * 0.14)));
  const effortWidth = 9;
  const numberWidth = 13;
  const creditWidth = 13;
  const format = formatExact;
  return (
    <Box flexDirection="column">
      <Text bold>
        {'Project'.padEnd(projectWidth)} {'Worktree'.padEnd(worktreeWidth)}{' '}
        {'Model'.padEnd(modelWidth)}{' '}
        {'Effort'.padEnd(effortWidth)}{' '}
        {'Input'.padStart(numberWidth)} {'Cached'.padStart(numberWidth)}{' '}
        {'Output'.padStart(numberWidth)} {'Reason'.padStart(numberWidth)}{' '}
        {'Credits'.padStart(creditWidth)}
      </Text>
      {snapshot.groups.map(group => {
        const estimate = estimateCredits(group.model, group);
        return <Text key={`${group.projectFolder}\u0000${group.worktreePath ?? ''}\u0000${group.model}\u0000${group.effort}`} wrap="truncate">
          <Text bold {...colorProps(color, 'cyan')}>
            {truncate(group.projectFolder, projectWidth).padEnd(projectWidth)}
          </Text>{' '}
          <Text dimColor>
            {truncate(group.worktreePath ?? '—', worktreeWidth).padEnd(worktreeWidth)}
          </Text>{' '}
          <Text {...colorProps(color, 'blue')}>
            {truncate(group.model, modelWidth).padEnd(modelWidth)}
          </Text>{' '}
          <Text {...colorProps(color, 'magenta')}>
            {truncate(group.effort, effortWidth).padEnd(effortWidth)}
          </Text>{' '}
          {format(group.inputTokens).padStart(numberWidth)}{' '}
          <Text {...colorProps(color, 'yellow')}>
            {format(group.cachedInputTokens).padStart(numberWidth)}
          </Text>{' '}
          <Text {...colorProps(color, 'green')}>
            {format(group.outputTokens).padStart(numberWidth)}
          </Text>{' '}
          <Text {...colorProps(color, 'magenta')}>
            {format(group.reasoningOutputTokens).padStart(numberWidth)}
          </Text>{' '}
          <Text {...colorProps(color, estimate.status === 'estimated' ? 'green' : 'yellow')}>
            {formatCreditEstimate(estimate).padStart(creditWidth)}
          </Text>
        </Text>;
      })}
    </Box>
  );
}

function NarrowRows({
  snapshot,
  color,
  compact
}: {
  snapshot: TodayUsageSnapshot;
  color: boolean;
  compact: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {snapshot.groups.map((group, index) => (
        <Box
          key={`${group.projectFolder}\u0000${group.worktreePath ?? ''}\u0000${group.model}\u0000${group.effort}`}
          flexDirection="column"
          marginTop={index === 0 || compact ? 0 : 1}
        >
          <Text>
            <Text bold {...colorProps(color, 'cyan')}>{group.projectFolder}</Text>
            {' · '}
            <Text {...colorProps(color, 'blue')}>{group.model}</Text>
            {' · '}
            <Text {...colorProps(color, 'magenta')}>{group.effort}</Text>
            {' · '}{group.eventCount} {group.eventCount === 1 ? 'event' : 'events'}
          </Text>
          {group.worktreePath !== undefined && (
            <Text dimColor>Worktree {group.worktreePath} · relative to Codex home</Text>
          )}
          <Text>
            Input {formatExact(group.inputTokens)} ·{' '}
            <Text {...colorProps(color, 'yellow')}>Cached {formatExact(group.cachedInputTokens)}</Text>
          </Text>
          <Text>
            <Text {...colorProps(color, 'green')}>Output {formatExact(group.outputTokens)}</Text>
            {' · '}
            <Text {...colorProps(color, 'magenta')}>Reasoning {formatExact(group.reasoningOutputTokens)}</Text>
          </Text>
          <Text {...colorProps(color, estimateCredits(group.model, group).status === 'estimated' ? 'green' : 'yellow')}>
            Credits {formatCreditEstimate(estimateCredits(group.model, group))} · base-rate estimate
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function TodayHelp({color}: {color: boolean}): React.JSX.Element {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold {...colorProps(color, 'cyan')}>
        My Codex Usage — current-day keys
      </Text>
      <Text>r          Refresh local token events now</Text>
      <Text>?          Close this help</Text>
      <Text>q / Escape Quit and restore the terminal</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Scope: current UTC day, local session events only.</Text>
        <Text dimColor>Rows group project, managed-worktree path, exact model, and reasoning effort.</Text>
        <Text dimColor>Worktree paths are relative to Codex home; local checkouts show no path.</Text>
        <Text dimColor>Absolute and unrelated parent paths are never displayed or persisted.</Text>
        <Text dimColor>Cached is an Input subset; Reasoning is an Output subset.</Text>
        <Text dimColor>Credits = uncached input + cached input + output at the matched per-million rates.</Text>
        <Text dimColor>Cache-write and reasoning counters are not charged a second time.</Text>
        <Text dimColor>Rates (input/cached/output):</Text>
        <Text dimColor>Sol & Daybreak Blue 125/12.5/750 · Daybreak Red 312.5/31.25/1875</Text>
        <Text dimColor>Terra 50/5/300 · Luna 5/0.5/30 · GPT-5.5 125/12.5/750</Text>
        <Text dimColor>GPT-5.4 62.5/6.25/375 · mini 18.75/1.875/113</Text>
        <Text dimColor>GPT-Image-2 image 200/50/750 · text 125/31.25/250</Text>
        <Text dimColor>GPT-5.3-Codex-Spark is research preview; unknown models stay unpriced.</Text>
        <Text dimColor>No detailed token rows are persisted or added to service usage.</Text>
      </Box>
    </Box>
  );
}

function formatBreakdown(value: TokenBreakdown): string {
  return `Input ${formatExact(value.inputTokens)} · Cached ${formatExact(value.cachedInputTokens)} · Output ${formatExact(value.outputTokens)} · Reasoning ${formatExact(value.reasoningOutputTokens)}`;
}

function CreditSummary({
  snapshot,
  color
}: {
  snapshot: TodayUsageSnapshot;
  color: boolean;
}): React.JSX.Element {
  const summary = summarizeCreditEstimates(snapshot.groups);
  if (summary.pricedGroupCount === 0) {
    return <Text {...colorProps(color, 'yellow')}>Estimated credits unavailable for all model groups</Text>;
  }
  const suffix = summary.unpricedGroupCount === 0
    ? ''
    : ` · ${summary.unpricedGroupCount} unpriced ${summary.unpricedGroupCount === 1 ? 'group' : 'groups'}`;
  return (
    <Text {...colorProps(color, 'green')}>
      {summary.unpricedGroupCount === 0 ? 'Estimated base credits' : 'Priced-groups credit subtotal'} ~{formatCredits(summary.estimatedCredits)}{suffix}
    </Text>
  );
}

function formatCreditEstimate(
  estimate: ReturnType<typeof estimateCredits>
): string {
  return estimate.status === 'estimated'
    ? `~${formatCredits(estimate.totalCredits)}`
    : describeUnpricedEstimate(estimate);
}

function formatCredits(value: number): string {
  if (value > 0 && value < 0.0001) {
    return '<0.0001';
  }
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4
  }).format(value);
}

function formatExact(value: number): string {
  return integer.format(value);
}

function formatUtcTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'unknown';
  }
  return `${parsed.toISOString().slice(11, 19)} UTC`;
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function truncate(value: string, width: number): string {
  return value.length <= width
    ? value
    : `${value.slice(0, Math.max(1, width - 1))}…`;
}

function colorProps(
  enabled: boolean,
  color: 'blue' | 'cyan' | 'green' | 'magenta' | 'yellow'
): {color?: typeof color} {
  return enabled ? {color} : {};
}
