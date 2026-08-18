import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {AppError} from '../domain/errors.js';
import type {
  JsonRpcTransport,
  ServerNotification
} from '../domain/types.js';
import {JsonLineDecoder} from './jsonl.js';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
  signal: AbortSignal | undefined;
  abortHandler: (() => void) | undefined;
};

type SpawnProcess = (
  executable: string,
  args: readonly string[]
) => ChildProcessWithoutNullStreams;

export type TransportOptions = {
  executablePath: string;
  requestTimeoutMs?: number;
  maximumLineBytes?: number;
  spawnProcess?: SpawnProcess;
};

export class NodeJsonRpcTransport implements JsonRpcTransport {
  private readonly executablePath: string;
  private readonly requestTimeoutMs: number;
  private readonly maximumLineBytes: number | undefined;
  private readonly spawnProcess: SpawnProcess;
  private child: ChildProcessWithoutNullStreams | undefined;
  private decoder: JsonLineDecoder | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationQueue = new AsyncQueue<ServerNotification>();
  private stderrRing = Buffer.alloc(0);
  private closing = false;

  constructor(options: TransportOptions) {
    this.executablePath = options.executablePath;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.maximumLineBytes = options.maximumLineBytes;
    this.spawnProcess =
      options.spawnProcess ??
      ((executable, args) =>
        spawn(executable, [...args], {
          stdio: ['pipe', 'pipe', 'pipe']
        }));
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.child !== undefined) {
      return;
    }
    throwIfAborted(signal);
    this.closing = false;
    this.decoder =
      this.maximumLineBytes === undefined
        ? new JsonLineDecoder()
        : new JsonLineDecoder(this.maximumLineBytes);

    const child = this.spawnProcess(this.executablePath, ['app-server']);
    this.child = child;

    child.stdout.on('data', (chunk: Buffer) => {
      this.handleStdout(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.captureStderr(chunk);
    });
    child.once('error', error => {
      this.failTransport(
        new AppError(
          'processFailed',
          'Codex app-server could not be started.',
          'Verify Codex and press r to retry.',
          {cause: error}
        )
      );
    });
    child.once('close', () => {
      if (!this.closing) {
        try {
          this.decoder?.finish();
        } catch (error) {
          this.failTransport(error);
          return;
        }
        this.failTransport(
          new AppError(
            'processFailed',
            'Codex app-server stopped unexpectedly.',
            'Press r to restart the connection.'
          )
        );
      }
      this.child = undefined;
    });
  }

  request<T>(
    method: string,
    params?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    throwIfAborted(signal);
    const child = this.child;
    if (child === undefined || child.stdin.destroyed) {
      return Promise.reject(
        new AppError(
          'processFailed',
          'Codex app-server is not connected.',
          'Press r to retry.'
        )
      );
    }

    const id = this.nextRequestId++;
    const payload: Record<string, unknown> = {id, method};
    if (params !== undefined) {
      payload.params = params;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectPending(
          id,
          new AppError(
            'requestTimeout',
            'Codex app-server did not respond in time.',
            'Press r to try again.'
          )
        );
      }, this.requestTimeoutMs);
      timer.unref();

      let abortHandler: (() => void) | undefined;
      if (signal !== undefined) {
        abortHandler = () => {
          this.rejectPending(id, abortReason(signal));
        };
        signal.addEventListener('abort', abortHandler, {once: true});
      }

      this.pending.set(id, {
        resolve: value => {
          resolve(value as T);
        },
        reject,
        timer,
        signal,
        abortHandler
      });

      child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8', error => {
        if (error !== null && error !== undefined) {
          this.rejectPending(
            id,
            new AppError(
              'processFailed',
              'Could not write to Codex app-server.',
              'Press r to retry.',
              {cause: error}
            )
          );
        }
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const child = this.child;
    if (child === undefined || child.stdin.destroyed) {
      throw new AppError(
        'processFailed',
        'Codex app-server is not connected.',
        'Press r to retry.'
      );
    }
    const payload: Record<string, unknown> = {method};
    if (params !== undefined) {
      payload.params = params;
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8', error => {
        if (error !== null && error !== undefined) {
          reject(
            new AppError(
              'processFailed',
              'Could not write to Codex app-server.',
              'Press r to retry.',
              {cause: error}
            )
          );
          return;
        }
        resolve();
      });
    });
  }

  notifications(): AsyncIterable<ServerNotification> {
    return this.notificationQueue;
  }

  async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    this.child = undefined;
    this.rejectAll(abortReason());
    this.notificationQueue.close();
    this.stderrRing = Buffer.alloc(0);
    this.decoder = undefined;

    if (child === undefined) {
      return;
    }
    child.stdin.end();
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    const exited = new Promise<void>(resolve => {
      child.once('close', () => {
        resolve();
      });
    });
    child.kill('SIGTERM');
    const timeout = new Promise<'timeout'>(resolve => {
      const timer = setTimeout(() => resolve('timeout'), 1_000);
      timer.unref();
    });
    if ((await Promise.race([exited.then(() => 'exited' as const), timeout])) === 'timeout') {
      child.kill('SIGKILL');
      await exited;
    }
  }

  stderrByteCountForTesting(): number {
    return this.stderrRing.length;
  }

  private handleStdout(chunk: Buffer): void {
    try {
      for (const message of this.decoder?.push(chunk) ?? []) {
        this.handleMessage(message);
      }
    } catch (error) {
      this.failTransport(error);
      this.child?.kill('SIGTERM');
    }
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) {
      throw new AppError(
        'protocolMalformed',
        'Codex app-server returned an invalid message.',
        'Press r to restart the connection.'
      );
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      if ('error' in message) {
        const remote = parseRemoteError(message.error);
        this.rejectPending(message.id, remote);
        return;
      }
      if (!('result' in message)) {
        this.rejectPending(
          message.id,
          new AppError(
            'protocolMalformed',
            'Codex app-server returned a response without a result.',
            'Press r to retry.'
          )
        );
        return;
      }
      this.pending.delete(message.id);
      cleanupPending(pending);
      pending.resolve(message.result);
      return;
    }

    if (typeof message.method === 'string') {
      this.notificationQueue.push({
        method: message.method,
        params: message.params
      });
      return;
    }

    throw new AppError(
      'protocolMalformed',
      'Codex app-server returned an unrecognized message.',
      'Press r to restart the connection.'
    );
  }

  private captureStderr(chunk: Buffer): void {
    this.stderrRing = Buffer.concat([this.stderrRing, chunk]).subarray(-65_536);
  }

  private failTransport(error: unknown): void {
    const safeError =
      error instanceof AppError
        ? error
        : new AppError(
            'processFailed',
            'Codex app-server became unavailable.',
            'Press r to retry.',
            {cause: error}
          );
    this.rejectAll(safeError);
  }

  private rejectAll(error: unknown): void {
    for (const id of [...this.pending.keys()]) {
      this.rejectPending(id, error);
    }
  }

  private rejectPending(id: number, error: unknown): void {
    const pending = this.pending.get(id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(id);
    cleanupPending(pending);
    pending.reject(error);
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
  }> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      if (this.values.length >= 256) {
        this.values.shift();
      }
      this.values.push(value);
    } else {
      waiter.resolve({done: false, value});
    }
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({done: true, value: undefined});
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    let active = true;
    let pending:
      | {resolve: (result: IteratorResult<T>) => void}
      | undefined;
    return {
      next: () => {
        if (!active) {
          return Promise.resolve({done: true, value: undefined});
        }
        const value = this.values.shift();
        if (value !== undefined) {
          return Promise.resolve({done: false, value});
        }
        if (this.closed) {
          return Promise.resolve({done: true, value: undefined});
        }
        return new Promise(resolve => {
          pending = {
            resolve: result => {
              pending = undefined;
              resolve(result);
            }
          };
          this.waiters.push(pending);
        });
      },
      return: () => {
        active = false;
        if (pending !== undefined) {
          const index = this.waiters.indexOf(pending);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          pending.resolve({done: true, value: undefined});
        }
        return Promise.resolve({done: true, value: undefined});
      }
    };
  }
}

function cleanupPending(pending: PendingRequest): void {
  clearTimeout(pending.timer);
  if (pending.abortHandler !== undefined) {
    pending.signal?.removeEventListener('abort', pending.abortHandler);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw abortReason(signal);
  }
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRemoteError(value: unknown): AppError {
  if (!isRecord(value)) {
    return new AppError(
      'serviceUnavailable',
      'Codex app-server returned an error.',
      'Press r to try again.'
    );
  }
  const code = typeof value.code === 'number' ? ` (${value.code})` : '';
  return new AppError(
    'serviceUnavailable',
    `Codex app-server returned an error${code}.`,
    'Press r to try again.'
  );
}
