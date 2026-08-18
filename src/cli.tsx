#!/usr/bin/env node

import {stderr, stdout} from 'node:process';
import {render} from 'ink';
import {AppServerAccountClient} from './codex/client.js';
import {discoverCodex} from './codex/discovery.js';
import {SqliteLocalUsageSource} from './codex/local-usage.js';
import {SessionTodayUsageSource} from './codex/today-usage.js';
import {NodeJsonRpcTransport} from './codex/transport.js';
import {
  CliUsageError,
  helpText,
  parseCliArguments,
  shouldUsePlainMode
} from './cli/args.js';
import {
  InstanceAlreadyRunningError,
  InstanceLease
} from './cli/instance-lease.js';
import {openAuthorizationUrl} from './cli/open-url.js';
import {INTERACTIVE_RENDER_OPTIONS} from './cli/terminal.js';
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  type CodexExecutable,
  type TodayUsageSnapshot,
  type TodayUsageSource
} from './domain/types.js';
import {toDisplaySafeError} from './domain/errors.js';
import {FileHistoryStore} from './persistence/history-store.js';
import {plainExitCode, renderPlain} from './plain/render.js';
import {renderTodayPlain, todayPlainExitCode} from './plain/today.js';
import {RefreshCoordinator} from './refresh/coordinator.js';
import {UsageApp} from './tui/App.js';
import {TodayUsageApp} from './tui/TodayUsageApp.js';

async function main(argv: string[]): Promise<number> {
  let options;
  try {
    options = parseCliArguments(argv);
  } catch (error) {
    if (error instanceof CliUsageError) {
      stderr.write(`${PACKAGE_NAME}: ${error.message}\n\n${helpText()}`);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    stdout.write(helpText());
    return 0;
  }
  if (options.version) {
    stdout.write(`${PACKAGE_VERSION}\n`);
    return 0;
  }
  if (process.platform !== 'darwin') {
    stderr.write(`${PACKAGE_NAME}: this MVP supports macOS only.\n`);
    return 1;
  }
  if (options.today) {
    return runTodayMode(options);
  }

  const lease = new InstanceLease();
  try {
    await lease.acquire();
  } catch (error) {
    if (error instanceof InstanceAlreadyRunningError) {
      stderr.write(`${PACKAGE_NAME}: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const store = new FileHistoryStore();
  const coordinator = new RefreshCoordinator({
    store,
    discover: () =>
      discoverCodex({
        argumentPath: options.codexPath
      }),
    createClient: (executable: CodexExecutable) =>
      new AppServerAccountClient(
        new NodeJsonRpcTransport({executablePath: executable.path}),
        PACKAGE_VERSION
      ),
    localUsageSource: new SqliteLocalUsageSource(),
    localEnabled: options.local
  });

  try {
    const cached = await coordinator.loadCached();
    if (shouldUsePlainMode(options)) {
      const snapshot = await coordinator.refresh('launch');
      stdout.write(
        renderPlain(snapshot, options.range, options.granularity)
      );
      return plainExitCode(snapshot);
    }

    const instance = render(
      <UsageApp
        coordinator={coordinator}
        initialState={cached}
        initialRange={options.range}
        initialGranularity={options.granularity}
        color={options.color}
        openUrl={openAuthorizationUrl}
      />,
      INTERACTIVE_RENDER_OPTIONS
    );
    const stop = (): void => {
      instance.unmount();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await instance.waitUntilExit();
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
    return 0;
  } finally {
    await coordinator.close();
    await lease.release();
  }
}

async function runTodayMode(
  options: ReturnType<typeof parseCliArguments>
): Promise<number> {
  let codexVersion: string | undefined;
  let codexHome = '';
  let source: TodayUsageSource = new SessionTodayUsageSource();
  let setupSnapshot: TodayUsageSnapshot | undefined;
  let client: AppServerAccountClient | undefined;

  try {
    const executable = await discoverCodex({
      argumentPath: options.codexPath
    });
    codexVersion = executable.version;
    client = new AppServerAccountClient(
      new NodeJsonRpcTransport({executablePath: executable.path}),
      PACKAGE_VERSION
    );
    codexHome = (await client.initialize()).codexHome;
  } catch (error) {
    const safe = toDisplaySafeError(error);
    setupSnapshot = unavailableTodaySnapshot(safe.message);
    source = {
      readToday: () => Promise.resolve(setupSnapshot ?? unavailableTodaySnapshot())
    };
  } finally {
    await client?.close();
  }

  if (shouldUsePlainMode(options)) {
    const snapshot = setupSnapshot ?? (await source.readToday(codexHome));
    stdout.write(renderTodayPlain(snapshot, codexVersion));
    return todayPlainExitCode(snapshot);
  }

  const instance = render(
    <TodayUsageApp
      source={source}
      codexHome={codexHome}
      codexVersion={codexVersion}
      color={options.color}
    />,
    INTERACTIVE_RENDER_OPTIONS
  );
  const stop = (): void => {
    instance.unmount();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await instance.waitUntilExit();
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  return setupSnapshot === undefined ? 0 : 1;
}

function unavailableTodaySnapshot(
  warning = 'Current-day local token metadata is unavailable.'
): TodayUsageSnapshot {
  const sampledAt = new Date().toISOString();
  return {
    status: 'unavailable',
    dayKey: sampledAt.slice(0, 10),
    sampledAt,
    groups: [],
    total: {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0
    },
    scannedFileCount: 0,
    tokenEventCount: 0,
    skippedRecordCount: 0,
    skippedFileCount: 0,
    warning
  };
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch {
  stderr.write(
    `${PACKAGE_NAME}: an unexpected error occurred. Run with --plain and try again.\n`
  );
  process.exitCode = 1;
}
