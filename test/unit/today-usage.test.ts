import {mkdtemp, mkdir, symlink, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  aggregateTodayUsageRecords,
  SessionTodayUsageSource
} from '../../src/codex/today-usage.js';

const DAY = '2026-08-17';

describe('current-day token aggregation', () => {
  it('groups current UTC-day events by model and effort and preserves protocol totals', () => {
    const result = aggregateTodayUsageRecords(
      [
        context('gpt-5.6-sol', 'high'),
        usage(`${DAY}T01:00:00.000Z`, {
          input_tokens: 100,
          cached_input_tokens: 80,
          cache_write_input_tokens: 7,
          output_tokens: 20,
          reasoning_output_tokens: 10,
          total_tokens: 125
        }),
        usage(`${DAY}T02:00:00.000Z`, {
          input_tokens: 40,
          cached_input_tokens: 30,
          cache_write_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 2,
          total_tokens: 45
        }),
        context('gpt-5.6-terra', 'medium'),
        usage(`${DAY}T03:00:00.000Z`, {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 3,
          reasoning_output_tokens: 1,
          total_tokens: 13
        }),
        usage('2026-08-16T23:59:59.999Z', {
          input_tokens: 999,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
          total_tokens: 1_000
        })
      ],
      DAY
    );

    expect(result.tokenEventCount).toBe(3);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      effort: 'high',
      inputTokens: 140,
      cachedInputTokens: 110,
      cacheWriteInputTokens: 7,
      outputTokens: 25,
      reasoningOutputTokens: 12,
      totalTokens: 170,
      eventCount: 2
    });
    expect(result.total).toEqual({
      inputTokens: 150,
      cachedInputTokens: 110,
      cacheWriteInputTokens: 7,
      outputTokens: 28,
      reasoningOutputTokens: 13,
      totalTokens: 183
    });
    expect(result.total.totalTokens).not.toBe(
      result.total.inputTokens +
        result.total.cachedInputTokens +
        result.total.outputTokens +
        result.total.reasoningOutputTokens
    );
  });

  it('uses unknown labels and rejects invalid counters without guessing', () => {
    const result = aggregateTodayUsageRecords(
      [
        context('\u001b[31munsafe', ''),
        usage(`${DAY}T01:00:00.000Z`, tokenCounts(5)),
        usage(`${DAY}T02:00:00.000Z`, {
          ...tokenCounts(5),
          input_tokens: -1
        }),
        {type: 'event_msg', payload: {type: 'unrelated'}}
      ],
      DAY
    );

    expect(result.groups[0]).toMatchObject({
      model: 'unknown',
      effort: 'unknown',
      totalTokens: 6
    });
    expect(result.tokenEventCount).toBe(1);
    expect(result.skippedRecordCount).toBe(1);
  });
});

describe('SessionTodayUsageSource', () => {
  it('reads eligible older sessions, filters by event day, and never returns ignored content', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'today-usage-'));
    const sessions = join(codexHome, 'sessions', '2026', '08', '16');
    await mkdir(sessions, {recursive: true});
    const file = join(sessions, 'fixture.jsonl');
    const records = [
      JSON.stringify({
        timestamp: '2026-08-16T20:00:00.000Z',
        type: 'turn_context',
        payload: {
          model: 'gpt-5.6-sol',
          effort: 'xhigh',
          ignored_marker: 'CONTENT_MUST_NOT_ESCAPE'
        }
      }),
      JSON.stringify(usage(`${DAY}T00:01:00.000Z`, tokenCounts(11))),
      JSON.stringify(usage('2026-08-16T23:59:00.000Z', tokenCounts(99))),
      '{malformed',
      'x'.repeat(513),
      JSON.stringify(usage(`${DAY}T00:02:00.000Z`, tokenCounts(13)))
    ];
    await writeFile(
      file,
      Buffer.concat([
        Buffer.from(`${records.join('\n')}\n`),
        Buffer.from([0xff, 0x0a])
      ])
    );
    await utimes(file, new Date(`${DAY}T12:00:00.000Z`), new Date(`${DAY}T12:00:00.000Z`));
    await symlink(file, join(sessions, 'ignored-link.jsonl'));

    const source = new SessionTodayUsageSource({
      now: () => new Date(`${DAY}T14:00:00.000Z`),
      maximumLineBytes: 512
    });
    const snapshot = await source.readToday(codexHome);

    expect(snapshot.status).toBe('ready');
    expect(snapshot.scannedFileCount).toBe(1);
    expect(snapshot.tokenEventCount).toBe(2);
    expect(snapshot.skippedRecordCount).toBe(3);
    expect(snapshot.groups[0]).toMatchObject({
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      inputTokens: 24,
      totalTokens: 26
    });
    expect(JSON.stringify(snapshot)).not.toContain('CONTENT_MUST_NOT_ESCAPE');
    expect(JSON.stringify(snapshot)).not.toContain('fixture.jsonl');
  });

  it('returns an unavailable state for unreadable roots and honors cancellation', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'today-unavailable-'));
    const notDirectory = join(parent, 'not-a-directory');
    await writeFile(notDirectory, 'fixture');
    const source = new SessionTodayUsageSource({
      now: () => new Date(`${DAY}T14:00:00.000Z`)
    });
    const snapshot = await source.readToday(notDirectory);
    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.groups).toEqual([]);

    const controller = new AbortController();
    controller.abort(new Error('fixture abort'));
    await expect(source.readToday(parent, controller.signal)).rejects.toThrow(
      'fixture abort'
    );
  });
});

function context(model: string, effort: string): unknown {
  return {
    timestamp: `${DAY}T00:00:00.000Z`,
    type: 'turn_context',
    payload: {model, effort}
  };
}

function usage(timestamp: string, lastTokenUsage: Record<string, number>): unknown {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {last_token_usage: lastTokenUsage}
    }
  };
}

function tokenCounts(input: number): Record<string, number> {
  return {
    input_tokens: input,
    cached_input_tokens: Math.max(0, input - 2),
    cache_write_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 1,
    total_tokens: input + 1
  };
}
