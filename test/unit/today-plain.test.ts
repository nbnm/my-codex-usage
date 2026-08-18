import {describe, expect, it} from 'vitest';
import type {TodayUsageSnapshot} from '../../src/domain/types.js';
import {
  renderTodayPlain,
  todayPlainExitCode
} from '../../src/plain/today.js';

const snapshot: TodayUsageSnapshot = {
  status: 'ready',
  dayKey: '2026-08-17',
  sampledAt: '2026-08-17T14:00:00.000Z',
  groups: [
    {
      model: 'gpt-5.6-sol',
      effort: 'high',
      eventCount: 2,
      inputTokens: 100,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 7,
      outputTokens: 20,
      reasoningOutputTokens: 10,
      totalTokens: 120
    }
  ],
  total: {
    inputTokens: 100,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 7,
    outputTokens: 20,
    reasoningOutputTokens: 10,
    totalTokens: 120
  },
  scannedFileCount: 1,
  tokenEventCount: 2,
  skippedRecordCount: 0,
  skippedFileCount: 0,
  warning: undefined
};

describe('current-day plain output', () => {
  it('prints exact grouped counters without ANSI or cross-column total arithmetic', () => {
    const output = renderTodayPlain(snapshot, '0.146.1');
    expect(output).toContain('current-day token breakdown');
    expect(output).toContain('gpt-5.6-sol');
    expect(output).toContain('Cached input');
    expect(output).toContain('Cache write');
    expect(output).toContain('Reasoning output');
    expect(output).toContain('Est. credits');
    expect(output).toContain('~0.0185');
    expect(output).toContain('Estimated base credits');
    expect(output).toContain('Cache-write and reasoning counters are not charged again');
    expect(output).toContain('120');
    expect(output).toContain('not recomputed from detail columns');
    expect(output).not.toMatch(/\u001b\[/u);
    expect(todayPlainExitCode(snapshot)).toBe(0);
  });

  it('labels unknown models and priced-only subtotals without fabricating a rate', () => {
    const mixed: TodayUsageSnapshot = {
      ...snapshot,
      groups: [
        ...(snapshot.groups),
        {...snapshot.groups[0]!, model: 'future-model'}
      ]
    };
    const output = renderTodayPlain(mixed, '0.146.1');
    expect(output).toContain('rate unavailable');
    expect(output).toContain('Priced-groups credit subtotal');
    expect(output).toContain('1 unpriced group');
  });

  it('uses exit one for unavailable local metadata', () => {
    const unavailable: TodayUsageSnapshot = {
      ...snapshot,
      status: 'unavailable',
      groups: [],
      warning: 'Local Codex session metadata is unavailable.'
    };
    expect(renderTodayPlain(unavailable, undefined)).toContain('unavailable');
    expect(todayPlainExitCode(unavailable)).toBe(1);
  });
});
