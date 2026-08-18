import {spawn} from 'node:child_process';
import {AppError} from '../domain/errors.js';

export async function openAuthorizationUrl(value: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidAuthorizationUrl();
  }
  if (url.protocol !== 'https:') {
    throw invalidAuthorizationUrl();
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/open', [url.toString()], {
      stdio: 'ignore'
    });
    child.once('error', error => {
      reject(
        new AppError(
          'serviceUnavailable',
          'The authorization page could not be opened.',
          'Press l to try again.',
          {cause: error}
        )
      );
    });
    child.once('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new AppError(
            'serviceUnavailable',
            'The authorization page could not be opened.',
            'Press l to try again.'
          )
        );
      }
    });
  });
}

function invalidAuthorizationUrl(): AppError {
  return new AppError(
    'protocolIncompatible',
    'Codex returned an invalid authorization URL.',
    'Update Codex or my-codex-usage.'
  );
}
