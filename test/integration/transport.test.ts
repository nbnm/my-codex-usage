import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {AppServerAccountClient} from '../../src/codex/client.js';
import {NodeJsonRpcTransport} from '../../src/codex/transport.js';
import {PACKAGE_VERSION} from '../../src/domain/types.js';

const fixture = fileURLToPath(
  new URL('../fixtures/fake-app-server.mjs', import.meta.url)
);
const transports: NodeJsonRpcTransport[] = [];

function transport(
  scenario: string,
  requestTimeoutMs: number = 1_000
): NodeJsonRpcTransport {
  const instance = new NodeJsonRpcTransport({
    executablePath: '/unused/codex',
    requestTimeoutMs,
    spawnProcess: () =>
      spawn(process.execPath, [fixture, scenario], {
        stdio: ['pipe', 'pipe', 'pipe']
      })
  });
  transports.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(transports.splice(0).map(item => item.close()));
});

describe('NodeJsonRpcTransport', () => {
  it('correlates responses received out of order', async () => {
    const rpc = transport('out-of-order');
    await rpc.connect();
    const slow = rpc.request<{method: string}>('slow');
    const fast = rpc.request<{method: string}>('fast');
    await expect(fast).resolves.toEqual({method: 'fast'});
    await expect(slow).resolves.toEqual({method: 'slow'});
  });

  it('rejects malformed traffic, timeouts, and termination', async () => {
    const malformed = transport('malformed');
    await malformed.connect();
    await expect(malformed.request('test')).rejects.toMatchObject({
      category: 'protocolMalformed'
    });

    const ignored = transport('ignore', 20);
    await ignored.connect();
    await expect(ignored.request('test')).rejects.toMatchObject({
      category: 'requestTimeout'
    });

    const terminated = transport('terminate');
    await terminated.connect();
    await expect(terminated.request('test')).rejects.toMatchObject({
      category: 'processFailed'
    });
  });

  it('supports AbortSignal cancellation and bounds captured stderr', async () => {
    const ignored = transport('ignore', 1_000);
    await ignored.connect();
    const controller = new AbortController();
    const request = ignored.request('test', undefined, controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({name: 'AbortError'});

    const noisy = transport('stderr');
    await noisy.connect();
    await expect(noisy.request('initialize')).resolves.toMatchObject({
      platformOs: 'macos'
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(noisy.stderrByteCountForTesting()).toBe(65_536);
  });

  it('performs the real account handshake against a controllable server', async () => {
    const rpc = transport('normal');
    const client = new AppServerAccountClient(rpc, PACKAGE_VERSION);
    await expect(client.initialize()).resolves.toEqual({
      codexHome: '/sanitized/codex-home'
    });
    await expect(client.readAccount()).resolves.toEqual({
      kind: 'chatgpt',
      planType: 'plus'
    });
    await expect(client.readRateLimits()).resolves.toMatchObject({
      rateLimits: {limitId: 'codex'}
    });
    await expect(client.readUsage()).resolves.toEqual({
      summary: {
        lifetimeTokens: 1234,
        currentStreakDays: 4,
        longestStreakDays: 13,
        peakDailyTokens: 456,
        longestRunningTurnSec: 5375
      },
      dailyUsageBuckets: [{startDate: '2026-07-24', tokens: 456}]
    });
  });

  it('covers signed-out, API-key, and partial server scenarios', async () => {
    const signedOut = new AppServerAccountClient(
      transport('signed-out'),
      PACKAGE_VERSION
    );
    await signedOut.initialize();
    await expect(signedOut.readAccount()).resolves.toEqual({kind: 'signedOut'});

    const apiKey = new AppServerAccountClient(
      transport('api-key'),
      PACKAGE_VERSION
    );
    await apiKey.initialize();
    await expect(apiKey.readAccount()).resolves.toEqual({
      kind: 'apiKeyUnsupported'
    });

    const partial = new AppServerAccountClient(
      transport('partial'),
      PACKAGE_VERSION
    );
    await partial.initialize();
    await expect(partial.readRateLimits()).resolves.toBeDefined();
    await expect(partial.readUsage()).rejects.toMatchObject({
      category: 'serviceUnavailable'
    });
  });

  it('completes managed login and ignores mismatched completion IDs', async () => {
    for (const scenario of ['login-success', 'login-mismatch']) {
      const client = new AppServerAccountClient(
        transport(scenario),
        PACKAGE_VERSION
      );
      await client.initialize();
      await expect(client.readAccount()).resolves.toEqual({kind: 'signedOut'});
      const prompt = await client.startChatGPTLogin();
      expect(prompt).toEqual({
        authUrl: 'https://example.invalid/authorize',
        loginId: 'fixture-login'
      });
      await expect(
        client.waitForLoginCompletion(prompt.loginId)
      ).resolves.toBeUndefined();
      await expect(client.readAccount()).resolves.toEqual({
        kind: 'chatgpt',
        planType: 'plus'
      });
    }
  });

  it('returns a display-safe error when managed login fails', async () => {
    const client = new AppServerAccountClient(
      transport('login-failure'),
      PACKAGE_VERSION
    );
    await client.initialize();
    const prompt = await client.startChatGPTLogin();
    await expect(
      client.waitForLoginCompletion(prompt.loginId)
    ).rejects.toMatchObject({
      category: 'unauthenticated',
      message: 'ChatGPT authorization did not complete.'
    });
  });

  it('cancels a pending managed login wait', async () => {
    const client = new AppServerAccountClient(
      transport('login-slow'),
      PACKAGE_VERSION
    );
    await client.initialize();
    const prompt = await client.startChatGPTLogin();
    const controller = new AbortController();
    const waiting = client.waitForLoginCompletion(
      prompt.loginId,
      controller.signal
    );
    controller.abort();
    await expect(waiting).rejects.toMatchObject({name: 'AbortError'});
  });
});
