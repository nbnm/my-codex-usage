import {execFile} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {describe, expect, it} from 'vitest';
import {
  LOCAL_USAGE_SQL,
  SqliteLocalUsageSource,
  parseAggregateOutput,
  runReadonlySqliteQuery
} from '../../src/codex/local-usage.js';

const execFileAsync = promisify(execFile);

describe('SqliteLocalUsageSource', () => {
  it('uses one fixed read-only aggregate invocation', async () => {
    const calls: Array<{
      executable: string;
      args: readonly string[];
    }> = [];
    const source = new SqliteLocalUsageSource({
      now: () => new Date('2026-07-27T12:00:00.000Z'),
      runQuery: (executable, args) => {
        calls.push({executable, args});
        return Promise.resolve('12345|1785151800\n');
      }
    });
    await expect(
      source.readAggregate('/sanitized/codex-home')
    ).resolves.toEqual({
      aggregateTokens: 12_345,
      sampledAt: '2026-07-27T12:00:00.000Z',
      latestActivityAt: '2026-07-27T11:30:00.000Z'
    });
    expect(calls).toEqual([
      {
        executable: '/usr/bin/sqlite3',
        args: [
          '-readonly',
          '/sanitized/codex-home/state_5.sqlite',
          LOCAL_USAGE_SQL
        ]
      }
    ]);
    expect(LOCAL_USAGE_SQL).toContain('SUM(');
    expect(LOCAL_USAGE_SQL).toContain('MAX(updated_at)');
    expect(LOCAL_USAGE_SQL).toContain('tokens_used');
    expect(LOCAL_USAGE_SQL).not.toMatch(
      /\b(id|title|cwd|path|preview|rollout_path)\b/iu
    );
    expect(LOCAL_USAGE_SQL).not.toMatch(
      /\b(insert|update|delete|replace|alter|drop|create)\b/iu
    );
  });

  it('reads a real fixture database without modifying rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'my-codex-local-usage-'));
    const database = join(root, 'state_5.sqlite');
    await execFileAsync('/usr/bin/sqlite3', [
      database,
      'CREATE TABLE threads(tokens_used INTEGER, updated_at INTEGER);' +
        'INSERT INTO threads VALUES (100, 1785150000), (250, 1785151800);'
    ]);
    const source = new SqliteLocalUsageSource({
      now: () => new Date('2026-07-27T12:00:00.000Z')
    });
    await expect(source.readAggregate(root)).resolves.toMatchObject({
      aggregateTokens: 350,
      latestActivityAt: '2026-07-27T11:30:00.000Z'
    });
    const {stdout} = await execFileAsync('/usr/bin/sqlite3', [
      '-readonly',
      database,
      'SELECT COUNT(*) FROM threads;'
    ]);
    expect(stdout.trim()).toBe('2');
  });

  it('degrades missing files, schemas, and query failures to unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'my-codex-local-missing-'));
    const source = new SqliteLocalUsageSource();
    await expect(source.readAggregate(root)).resolves.toBeUndefined();

    const database = join(root, 'state_5.sqlite');
    await execFileAsync('/usr/bin/sqlite3', [
      database,
      'CREATE TABLE unrelated(value INTEGER);'
    ]);
    await expect(source.readAggregate(root)).resolves.toBeUndefined();

    const failed = new SqliteLocalUsageSource({
      runQuery: () => Promise.reject(new Error('raw local failure'))
    });
    await expect(
      failed.readAggregate('/sanitized/codex-home')
    ).resolves.toBeUndefined();
  });

  it('parses zero rows safely and rejects malformed or unsafe values', () => {
    expect(parseAggregateOutput('0|\n')).toEqual({aggregateTokens: 0});
    for (const value of [
      '',
      '-1|1785151800\n',
      '1.5|1785151800\n',
      '9007199254740992|1785151800\n',
      '1|not-a-timestamp\n',
      '1|9999999999999999\n',
      '1|1785151800\n2|1785151801\n'
    ]) {
      expect(parseAggregateOutput(value)).toBeUndefined();
    }
  });

  it('supports abort, timeout, invalid UTF-8, and bounded streams', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('Stopped', 'AbortError'));
    await expect(
      runReadonlySqliteQuery(process.execPath, ['-e', ''], controller.signal)
    ).rejects.toMatchObject({name: 'AbortError'});

    await expect(
      runReadonlySqliteQuery(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 1000)'],
        undefined,
        {timeoutMs: 10}
      )
    ).rejects.toMatchObject({name: 'TimeoutError'});

    await expect(
      runReadonlySqliteQuery(
        process.execPath,
        ['-e', "process.stdout.write('x'.repeat(100))"],
        undefined,
        {maximumStdoutBytes: 16}
      )
    ).rejects.toThrow(/too large/u);

    await expect(
      runReadonlySqliteQuery(
        process.execPath,
        ['-e', "process.stderr.write('x'.repeat(100))"],
        undefined,
        {maximumStderrBytes: 16}
      )
    ).rejects.toThrow(/too large/u);

    await expect(
      runReadonlySqliteQuery(
        process.execPath,
        ['-e', 'process.stdout.write(Buffer.from([0xff]))']
      )
    ).rejects.toBeDefined();
  });
});
