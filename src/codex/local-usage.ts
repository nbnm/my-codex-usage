import {spawn} from 'node:child_process';
import {join} from 'node:path';
import type {
  LocalUsageAggregate,
  LocalUsageSource
} from '../domain/types.js';

const SQLITE_PATH = '/usr/bin/sqlite3';
const STATE_DATABASE_NAME = 'state_5.sqlite';
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_STDOUT_BYTES = 8 * 1_024;
const MAX_STDERR_BYTES = 64 * 1_024;

export const LOCAL_USAGE_SQL =
  "SELECT COALESCE(SUM(CASE WHEN tokens_used >= 0 THEN tokens_used ELSE 0 END), 0), COALESCE(MAX(updated_at), '') FROM threads;";

export type SqliteQueryRunner = (
  executable: string,
  args: readonly string[],
  signal?: AbortSignal
) => Promise<string>;

export type SqliteQueryLimits = {
  timeoutMs?: number;
  maximumStdoutBytes?: number;
  maximumStderrBytes?: number;
};

export type LocalUsageSourceOptions = {
  now?: () => Date;
  runQuery?: SqliteQueryRunner;
};

export class SqliteLocalUsageSource implements LocalUsageSource {
  private readonly now: () => Date;
  private readonly runQuery: SqliteQueryRunner;

  constructor(options: LocalUsageSourceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.runQuery = options.runQuery ?? runReadonlySqliteQuery;
  }

  async readAggregate(
    codexHome: string,
    signal?: AbortSignal
  ): Promise<LocalUsageAggregate | undefined> {
    try {
      const output = await this.runQuery(
        SQLITE_PATH,
        ['-readonly', join(codexHome, STATE_DATABASE_NAME), LOCAL_USAGE_SQL],
        signal
      );
      const parsed = parseAggregateOutput(output);
      if (parsed === undefined) {
        return undefined;
      }
      return {
        ...parsed,
        sampledAt: this.now().toISOString()
      };
    } catch (error) {
      if (signal?.aborted === true) {
        throw error;
      }
      return undefined;
    }
  }
}

export function parseAggregateOutput(
  output: string
): Omit<LocalUsageAggregate, 'sampledAt'> | undefined {
  const lines = output.trimEnd().split(/\r?\n/u);
  if (lines.length !== 1 || lines[0] === undefined) {
    return undefined;
  }
  const fields = lines[0].split('|');
  if (fields.length !== 2) {
    return undefined;
  }
  const aggregateText = fields[0]?.trim();
  const activityText = fields[1]?.trim();
  if (aggregateText === undefined || !/^\d+$/u.test(aggregateText)) {
    return undefined;
  }
  const aggregateBigInt = BigInt(aggregateText);
  if (aggregateBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  const aggregateTokens = Number(aggregateBigInt);
  if (activityText === undefined || activityText === '') {
    return {aggregateTokens};
  }
  if (!/^\d+$/u.test(activityText)) {
    return undefined;
  }
  const activitySecondsBigInt = BigInt(activityText);
  if (activitySecondsBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  const activityDate = new Date(Number(activitySecondsBigInt) * 1_000);
  if (Number.isNaN(activityDate.getTime())) {
    return undefined;
  }
  return {
    aggregateTokens,
    latestActivityAt: activityDate.toISOString()
  };
}

export function runReadonlySqliteQuery(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal,
  limits: SqliteQueryLimits = {}
): Promise<string> {
  if (signal?.aborted === true) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (error: unknown, output?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error !== undefined) {
        reject(error);
      } else {
        resolve(output ?? '');
      }
    };
    const terminate = (error: Error): void => {
      child.kill('SIGTERM');
      finish(error);
    };
    const abort = (): void => {
      child.kill('SIGTERM');
      finish(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      terminate(new DOMException('Local usage query timed out.', 'TimeoutError'));
    }, limits.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref();

    signal?.addEventListener('abort', abort, {once: true});
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > (limits.maximumStdoutBytes ?? MAX_STDOUT_BYTES)) {
        terminate(new Error('Local usage query output was too large.'));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > (limits.maximumStderrBytes ?? MAX_STDERR_BYTES)) {
        terminate(new Error('Local usage query diagnostics were too large.'));
      }
    });
    child.once('error', error => {
      finish(error);
    });
    child.once('close', code => {
      if (code !== 0) {
        finish(new Error('Local usage query was unavailable.'));
        return;
      }
      try {
        const output = new TextDecoder('utf-8', {fatal: true}).decode(
          Buffer.concat(stdoutChunks)
        );
        finish(undefined, output);
      } catch (error) {
        finish(error);
      }
    });
  });
}
