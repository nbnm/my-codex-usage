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
      projectFolder: 'my-codex-usage',
      worktreePath: 'worktrees/fixture-worktree/my-codex-usage',
      model: 'gpt-5.6-sol',
      effort: 'high',
      eventCount: 2,
      inputTokens: 100,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 7,
      outputTokens: 20,
      reasoningOutputTokens: 10,
      totalTokens: 135
    }
  ],
  total: {
    inputTokens: 100,
    cachedInputTokens: 80,
    cacheWriteInputTokens: 7,
    outputTokens: 20,
    reasoningOutputTokens: 10,
    totalTokens: 135
  },
  scannedFileCount: 1,
  tokenEventCount: 2,
  skippedRecordCount: 0,
  skippedFileCount: 0,
  warning: undefined
};

describe('current-day plain output', () => {
  it('prints only the selected grouped counters without ANSI', () => {
    const output = renderTodayPlain(snapshot, '0.146.1');
    expect(output).toContain('current-day token breakdown');
    expect(output).toContain('Project');
    expect(output).toContain('Worktree path (Codex-home-relative)');
    expect(output).toContain('worktrees/fixture-worktree/my-codex-usage');
    expect(output).toContain('my-codex-usage');
    expect(output).toContain('relative to Codex home only');
    expect(output).toContain('gpt-5.6-sol');
    expect(output).toContain('Cached input');
    expect(output).toContain('Reasoning output');
    expect(output).not.toMatch(/\bWrite\b/u);
    expect(output).not.toContain('Counted');
    expect(output).not.toContain('Protocol');
    expect(output).not.toContain('Unattrib');
    expect(output).toContain('Est. credits');
    expect(output).toContain('~0.0185');
    expect(output).toContain('Estimated base credits');
    expect(output).toContain('Reasoning is not charged again');
    expect(output).not.toMatch(/\u001b\[/u);
    expect(output).not.toContain('/Volumes/Work');
    expect(output).not.toContain('/Users/example');
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
