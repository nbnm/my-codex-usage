import type {TodayUsageSnapshot} from '../domain/types.js';
import {
  describeUnpricedEstimate,
  estimateCredits,
  summarizeCreditEstimates
} from '../domain/credits.js';

const integer = new Intl.NumberFormat('en-US', {maximumFractionDigits: 0});

export function renderTodayPlain(
  snapshot: TodayUsageSnapshot,
  codexVersion: string | undefined
): string {
  const lines = [
    'My Codex Usage — current-day token breakdown',
    `UTC day: ${snapshot.dayKey}`,
    `Codex: ${codexVersion ?? 'unknown'} · scanned ${snapshot.sampledAt}`,
    'Source: local Codex session token events · partial, not service-accounted usage',
    `Coverage: ${snapshot.scannedFileCount} files · ${snapshot.tokenEventCount} token events · ${snapshot.skippedRecordCount} skipped records · ${snapshot.skippedFileCount} skipped files`
  ];

  if (snapshot.status === 'unavailable') {
    lines.push('', snapshot.warning ?? 'Local token metadata is unavailable.');
    return `${lines.join('\n')}\n`;
  }
  if (snapshot.warning !== undefined) {
    lines.push(`Warning: ${snapshot.warning}`);
  }
  lines.push('');
  if (snapshot.groups.length === 0) {
    lines.push('No local token events were found for the current UTC day.');
  } else {
    lines.push(...renderTable(snapshot));
  }
  lines.push(
    '',
    'Each token field is aggregated independently across local events.',
    'Protocol total is displayed directly; it is not recomputed from detail columns.',
    'Credits are a partial base-rate estimate: (input - cached) + cached + output at the matched model rates.',
    'Cache-write and reasoning counters are not charged again; service adjustments may differ.',
    'Cloud-only, ephemeral, deleted, unavailable, and not-yet-flushed activity may be absent.'
  );
  return `${lines.join('\n')}\n`;
}

export function todayPlainExitCode(snapshot: TodayUsageSnapshot): 0 | 1 {
  return snapshot.status === 'ready' ? 0 : 1;
}

function renderTable(snapshot: TodayUsageSnapshot): string[] {
  const rows = snapshot.groups.map(group => {
    const estimate = estimateCredits(group.model, group);
    return [
      group.model,
      group.effort,
      formatInteger(group.inputTokens),
      formatInteger(group.cachedInputTokens),
      formatInteger(group.cacheWriteInputTokens),
      formatInteger(group.outputTokens),
      formatInteger(group.reasoningOutputTokens),
      formatInteger(group.totalTokens),
      estimate.status === 'estimated'
        ? `~${formatCredits(estimate.totalCredits)}`
        : describeUnpricedEstimate(estimate),
      formatInteger(group.eventCount)
    ];
  });
  const summary = summarizeCreditEstimates(snapshot.groups);
  rows.push([
    'TOTAL',
    '—',
    formatInteger(snapshot.total.inputTokens),
    formatInteger(snapshot.total.cachedInputTokens),
    formatInteger(snapshot.total.cacheWriteInputTokens),
    formatInteger(snapshot.total.outputTokens),
    formatInteger(snapshot.total.reasoningOutputTokens),
    formatInteger(snapshot.total.totalTokens),
    summary.pricedGroupCount === 0
      ? 'unpriced'
      : `~${formatCredits(summary.estimatedCredits)}${summary.unpricedGroupCount > 0 ? '*' : ''}`,
    formatInteger(snapshot.tokenEventCount)
  ]);
  const headers = [
    'Model',
    'Effort',
    'Input',
    'Cached input',
    'Cache write',
    'Output',
    'Reasoning output',
    'Total',
    'Est. credits',
    'Events'
  ];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => row[index]?.length ?? 0))
  );
  const formatRow = (row: readonly string[]): string =>
    row
      .map((value, index) =>
        index < 2
          ? value.padEnd(widths[index] ?? value.length)
          : value.padStart(widths[index] ?? value.length)
      )
      .join('  ');
  const summaryLabel = summary.pricedGroupCount === 0
    ? 'Estimated credits: unavailable for all model groups'
    : summary.unpricedGroupCount === 0
      ? `Estimated base credits: ~${formatCredits(summary.estimatedCredits)}`
      : `Priced-groups credit subtotal: ~${formatCredits(summary.estimatedCredits)} · ${summary.unpricedGroupCount} unpriced ${summary.unpricedGroupCount === 1 ? 'group' : 'groups'}`;
  return [
    formatRow(headers),
    widths.map(width => '─'.repeat(width)).join('  '),
    ...rows.map(formatRow),
    '',
    summaryLabel
  ];
}

function formatInteger(value: number): string {
  return integer.format(value);
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
