import {constants as fsConstants} from 'node:fs';
import {access, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {delimiter, isAbsolute, join} from 'node:path';
import {spawn} from 'node:child_process';
import {AppError} from '../domain/errors.js';
import {
  MINIMUM_CODEX_VERSION,
  type CodexExecutable
} from '../domain/types.js';

export type DiscoveryOptions = {
  argumentPath: string | undefined;
  environment?: NodeJS.ProcessEnv;
  versionTimeoutMs?: number;
};

export type SemanticVersion = {
  major: number;
  minor: number;
  patch: number;
  raw: string;
};

export async function discoverCodex(
  options: DiscoveryOptions
): Promise<CodexExecutable> {
  const environment = options.environment ?? process.env;
  const timeoutMs = options.versionTimeoutMs ?? 5_000;

  if (options.argumentPath !== undefined) {
    return validateExplicitCandidate(options.argumentPath, timeoutMs);
  }
  if (environment.CODEX_PATH !== undefined && environment.CODEX_PATH.trim() !== '') {
    return validateExplicitCandidate(environment.CODEX_PATH, timeoutMs);
  }

  const candidates: string[] = [];
  for (const directory of (environment.PATH ?? '').split(delimiter)) {
    if (directory.trim() !== '') {
      candidates.push(join(directory, 'codex'));
    }
  }

  const userHome = homedir();
  candidates.push(
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(userHome, '.local', 'bin', 'codex'),
    join(userHome, '.npm-global', 'bin', 'codex'),
    join(userHome, '.local', 'share', 'pnpm', 'codex'),
    join(userHome, 'Library', 'pnpm', 'codex')
  );

  for (const candidate of [...new Set(candidates)]) {
    if (!(await isExecutableFile(candidate))) {
      continue;
    }
    return validateCandidate(candidate, timeoutMs);
  }

  throw new AppError(
    'cliMissing',
    'Codex CLI was not found.',
    'Install Codex or pass --codex /absolute/path/to/codex.'
  );
}

export function parseSemanticVersion(output: string): SemanticVersion | undefined {
  const match = /(?:^|[^\d])v?(\d+)\.(\d+)\.(\d+)(?:[^\d]|$)/u.exec(output);
  if (match === null) {
    return undefined;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return undefined;
  }
  return {major, minor, patch, raw: `${major}.${minor}.${patch}`};
}

export function compareSemanticVersions(
  left: SemanticVersion,
  right: SemanticVersion
): number {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch
  );
}

async function validateExplicitCandidate(
  candidate: string,
  timeoutMs: number
): Promise<CodexExecutable> {
  if (!isAbsolute(candidate) || !(await isExecutableFile(candidate))) {
    throw new AppError(
      'cliInvalid',
      'The selected Codex executable is invalid.',
      'Pass an absolute path to an executable codex file.'
    );
  }
  return validateCandidate(candidate, timeoutMs);
}

async function validateCandidate(
  candidate: string,
  timeoutMs: number
): Promise<CodexExecutable> {
  const output = await readVersion(candidate, timeoutMs);
  const version = parseSemanticVersion(output);
  if (version === undefined) {
    throw new AppError(
      'cliInvalid',
      'The Codex version could not be determined.',
      'Run codex --version and verify the selected executable.'
    );
  }

  const minimum = parseSemanticVersion(MINIMUM_CODEX_VERSION);
  if (minimum === undefined) {
    throw new AppError(
      'cliIncompatible',
      'The built-in minimum Codex version is invalid.',
      'Update my-codex-usage.'
    );
  }
  if (compareSemanticVersions(version, minimum) < 0) {
    throw new AppError(
      'cliIncompatible',
      `Codex ${version.raw} is older than the required ${MINIMUM_CODEX_VERSION}.`,
      'Update Codex and run the command again.'
    );
  }
  return {path: candidate, version: version.raw};
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) {
      return false;
    }
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readVersion(candidate: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(candidate, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      reject(
        new AppError(
          'cliInvalid',
          'Timed out while checking the Codex version.',
          'Run codex --version and verify the installation.'
        )
      );
    }, timeoutMs);
    timer.unref();

    const capture = (chunk: Buffer): void => {
      if (output.length < 4_096) {
        output += chunk.toString('utf8').slice(0, 4_096 - output.length);
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', error => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(
        new AppError(
          'cliInvalid',
          'Could not run the selected Codex executable.',
          'Verify the Codex installation.',
          {cause: error}
        )
      );
    });
    child.once('close', code => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new AppError(
            'cliInvalid',
            'The selected Codex executable failed its version check.',
            'Run codex --version and verify the installation.'
          )
        );
        return;
      }
      resolve(output);
    });
  });
}
