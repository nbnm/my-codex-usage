import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  compareSemanticVersions,
  discoverCodex,
  parseSemanticVersion
} from '../../src/codex/discovery.js';

describe('Codex executable discovery', () => {
  it('parses prefixed versions and compares them numerically', () => {
    const current = parseSemanticVersion('codex-cli 0.144.3');
    const older = parseSemanticVersion('v0.99.12');
    expect(current).toEqual({major: 0, minor: 144, patch: 3, raw: '0.144.3'});
    expect(older).toBeDefined();
    expect(compareSemanticVersions(current!, older!)).toBeGreaterThan(0);
  });

  it('validates an explicit executable and PATH discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'my-codex-usage-discovery-'));
    const codex = join(root, 'codex');
    await writeFile(codex, '#!/bin/sh\nprintf "codex-cli 0.144.3\\n"\n', {
      mode: 0o755
    });

    await expect(
      discoverCodex({argumentPath: codex})
    ).resolves.toEqual({path: codex, version: '0.144.3'});
    await expect(
      discoverCodex({
        argumentPath: undefined,
        environment: {PATH: root}
      })
    ).resolves.toEqual({path: codex, version: '0.144.3'});
  });

  it('rejects old versions and bounded version-command timeouts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'my-codex-usage-version-'));
    const oldCodex = join(root, 'old-codex');
    await writeFile(oldCodex, '#!/bin/sh\nprintf "codex-cli 0.100.0\\n"\n', {
      mode: 0o755
    });
    await expect(
      discoverCodex({argumentPath: oldCodex})
    ).rejects.toMatchObject({category: 'cliIncompatible'});

    const slowCodex = join(root, 'slow-codex');
    await writeFile(slowCodex, '#!/bin/sh\nsleep 1\n', {mode: 0o755});
    await expect(
      discoverCodex({argumentPath: slowCodex, versionTimeoutMs: 10})
    ).rejects.toMatchObject({category: 'cliInvalid'});
  });
});
