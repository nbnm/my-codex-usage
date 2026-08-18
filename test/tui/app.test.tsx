import {cleanup, render} from 'ink-testing-library';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {AppError} from '../../src/domain/errors.js';
import type {
  DashboardSnapshot,
  RefreshTrigger,
  UsageRefreshCoordinator
} from '../../src/domain/types.js';
import {UsageApp} from '../../src/tui/App.js';

const state: DashboardSnapshot = {
  status: 'fresh',
  usageSummary: {
    lifetimeTokens: 1_234,
    currentStreakDays: 4,
    longestStreakDays: 13,
    peakDailyTokens: 456,
    longestRunningTurnSeconds: 5_375
  },
  limits: [
    {
      key: 'codex|primary|300',
      limitId: 'codex',
      limitName: 'Codex',
      windowKind: 'primary',
      durationMinutes: 300,
      usedPercent: 28,
      remainingPercent: 72,
      resetsAt: '2030-03-17T17:46:40.000Z',
      planType: 'plus',
      reachedLimitType: undefined,
      displayName: 'Codex'
    }
  ],
  dailyUsage: [
    {
      dayKey: new Date().toISOString().slice(0, 10),
      tokens: 456,
      fetchedAt: new Date().toISOString()
    }
  ],
  localUsageDays: [
    localObservation(new Date().toISOString().slice(0, 10), 456, 2)
  ],
  limitHistory: [
    {
      hourKey: new Date().toISOString().slice(0, 13),
      observedAt: new Date().toISOString(),
      limitKey: 'codex|primary|300',
      limitId: 'codex',
      displayName: 'Codex',
      windowKind: 'primary',
      durationMinutes: 300,
      remainingPercent: 72,
      resetsAt: '2030-03-17T17:46:40.000Z'
    }
  ],
  lastAttemptAt: new Date().toISOString(),
  lastSuccessfulAt: new Date().toISOString(),
  codexVersion: '0.144.3',
  planType: 'plus',
  authenticationState: 'chatgpt',
  sourceFreshness: {
    limitsFetchedAt: new Date().toISOString(),
    usageFetchedAt: new Date().toISOString(),
    usageDataThroughDay: new Date().toISOString().slice(0, 10)
  },
  liveUsage: {
    status: 'observed',
    aggregateTokens: 12_345,
    deltaTokens: 456,
    intervalStartedAt: new Date(Date.now() - 60_000).toISOString(),
    sampledAt: new Date().toISOString(),
    latestActivityAt: new Date().toISOString(),
    todayDayKey: new Date().toISOString().slice(0, 10),
    todayObservedTokens: 456,
    todayBaselineAt: new Date(Date.now() - 60_000).toISOString(),
    todayLatestSampleAt: new Date().toISOString(),
    todayCoverageStartedAt: new Date(Date.now() - 60_000).toISOString(),
    todaySampleCount: 2,
    todayResetCount: 0
  },
  warning: undefined,
  isRefreshing: false
};

class FakeCoordinator implements UsageRefreshCoordinator {
  refreshes: RefreshTrigger[] = [];
  loginStarts = 0;
  loginCompletions = 0;
  private readonly refreshState: DashboardSnapshot;
  private readonly loginState: DashboardSnapshot;

  constructor(
    refreshState: DashboardSnapshot = state,
    loginState: DashboardSnapshot = state
  ) {
    this.refreshState = refreshState;
    this.loginState = loginState;
  }

  loadCached(): Promise<DashboardSnapshot> {
    return Promise.resolve(this.refreshState);
  }

  refresh(trigger: RefreshTrigger): Promise<DashboardSnapshot> {
    this.refreshes.push(trigger);
    return Promise.resolve(this.refreshState);
  }

  startChatGPTLogin(): Promise<{authUrl: string; loginId: string}> {
    this.loginStarts++;
    return Promise.resolve({
      authUrl: 'https://example.invalid/authorize',
      loginId: 'fixture-login'
    });
  }

  waitForLoginCompletion(): Promise<DashboardSnapshot> {
    this.loginCompletions++;
    return Promise.resolve(this.loginState);
  }

  startAutomaticRefresh(): void {}

  close(): Promise<void> {
    return Promise.resolve();
  }
}

afterEach(() => {
  cleanup();
});

describe('UsageApp', () => {
  it('renders current limits and switches chart/range/help from the keyboard', async () => {
    const coordinator = new FakeCoordinator();
    const app = render(
      <UsageApp
        coordinator={coordinator}
        initialState={state}
        initialRange={7}
        color={false}
      />
    );
    await settle();
    expect(app.lastFrame()).toContain('My Codex Usage');
    expect(app.lastFrame()).toContain('72% remaining');
    expect(app.lastFrame()).toContain('Joined token activity · 7');
    expect(app.lastFrame()).toContain('L');
    expect(app.lastFrame()).toContain('456 tokens');
    expect(app.lastFrame()).toContain('Today · +456');
    expect(app.lastFrame()).toContain('2 samples');
    expect(app.lastFrame()).toContain('partial local');
    expect(app.lastFrame()).toContain(
      'local observation—not service-accounted daily usage'
    );
    expect(app.lastFrame()).toContain('service through');

    app.stdin.write('\t');
    await settle();
    expect(app.lastFrame()).toContain('Limit history · 7 days');

    app.stdin.write('d');
    await settle();
    expect(app.lastFrame()).toContain('Limit history · 30 days');

    app.stdin.write('\t');
    await settle();
    expect(app.lastFrame()).toContain('Usage overview · account lifetime');
    expect(app.lastFrame()).toContain('Current streak');
    expect(app.lastFrame()).toContain('Observed today');

    app.stdin.write('\t');
    app.stdin.write('d');
    await settle();
    expect(app.lastFrame()).toContain('Joined token activity · 90');
    app.stdin.write('d');
    await settle();
    expect(app.lastFrame()).toContain('Joined token activity · 180');
    app.stdin.write('d');
    await settle();
    expect(app.lastFrame()).toContain('Joined token activity · 7');
    app.stdin.write('w');
    await settle();
    expect(app.lastFrame()).toContain(
      'Joined token activity · 7d weekly'
    );

    app.stdin.write('?');
    await settle();
    expect(app.lastFrame()).toContain('My Codex Usage — keys');
    expect(app.lastFrame()).toContain('Toggle daily / weekly activity');
    expect(app.lastFrame()).toContain(
      'Activity joins one value per day'
    );
    expect(app.lastFrame()).not.toContain(
      'Switch service / local Activity source'
    );
  });

  it('requests a manual refresh when r is pressed', async () => {
    const coordinator = new FakeCoordinator();
    const app = render(
      <UsageApp
        coordinator={coordinator}
        initialState={state}
        initialRange={7}
        color={false}
      />
    );
    await settle();
    app.stdin.write('r');
    await settle();
    expect(coordinator.refreshes).toContain('manual');
  });

  it('uses a compact text layout in a small terminal', async () => {
    const app = render(
      <UsageApp
        coordinator={new FakeCoordinator()}
        initialState={state}
        initialRange={7}
        color={false}
        terminalSize={{columns: 50, rows: 12}}
      />
    );
    await settle();
    expect(app.lastFrame()).toContain('Resize to at least 60×16');
    expect(app.lastFrame()).toContain('2 samples');
    expect(app.lastFrame()).toContain('partial local');
    expect(app.lastFrame()).not.toContain('Daily activity · 7 days');
  });

  it('keeps the joined Activity plot visible at the 80×16 chart boundary', async () => {
    const app = render(
      <UsageApp
        coordinator={new FakeCoordinator()}
        initialState={state}
        initialRange={30}
        color={false}
        terminalSize={{columns: 80, rows: 16}}
      />
    );
    await settle();
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('Joined token activity · 30d');
    expect(frame).toContain('L');
    const plotRows =
      frame
        .split('\n')
        .filter(
          line =>
            /[░▒█]/u.test(line) &&
            (line.includes('┤') || line.includes('│'))
        );
    expect(plotRows.length).toBeGreaterThanOrEqual(3);
    expect(plotRows.length).toBeLessThanOrEqual(6);
    expect(frame.split('\n').length).toBeLessThanOrEqual(16);
  });

  it('keeps service values usable when local history is empty', async () => {
    const noLocalState: DashboardSnapshot = {
      ...state,
      localUsageDays: [],
      liveUsage: {status: 'disabled'}
    };
    const app = render(
      <UsageApp
        coordinator={new FakeCoordinator(noLocalState)}
        initialState={noLocalState}
        initialRange={30}
        color={false}
        terminalSize={{columns: 120, rows: 40}}
      />
    );
    await settle();
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('Joined token activity · 30 days');
    expect(frame).toContain('S service');
    expect(frame).toContain(
      'Local sampling disabled; retained history may fill gaps.'
    );
  });

  it('shows current local selection and discloses the ignored incomplete service value', async () => {
    const app = render(
      <UsageApp
        coordinator={new FakeCoordinator()}
        initialState={state}
        initialRange={7}
        color={false}
        terminalSize={{columns: 140, rows: 40}}
      />
    );
    await settle();
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('L local partial');
    expect(frame).toContain('Codex also reported incomplete 456');
    expect(frame).toContain('tokens; not added');
    app.stdin.write('\t');
    app.stdin.write('\t');
    await settle();
    expect(app.lastFrame()).toContain('Lifetime 1,234 tokens');
  });

  it('selects today with a local observation while keeping the service bucket absent', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const localToday: DashboardSnapshot = {
      ...state,
      dailyUsage: [
        {
          dayKey: yesterday,
          tokens: 456,
          fetchedAt: new Date().toISOString()
        }
      ]
    };
    const app = render(
      <UsageApp
        coordinator={new FakeCoordinator(localToday)}
        initialState={localToday}
        initialRange={7}
        color={false}
        terminalSize={{columns: 120, rows: 40}}
      />
    );
    await settle();
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain(`${today} · 456 joined tokens · L local partial`);
    expect(frame).toContain('Observed today · +456 tokens since');
    expect(frame).toContain('Coverage S1 L1');
  });

  it('moves the default selection to today when the first local sample arrives', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const initial: DashboardSnapshot = {
      ...state,
      dailyUsage: [
        {
          dayKey: yesterday,
          tokens: 456,
          fetchedAt: new Date().toISOString()
        }
      ],
      localUsageDays: [],
      liveUsage: {status: 'unavailable'}
    };
    const refreshed: DashboardSnapshot = {
      ...initial,
      localUsageDays: [localObservation(today, 0, 1)],
      liveUsage: state.liveUsage
    };
    const app = render(
      <UsageApp
        coordinator={new FakeCoordinator(refreshed)}
        initialState={initial}
        initialRange={7}
        color={false}
        terminalSize={{columns: 120, rows: 40}}
      />
    );
    await settle(10);
    expect(app.lastFrame()).toContain(
      `${today} · 0 joined tokens · L local partial`
    );
  });

  it('joins lagging service and newer local history without a source switch', async () => {
    const yesterday = new Date(Date.now() - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const olderServiceDay = new Date(Date.now() - 3 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const lagging: DashboardSnapshot = {
      ...state,
      dailyUsage: [
        {
          dayKey: olderServiceDay,
          tokens: 456,
          fetchedAt: new Date().toISOString()
        }
      ],
      localUsageDays: [localObservation(yesterday, 12_345, 166)],
      liveUsage: {status: 'unavailable'},
      sourceFreshness: {
        ...state.sourceFreshness,
        usageDataThroughDay: olderServiceDay
      }
    };
    const coordinator = new FakeCoordinator(lagging);
    const app = render(
      <UsageApp
        coordinator={coordinator}
        initialState={lagging}
        initialRange={7}
        color={false}
        terminalSize={{columns: 120, rows: 40}}
      />
    );
    await settle();
    expect(app.lastFrame()).toContain('Joined token activity · 7 days');
    expect(app.lastFrame()).toContain(
      `${yesterday} · 12,345 joined tokens · L local partial`
    );
    expect(app.lastFrame()).toContain('166 local samples');
    expect(app.lastFrame()).toContain('L local partial');

    const combinedFrame = app.lastFrame();
    app.stdin.write('s');
    await settle();
    expect(app.lastFrame()).toBe(combinedFrame);
    app.stdin.write('r');
    await settle();
    expect(app.lastFrame()).toContain('Joined token activity · 7 days');
    app.stdin.write('d');
    app.stdin.write('w');
    await settle();
    expect(app.lastFrame()).toContain(
      'Joined token activity · 30 days · weekly'
    );
  });

  it('renders the ninety-day view at 80×24 without losing exact text', async () => {
    const app = render(
      <UsageApp
        coordinator={new FakeCoordinator()}
        initialState={state}
        initialRange={90}
        color={false}
        terminalSize={{columns: 80, rows: 24}}
      />
    );
    await settle();
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('Joined token activity · 90d');
    expect(frame).toContain('456 tokens');
    expect(frame).toContain('red≠quota');
    expect(frame).toContain('‹');
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    expect(
      Math.max(
        ...frame
          .split('\n')
          .filter(line => /[░▒█]/u.test(line))
          .map(line => line.length)
      )
    ).toBeGreaterThanOrEqual(70);
  });

  it('renders weekly 180-day usage with coverage, extrema, and partial notation', async () => {
    const firstLimit = state.limits[0];
    if (firstLimit === undefined) {
      throw new Error('Weekly layout fixture requires a limit.');
    }
    const weeklyState: DashboardSnapshot = {
      ...state,
      dailyUsage: [
        {
          dayKey: '2026-06-01',
          tokens: 999,
          fetchedAt: '2026-06-01T12:00:00.000Z'
        },
        ...state.dailyUsage
      ],
      limits: [
        firstLimit,
        {
          ...firstLimit,
          key: 'spark|primary|10080',
          limitId: 'spark',
          limitName: 'Spark',
          displayName: 'Spark'
        }
      ]
    };
    const app = render(
      <UsageApp
        coordinator={new FakeCoordinator(weeklyState)}
        initialState={weeklyState}
        initialRange={180}
        initialGranularity="week"
        color={false}
        terminalSize={{columns: 80, rows: 24}}
      />
    );
    await settle();
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain(
      'Joined token activity · 180d weekly'
    );
    expect(frame).toContain(`${currentWeekLabel()} · 456 tokens`);
    expect(frame).toContain('456 tokens');
    expect(frame).toContain(
      `S0/L1/·${daysBeforeTodayInCurrentUtcWeek()}d`
    );
    expect(frame).toContain('incomplete');
    expect(frame).toContain('AvgV/A');
    expect(frame).toContain('Min');
    expect(frame).toContain('Max');
    expect(frame).toContain('partial local');
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
  });

  it('expands the daily plot at 120×40 and keeps no-color bands distinct', async () => {
    const app = render(
      <UsageApp
        coordinator={new FakeCoordinator()}
        initialState={state}
        initialRange={7}
        color={false}
        terminalSize={{columns: 120, rows: 40}}
      />
    );
    await settle();
    const frame = app.lastFrame() ?? '';
    const plotRows = frame
      .split('\n')
      .filter(
        line =>
          /[░▒█]/u.test(line) &&
          (line.includes('┤') || line.includes('│'))
      );
    expect(plotRows.length).toBeGreaterThanOrEqual(14);
    expect(plotRows.length).toBeLessThanOrEqual(18);
    expect(Math.max(...plotRows.map(line => line.length))).toBeGreaterThanOrEqual(
      110
    );
    expect(frame).toContain('░ ≤50%');
    expect(frame).toContain('▒ 50–75%');
    expect(frame).toContain('█ >75%');
    expect(frame.split('\n').length).toBeLessThanOrEqual(40);
  });

  it('renders the semantic color path without changing accessible plot glyphs', async () => {
    const app = render(
      <UsageApp
        coordinator={new FakeCoordinator()}
        initialState={state}
        initialRange={7}
        color={true}
        terminalSize={{columns: 120, rows: 40}}
      />
    );
    await settle();
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('░');
    expect(frame).toContain('▒');
    expect(frame).toContain('█');
  });

  it('renders baseline, reset, unavailable, and disabled local states safely', async () => {
    for (const [liveUsage, expected] of [
      [
        {
          status: 'baseline' as const,
          aggregateTokens: 100,
          sampledAt: new Date().toISOString(),
          todayDayKey: new Date().toISOString().slice(0, 10),
          todayObservedTokens: 0,
          todayBaselineAt: new Date().toISOString(),
          todayLatestSampleAt: new Date().toISOString(),
          todaySampleCount: 1,
          todayResetCount: 0
        },
        '+0 tokens since'
      ],
      [
        {
          status: 'reset' as const,
          aggregateTokens: 50,
          sampledAt: new Date().toISOString(),
          todayDayKey: new Date().toISOString().slice(0, 10),
          todayObservedTokens: 250,
          todayBaselineAt: new Date().toISOString(),
          todayLatestSampleAt: new Date().toISOString(),
          todaySampleCount: 4,
          todayResetCount: 1
        },
        '4 samples · partial local · 1 reset'
      ],
      [{status: 'unavailable' as const}, 'unavailable'],
      [{status: 'disabled' as const}, 'disabled by --no-local']
    ] as const) {
      const localState: DashboardSnapshot = {...state, liveUsage};
      const app = render(
        <UsageApp
          coordinator={new FakeCoordinator(localState)}
          initialState={localState}
          initialRange={7}
          color={false}
          terminalSize={{columns: 120, rows: 40}}
        />
      );
      await settle();
      expect(app.lastFrame()).toContain(expected);
      app.unmount();
    }
  });

  it('uses the reduced plot and collapses secondary statistics at 80×20', async () => {
    const app = render(
      <UsageApp
        coordinator={new FakeCoordinator()}
        initialState={state}
        initialRange={7}
        color={false}
        terminalSize={{columns: 80, rows: 20}}
      />
    );
    await settle();
    const frame = app.lastFrame() ?? '';
    const plotRows = frame
      .split('\n')
      .filter(
        line =>
          /[░▒█]/u.test(line) &&
          (line.includes('┤') || line.includes('│'))
      );
    expect(plotRows.length).toBeGreaterThanOrEqual(4);
    expect(plotRows.length).toBeLessThanOrEqual(6);
    expect(frame).toContain('456 tokens');
    expect(frame).not.toContain('Reported 456 tokens');
    expect(frame.split('\n').length).toBeLessThanOrEqual(20);
  });

  it('renders full-width fixed-scale used-capacity history with exact values', async () => {
    const app = render(
      <UsageApp
        coordinator={new FakeCoordinator()}
        initialState={state}
        initialRange={7}
        color={false}
        terminalSize={{columns: 80, rows: 24}}
      />
    );
    await settle();
    app.stdin.write('\t');
    await settle();
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain('100%');
    expect(frame).toContain('50%');
    expect(frame).toContain('0% └');
    expect(frame).toContain('28% used');
    expect(frame).toContain('72% remaining');
    expect(frame).toContain('actual used 0–100%');
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
  });

  it('uses Left/Right for time and Up/Down for limits', async () => {
    const firstLimit = state.limits[0];
    const firstObservation = state.limitHistory[0];
    if (firstLimit === undefined || firstObservation === undefined) {
      throw new Error('Directional fixture requires a limit observation.');
    }
    const secondLimit = {
      ...firstLimit,
      key: 'spark|primary|10080',
      limitId: 'spark',
      limitName: 'Spark',
      durationMinutes: 10_080,
      displayName: 'Spark'
    };
    const directionalState: DashboardSnapshot = {
      ...state,
      limits: [...state.limits, secondLimit],
      limitHistory: [
        ...state.limitHistory,
        {
          ...firstObservation,
          limitKey: secondLimit.key,
          limitId: secondLimit.limitId,
          displayName: secondLimit.displayName,
          durationMinutes: secondLimit.durationMinutes
        }
      ]
    };
    const app = render(
      <UsageApp
        coordinator={new FakeCoordinator(directionalState)}
        initialState={directionalState}
        initialRange={7}
        color={false}
      />
    );
    await settle();
    app.stdin.write('\u001b[D');
    await settle();
    expect(app.lastFrame()).toContain('Joined ·');
    expect(app.lastFrame()).toContain('· missing');
    app.stdin.write('\u001b[B');
    await settle();
    expect(app.lastFrame()).toContain(
      'Spark · limit change unavailable · partial local'
    );
    app.stdin.write('\t');
    await settle();
    expect(app.lastFrame()).toContain('Spark (2/2)');
    app.stdin.write('\u001b[A');
    await settle();
    expect(app.lastFrame()).toContain('Codex (1/2)');
  });

  it('opens managed login and refreshes after completion', async () => {
    const signedOut: DashboardSnapshot = {
      ...state,
      status: 'unauthenticated',
      limits: [],
      dailyUsage: [],
      limitHistory: [],
      lastSuccessfulAt: undefined,
      planType: undefined,
      authenticationState: 'signedOut',
      warning: {
        category: 'unauthenticated',
        message: 'Codex is not signed in with ChatGPT.',
        recovery: 'Press l to sign in.'
      }
    };
    const coordinator = new FakeCoordinator(signedOut, state);
    const openUrl = vi.fn(() => Promise.resolve());
    const app = render(
      <UsageApp
        coordinator={coordinator}
        initialState={signedOut}
        initialRange={7}
        color={false}
        openUrl={openUrl}
      />
    );
    await settle();
    app.stdin.write('l');
    await settle(10);
    expect(openUrl).toHaveBeenCalledWith('https://example.invalid/authorize');
    expect(coordinator.loginStarts).toBe(1);
    expect(coordinator.loginCompletions).toBe(1);
    expect(app.lastFrame()).toContain('72% remaining');
    expect(app.lastFrame()).not.toContain('example.invalid');
  });

  it('shows a safe browser-open failure', async () => {
    const signedOut: DashboardSnapshot = {
      ...state,
      status: 'unauthenticated',
      limits: [],
      authenticationState: 'signedOut'
    };
    const app = render(
      <UsageApp
        coordinator={new FakeCoordinator(signedOut)}
        initialState={signedOut}
        initialRange={7}
        color={false}
        openUrl={() =>
          Promise.reject(
            new AppError(
              'serviceUnavailable',
              'The authorization page could not be opened.',
              'Press l to try again.'
            )
          )
        }
      />
    );
    await settle();
    app.stdin.write('l');
    await settle(10);
    expect(app.lastFrame()).toContain(
      'The authorization page could not be opened.'
    );
  });
});

function settle(milliseconds: number = 0): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function currentWeekLabel(): string {
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const monday = new Date(today);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  const start = monday.toISOString().slice(0, 10);
  const end = sunday.toISOString().slice(0, 10);
  if (start.slice(0, 7) === end.slice(0, 7)) {
    return `${start}–${end.slice(8)}`;
  }
  if (start.slice(0, 4) === end.slice(0, 4)) {
    return `${start}–${end.slice(5)}`;
  }
  return `${start}–${end}`;
}

function daysBeforeTodayInCurrentUtcWeek(): number {
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return (today.getUTCDay() + 6) % 7;
}

function localObservation(
  dayKey: string,
  observedIncreaseTokens: number,
  sampleCount: number
) {
  return {
    dayKey,
    baselineAggregateTokens: 1_000,
    baselineSampledAt: `${dayKey}T17:28:00.000Z`,
    latestAggregateTokens: 1_000 + observedIncreaseTokens,
    latestSampledAt: `${dayKey}T22:42:00.000Z`,
    observedIncreaseTokens,
    sampleCount,
    resetCount: 0
  };
}
