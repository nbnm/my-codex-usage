import {randomUUID} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {chmod, mkdir, open, readFile, unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {PACKAGE_VERSION} from '../domain/types.js';

export type InstanceLeaseRecord = {
  ownerId: string;
  pid: number;
  version: string;
  startedAt: string;
};

export class InstanceAlreadyRunningError extends Error {
  readonly owner: InstanceLeaseRecord;

  constructor(owner: InstanceLeaseRecord) {
    super(
      `another my-codex-usage instance is running (PID ${owner.pid}, version ${owner.version}). ` +
      'Quit it, confirm `my-codex-usage --version` is current, and try again.'
    );
    this.name = 'InstanceAlreadyRunningError';
    this.owner = owner;
  }
}

export function defaultInstanceLeasePath(): string {
  return join(
    homedir(),
    'Library',
    'Application Support',
    'my-codex-usage',
    'instance-v4.lock'
  );
}

export type InstanceLeaseOptions = {
  ownerId?: string;
  pid?: number;
  version?: string;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
};

export class InstanceLease {
  readonly filePath: string;
  readonly owner: InstanceLeaseRecord;
  private readonly isProcessAlive: (pid: number) => boolean;
  private ownsLease = false;

  constructor(
    filePath: string = defaultInstanceLeasePath(),
    options: InstanceLeaseOptions = {}
  ) {
    this.filePath = filePath;
    this.owner = {
      ownerId: options.ownerId ?? randomUUID(),
      pid: options.pid ?? process.pid,
      version: options.version ?? PACKAGE_VERSION,
      startedAt: (options.now ?? (() => new Date()))().toISOString()
    };
    this.isProcessAlive = options.isProcessAlive ?? processIsAlive;
  }

  async acquire(): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, {recursive: true, mode: 0o700});
    await chmod(directory, 0o700);

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const handle = await open(
          this.filePath,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
          0o600
        );
        try {
          await handle.writeFile(`${JSON.stringify(this.owner)}\n`, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await chmod(this.filePath, 0o600);
        this.ownsLease = true;
        return;
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) {
          throw error;
        }
      }

      const existingText = await readFile(this.filePath, 'utf8').catch(error => {
        if (isNodeError(error, 'ENOENT')) {
          return undefined;
        }
        throw error;
      });
      if (existingText === undefined) {
        continue;
      }
      const existing = parseLease(existingText);
      if (existing !== undefined && this.isProcessAlive(existing.pid)) {
        throw new InstanceAlreadyRunningError(existing);
      }

      const confirmedText = await readFile(this.filePath, 'utf8').catch(
        error => {
          if (isNodeError(error, 'ENOENT')) {
            return undefined;
          }
          throw error;
        }
      );
      if (confirmedText === existingText) {
        await unlink(this.filePath).catch(error => {
          if (!isNodeError(error, 'ENOENT')) {
            throw error;
          }
        });
      }
    }
    throw new Error('Unable to acquire the my-codex-usage instance lease.');
  }

  async release(): Promise<void> {
    if (!this.ownsLease) {
      return;
    }
    try {
      const text = await readFile(this.filePath, 'utf8');
      const current = parseLease(text);
      if (current?.ownerId === this.owner.ownerId) {
        await unlink(this.filePath);
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) {
        throw error;
      }
    } finally {
      this.ownsLease = false;
    }
  }
}

function parseLease(text: string): InstanceLeaseRecord | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.ownerId !== 'string' ||
      record.ownerId.length === 0 ||
      !Number.isSafeInteger(record.pid) ||
      (record.pid as number) <= 0 ||
      typeof record.version !== 'string' ||
      typeof record.startedAt !== 'string' ||
      Number.isNaN(Date.parse(record.startedAt))
    ) {
      return undefined;
    }
    return {
      ownerId: record.ownerId,
      pid: record.pid as number,
      version: record.version,
      startedAt: record.startedAt
    };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
