import {cleanup, render} from 'ink-testing-library';
import {afterEach, describe, expect, it} from 'vitest';
import type {
  TodayUsageSnapshot,
  TodayUsageSource
} from '../../src/domain/types.js';
import {TodayUsageApp} from '../../src/tui/TodayUsageApp.js';

const snapshot: TodayUsageSnapshot = {
  status: 'ready',
  dayKey: '2026-08-17',
  sampledAt: '2026-08-17T14:00:00.000Z',
  groups: [
    {
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      eventCount: 3,
      inputTokens: 12_345,
      cachedInputTokens: 10_000,
      cacheWriteInputTokens: 123,
      outputTokens: 678,
      reasoningOutputTokens: 456,
      totalTokens: 13_023
    }
  ],
  total: {
    inputTokens: 12_345,
    cachedInputTokens: 10_000,
    cacheWriteInputTokens: 123,
    outputTokens: 678,
    reasoningOutputTokens: 456,
    totalTokens: 13_023
  },
  scannedFileCount: 2,
  tokenEventCount: 3,
  skippedRecordCount: 0,
  skippedFileCount: 0,
  warning: undefined
};

class FakeTodaySource implements TodayUsageSource {
  calls = 0;

  readToday(): Promise<TodayUsageSnapshot> {
    this.calls++;
    return Promise.resolve(snapshot);
  }
}

afterEach(() => {
  cleanup();
});

describe('TodayUsageApp', () => {
  it('renders all token types in the adaptive current-day view', async () => {
    const source = new FakeTodaySource();
    const app = render(
      <TodayUsageApp
        source={source}
        codexHome="fixture-home"
        codexVersion="0.146.1"
        color={false}
        terminalSize={{columns: 80, rows: 24}}
      />
    );
    await settle();
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('today by model and effort');
    expect(frame).toContain('gpt-5.6-sol · xhigh');
    expect(frame).toContain('Input 12,345');
    expect(frame).toContain('Cached 10,000');
    expect(frame).toContain('Write 123');
    expect(frame).toContain('Output 678');
    expect(frame).toContain('Reasoning 456');
    expect(frame).toContain('Total 13,023');
    expect(frame).toContain('Credits ~0.9266');
    expect(frame).toContain('Estimated base credits ~0.9266');
    expect(frame).toContain('not service-accounted');
    expect(frame).not.toMatch(/\u001b\[/u);
  });

  it('renders a wide table, handles refresh/help, and automatically refreshes', async () => {
    const source = new FakeTodaySource();
    const app = render(
      <TodayUsageApp
        source={source}
        codexHome="fixture-home"
        codexVersion="0.146.1"
        color={false}
        refreshIntervalMs={10}
        terminalSize={{columns: 150, rows: 30}}
      />
    );
    await settle(2);
    expect(app.lastFrame()).toContain('Cached');
    expect(app.lastFrame()).toContain('Reason');
    expect(app.lastFrame()).toContain('Credits');

    app.stdin.write('r');
    await settle(2);
    expect(source.calls).toBeGreaterThanOrEqual(2);

    app.stdin.write('?');
    await settle();
    expect(app.lastFrame()).toContain('current-day keys');
    expect(app.lastFrame()).toContain('current UTC day');

    app.stdin.write('?');
    await settle(15);
    expect(source.calls).toBeGreaterThanOrEqual(3);
  });

  it('keeps the latest valid table when a later scan is unavailable', async () => {
    let calls = 0;
    const source: TodayUsageSource = {
      readToday: () => {
        calls++;
        return Promise.resolve(
          calls === 1
            ? snapshot
            : {
                ...snapshot,
                status: 'unavailable',
                groups: [],
                warning: 'Local Codex session metadata is unavailable.'
              }
        );
      }
    };
    const app = render(
      <TodayUsageApp
        source={source}
        codexHome="fixture-home"
        codexVersion="0.146.1"
        color={false}
        refreshIntervalMs={60_000}
        terminalSize={{columns: 80, rows: 24}}
      />
    );
    await settle();
    expect(app.lastFrame()).toContain('gpt-5.6-sol');
    app.stdin.write('r');
    await settle();
    expect(app.lastFrame()).toContain('gpt-5.6-sol');
    expect(app.lastFrame()).toContain('session metadata is unavailable');
  });
});

function settle(milliseconds: number = 0): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
