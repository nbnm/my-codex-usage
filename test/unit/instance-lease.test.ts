import {
  mkdtemp,
  readFile,
  stat,
  writeFile
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  InstanceAlreadyRunningError,
  InstanceLease
} from '../../src/cli/instance-lease.js';

describe('InstanceLease', () => {
  it('writes a user-only lease and removes it for its owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'my-codex-usage-lease-'));
    const file = join(root, 'nested', 'instance-v4.lock');
    const lease = new InstanceLease(file, {
      ownerId: 'owner-a',
      pid: 123,
      version: '0.2.0',
      now: () => new Date('2026-07-27T12:00:00.000Z'),
      isProcessAlive: () => false
    });
    await lease.acquire();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, 'nested'))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      ownerId: 'owner-a',
      pid: 123,
      version: '0.2.0',
      startedAt: '2026-07-27T12:00:00.000Z'
    });
    await lease.release();
    await expect(stat(file)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('rejects a live owner without replacing its lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'my-codex-usage-live-'));
    const file = join(root, 'instance-v4.lock');
    const owner = {
      ownerId: 'running-owner',
      pid: 456,
      version: '0.1.0',
      startedAt: '2026-07-27T11:00:00.000Z'
    };
    const text = `${JSON.stringify(owner)}\n`;
    await writeFile(file, text, {mode: 0o600});
    const lease = new InstanceLease(file, {
      ownerId: 'new-owner',
      pid: 789,
      isProcessAlive: pid => pid === owner.pid
    });
    await expect(lease.acquire()).rejects.toEqual(
      expect.objectContaining({
        name: 'InstanceAlreadyRunningError',
        owner
      })
    );
    expect(await readFile(file, 'utf8')).toBe(text);
  });

  it('reclaims stale and malformed leases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'my-codex-usage-stale-'));
    const file = join(root, 'instance-v4.lock');
    await writeFile(
      file,
      `${JSON.stringify({
        ownerId: 'stale-owner',
        pid: 456,
        version: '0.1.0',
        startedAt: '2026-07-27T11:00:00.000Z'
      })}\n`,
      {mode: 0o600}
    );
    const lease = new InstanceLease(file, {
      ownerId: 'new-owner',
      pid: 789,
      isProcessAlive: () => false
    });
    await lease.acquire();
    expect(JSON.parse(await readFile(file, 'utf8')).ownerId).toBe('new-owner');
    await lease.release();

    await writeFile(file, '{malformed', {mode: 0o600});
    const replacement = new InstanceLease(file, {
      ownerId: 'replacement-owner',
      pid: 790,
      isProcessAlive: () => false
    });
    await replacement.acquire();
    expect(JSON.parse(await readFile(file, 'utf8')).ownerId).toBe(
      'replacement-owner'
    );
    await replacement.release();
  });

  it('does not release a lease now owned by another process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'my-codex-usage-owner-'));
    const file = join(root, 'instance-v4.lock');
    const lease = new InstanceLease(file, {
      ownerId: 'owner-a',
      pid: 123,
      isProcessAlive: () => false
    });
    await lease.acquire();
    const replacement = {
      ownerId: 'owner-b',
      pid: 456,
      version: '0.2.0',
      startedAt: '2026-07-27T12:01:00.000Z'
    };
    await writeFile(file, `${JSON.stringify(replacement)}\n`, {mode: 0o600});
    await lease.release();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(replacement);
  });

  it('exposes upgrade guidance for a live owner', () => {
    const error = new InstanceAlreadyRunningError({
      ownerId: 'owner',
      pid: 123,
      version: '0.1.0',
      startedAt: '2026-07-27T12:00:00.000Z'
    });
    expect(error.message).toMatch(/Quit it/u);
    expect(error.message).toMatch(/--version/u);
  });
});
