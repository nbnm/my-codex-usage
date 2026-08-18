import {mkdtemp, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import type {NormalizedLimitWindow} from '../../src/domain/types.js';
import {
  FileHistoryStore,
  emptyHistory,
  mergeSuccessfulRefresh,
  pruneHistory,
  recordLocalUsageSample
} from '../../src/persistence/history-store.js';

const limit: NormalizedLimitWindow = {
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
};

describe('FileHistoryStore', () => {
  it('writes user-only atomic history and loads it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'my-codex-usage-history-'));
    const file = join(root, 'nested', 'history-v4.json');
    const now = new Date('2026-07-24T12:34:00Z');
    const store = new FileHistoryStore(file, () => now);
    let history = mergeSuccessfulRefresh(emptyHistory(), {
      observedAt: now,
      codexVersion: '0.144.3',
      authenticationState: 'chatgpt',
      limits: [limit],
      usageSummary: {
        lifetimeTokens: 1_234,
        currentStreakDays: 4
      },
      sourceFreshness: {
        limitsFetchedAt: now.toISOString(),
        usageFetchedAt: now.toISOString(),
        usageDataThroughDay: '2026-07-24'
      },
      dailyUsage: [
        {
          dayKey: '2026-07-24',
          tokens: 456,
          fetchedAt: now.toISOString()
        }
      ]
    });
    history = recordLocalUsageSample(history, {
      aggregateTokens: 9_876,
      sampledAt: now.toISOString(),
      latestActivityAt: '2026-07-24T12:30:00.000Z'
    }).history;
    await store.save(history);

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, 'nested'))).mode & 0o777).toBe(0o700);
    expect(await store.load()).toEqual(history);
    expect(await readHistoryText(file)).not.toMatch(
      /email|accountId|authUrl|loginId|prompt|repository/u
    );
    expect(await readHistoryText(file)).not.toMatch(
      /codexHome|state_5|sqlite|threadId|title|rollout/u
    );
    expect((await readdir(join(root, 'nested'))).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('upserts one point per limit and UTC hour', () => {
    const first = mergeSuccessfulRefresh(emptyHistory(), {
      observedAt: new Date('2026-07-24T12:05:00Z'),
      codexVersion: '0.144.3',
      authenticationState: 'chatgpt',
      limits: [limit],
      dailyUsage: undefined
    });
    const second = mergeSuccessfulRefresh(first, {
      observedAt: new Date('2026-07-24T12:55:00Z'),
      codexVersion: '0.144.3',
      authenticationState: 'chatgpt',
      limits: [{...limit, remainingPercent: 60, usedPercent: 40}],
      dailyUsage: undefined
    });
    expect(second.limitHistory).toHaveLength(1);
    expect(second.limitHistory[0]?.remainingPercent).toBe(60);
  });

  it('persists a reported current-day bucket without synthesizing the next day', () => {
    const first = mergeSuccessfulRefresh(emptyHistory(), {
      observedAt: new Date('2026-07-24T23:59:00Z'),
      codexVersion: '0.144.3',
      authenticationState: 'chatgpt',
      limits: [],
      dailyUsage: [
        {
          dayKey: '2026-07-24',
          tokens: 456,
          fetchedAt: '2026-07-24T23:59:00.000Z'
        }
      ]
    });
    const afterMidnight = mergeSuccessfulRefresh(first, {
      observedAt: new Date('2026-07-25T00:01:00Z'),
      codexVersion: '0.144.3',
      authenticationState: 'chatgpt',
      limits: [],
      dailyUsage: undefined
    });

    expect(afterMidnight.dailyUsage).toEqual(first.dailyUsage);
    expect(afterMidnight.dailyUsage).not.toContainEqual(
      expect.objectContaining({dayKey: '2026-07-25'})
    );
  });

  it('prunes daily, hourly, local-day, and diagnostic retention', () => {
    const now = new Date('2026-07-24T00:00:00Z');
    const old = '2025-01-01T00:00:00.000Z';
    const history = pruneHistory(
      {
        ...emptyHistory(),
        dailyUsage: [
          {dayKey: '2025-01-01', tokens: 1, fetchedAt: old},
          {dayKey: '2026-07-23', tokens: 2, fetchedAt: now.toISOString()}
        ],
        limitHistory: [
          {
            hourKey: '2025-01-01T00',
            observedAt: old,
            limitKey: limit.key,
            limitId: limit.limitId,
            displayName: limit.displayName,
            windowKind: limit.windowKind,
            durationMinutes: limit.durationMinutes,
            remainingPercent: 50,
            resetsAt: undefined
          }
        ],
        localUsageDays: [
          localObservation('2025-01-01', old),
          localObservation('2026-07-23', '2026-07-23T12:00:00.000Z')
        ],
        diagnostics: [
          {occurredAt: old, category: 'serviceUnavailable'}
        ]
      },
      now
    );
    expect(history.dailyUsage.map(entry => entry.dayKey)).toEqual(['2026-07-23']);
    expect(history.limitHistory).toEqual([]);
    expect(history.localUsageDays.map(entry => entry.dayKey)).toEqual([
      '2026-07-23'
    ]);
    expect(history.diagnostics).toEqual([]);
  });

  it('retains limit observations through 180 days and prunes older entries', () => {
    const now = new Date('2026-07-24T12:00:00Z');
    const dayMs = 24 * 60 * 60 * 1_000;
    const atBoundary = new Date(now.getTime() - 180 * dayMs).toISOString();
    const outside = new Date(now.getTime() - 181 * dayMs).toISOString();
    const retained = pruneHistory(
      {
        ...emptyHistory(),
        limitHistory: [
          historyObservation(outside),
          historyObservation(atBoundary),
          historyObservation(now.toISOString())
        ]
      },
      now
    );
    expect(retained.limitHistory.map(entry => entry.observedAt)).toEqual([
      atBoundary,
      now.toISOString()
    ]);
  });

  it('retains local observations at the 180-day boundary and prunes older days', () => {
    const now = new Date('2026-07-24T00:00:00.000Z');
    const dayMs = 24 * 60 * 60 * 1_000;
    const atBoundary = new Date(now.getTime() - 180 * dayMs)
      .toISOString()
      .slice(0, 10);
    const outside = new Date(now.getTime() - 181 * dayMs)
      .toISOString()
      .slice(0, 10);
    const retained = pruneHistory(
      {
        ...emptyHistory(),
        localUsageDays: [
          localObservation(outside, `${outside}T00:00:00.000Z`),
          localObservation(atBoundary, `${atBoundary}T00:00:00.000Z`),
          localObservation('2026-07-24', now.toISOString())
        ]
      },
      now
    );
    expect(retained.localUsageDays.map(entry => entry.dayKey)).toEqual([
      atBoundary,
      '2026-07-24'
    ]);
  });

  it('quarantines corrupt history and starts clean', async () => {
    const root = await mkdtemp(join(tmpdir(), 'my-codex-usage-corrupt-'));
    const file = join(root, 'history-v4.json');
    await writeFile(file, '{broken', {mode: 0o600});
    const store = new FileHistoryStore(
      file,
      () => new Date('2026-07-24T00:00:00Z')
    );
    const recovered = await store.load();
    expect(recovered.diagnostics[0]?.category).toBe('historyCorrupt');
    expect((await readdir(root)).some(name => name.endsWith('.corrupt'))).toBe(true);
  });

  it('migrates valid version-one legacy history to version four without writing legacy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'my-codex-usage-v1-'));
    const legacy = join(root, 'history.json');
    const file = join(root, 'history-v4.json');
    const legacyText = JSON.stringify({
      schemaVersion: 1,
      lastAttemptAt: '2026-07-24T12:00:00.000Z',
      lastSuccessfulAt: '2026-07-24T12:00:00.000Z',
      detectedCodexVersion: '0.144.3',
      authenticationState: 'chatgpt',
      dailyUsage: [
        {
          dayKey: '2026-07-23',
          tokens: 456,
          fetchedAt: '2026-07-24T12:00:00.000Z'
        }
      ],
      limitHistory: [],
      diagnostics: []
    });
    await writeFile(
      legacy,
      legacyText,
      {mode: 0o600}
    );
    const store = new FileHistoryStore(
      file,
      () => new Date('2026-07-24T12:00:00Z'),
      legacy
    );
    const migrated = await store.load();
    expect(migrated.schemaVersion).toBe(4);
    expect(migrated.usageSummary).toEqual({});
    expect(migrated.sourceFreshness).toEqual({
      limitsFetchedAt: '2026-07-24T12:00:00.000Z',
      usageFetchedAt: '2026-07-24T12:00:00.000Z',
      usageDataThroughDay: '2026-07-23'
    });
    expect(migrated.dailyUsage).toHaveLength(1);
    expect((await readdir(root)).some(name => name.endsWith('.corrupt'))).toBe(
      false
    );
    await store.save(migrated);
    expect(JSON.parse(await readHistoryText(file)).schemaVersion).toBe(4);
    expect(await readHistoryText(legacy)).toBe(legacyText);
  });

  it('migrates valid version-two history and preserves summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'my-codex-usage-v2-'));
    const legacy = join(root, 'history.json');
    const file = join(root, 'history-v4.json');
    await writeFile(
      legacy,
      JSON.stringify({
        schemaVersion: 2,
        lastAttemptAt: '2026-07-24T12:00:00.000Z',
        lastSuccessfulAt: '2026-07-24T12:00:00.000Z',
        detectedCodexVersion: '0.144.3',
        authenticationState: 'chatgpt',
        usageSummary: {lifetimeTokens: 1_234},
        dailyUsage: [],
        limitHistory: [],
        diagnostics: []
      }),
      {mode: 0o600}
    );
    const store = new FileHistoryStore(
      file,
      () => new Date('2026-07-24T12:00:00Z'),
      legacy
    );
    const migrated = await store.load();
    expect(migrated).toMatchObject({
      schemaVersion: 4,
      usageSummary: {lifetimeTokens: 1_234},
      sourceFreshness: {
        limitsFetchedAt: '2026-07-24T12:00:00.000Z'
      }
    });
    expect(migrated.localUsageDays).toEqual([]);
    expect((await readdir(root)).some(name => name.endsWith('.corrupt'))).toBe(
      false
    );
  });

  it('migrates a version-three checkpoint into a zero-delta local day', async () => {
    const root = await mkdtemp(join(tmpdir(), 'my-codex-usage-v3-'));
    const legacy = join(root, 'history.json');
    const file = join(root, 'history-v4.json');
    await writeFile(
      legacy,
      JSON.stringify({
        schemaVersion: 3,
        lastAttemptAt: '2026-07-24T12:00:00.000Z',
        lastSuccessfulAt: '2026-07-24T12:00:00.000Z',
        detectedCodexVersion: '0.144.3',
        authenticationState: 'chatgpt',
        usageSummary: {lifetimeTokens: 1_234},
        sourceFreshness: {limitsFetchedAt: '2026-07-24T12:00:00.000Z'},
        localUsageCheckpoint: {
          aggregateTokens: 5_000,
          sampledAt: '2026-07-24T12:00:00.000Z',
          latestActivityAt: '2026-07-24T11:59:00.000Z'
        },
        dailyUsage: [],
        limitHistory: [],
        diagnostics: []
      }),
      {mode: 0o600}
    );
    const store = new FileHistoryStore(
      file,
      () => new Date('2026-07-24T12:00:00Z'),
      legacy
    );
    expect((await store.load()).localUsageDays).toEqual([
      {
        dayKey: '2026-07-24',
        baselineAggregateTokens: 5_000,
        baselineSampledAt: '2026-07-24T12:00:00.000Z',
        latestAggregateTokens: 5_000,
        latestSampledAt: '2026-07-24T12:00:00.000Z',
        observedIncreaseTokens: 0,
        sampleCount: 1,
        resetCount: 0,
        latestActivityAt: '2026-07-24T11:59:00.000Z'
      }
    ]);
  });

  it('accumulates only positive same-day samples and starts fresh after midnight', () => {
    let history = emptyHistory();
    const samples = [
      ['2026-07-27T12:00:00.000Z', 1_000],
      ['2026-07-27T12:01:00.000Z', 1_250],
      ['2026-07-27T19:00:00.000Z', 1_250],
      ['2026-07-27T19:01:00.000Z', 100],
      ['2026-07-27T19:02:00.000Z', 150],
      ['2026-07-28T00:01:00.000Z', 175]
    ] as const;
    const statuses = [];
    for (const [sampledAt, aggregateTokens] of samples) {
      const result = recordLocalUsageSample(history, {
        aggregateTokens,
        sampledAt
      });
      statuses.push(result.sampleStatus);
      history = result.history;
    }
    expect(statuses).toEqual([
      'baseline',
      'observed',
      'observed',
      'reset',
      'observed',
      'baseline'
    ]);
    expect(history.localUsageDays[0]).toMatchObject({
      dayKey: '2026-07-27',
      observedIncreaseTokens: 300,
      sampleCount: 5,
      resetCount: 1
    });
    expect(history.localUsageDays[1]).toMatchObject({
      dayKey: '2026-07-28',
      observedIncreaseTokens: 0,
      sampleCount: 1,
      resetCount: 0
    });
  });
});

async function readHistoryText(file: string): Promise<string> {
  return readFile(file, 'utf8');
}

function historyObservation(observedAt: string) {
  return {
    hourKey: observedAt.slice(0, 13),
    observedAt,
    limitKey: limit.key,
    limitId: limit.limitId,
    displayName: limit.displayName,
    windowKind: limit.windowKind,
    durationMinutes: limit.durationMinutes,
    remainingPercent: limit.remainingPercent,
    resetsAt: limit.resetsAt
  };
}

function localObservation(dayKey: string, sampledAt: string) {
  return {
    dayKey,
    baselineAggregateTokens: 1,
    baselineSampledAt: sampledAt,
    latestAggregateTokens: 2,
    latestSampledAt: sampledAt,
    observedIncreaseTokens: 1,
    sampleCount: 2,
    resetCount: 0
  };
}
