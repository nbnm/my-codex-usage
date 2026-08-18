import {AppError} from '../domain/errors.js';

const DEFAULT_LINE_LIMIT = 4 * 1024 * 1024;

export class JsonLineDecoder {
  private buffer = Buffer.alloc(0);
  private readonly maximumLineBytes: number;
  private readonly utf8 = new TextDecoder('utf-8', {fatal: true});

  constructor(maximumLineBytes: number = DEFAULT_LINE_LIMIT) {
    this.maximumLineBytes = maximumLineBytes;
  }

  push(chunk: Uint8Array): unknown[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const values: unknown[] = [];

    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.length > this.maximumLineBytes) {
          throw malformed('App-server sent an oversized JSON line.');
        }
        return values;
      }
      if (newline > this.maximumLineBytes) {
        throw malformed('App-server sent an oversized JSON line.');
      }

      let line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, -1);
      }
      if (line.length === 0) {
        continue;
      }

      try {
        const text = this.utf8.decode(line);
        values.push(JSON.parse(text) as unknown);
      } catch (error) {
        throw new AppError(
          'protocolMalformed',
          'Codex app-server returned malformed JSON.',
          'Press r to restart the connection.',
          {cause: error}
        );
      }
    }
  }

  finish(): void {
    if (this.buffer.length === 0) {
      return;
    }
    if (this.buffer.every(byte => byte === 0x0d || byte === 0x20 || byte === 0x09)) {
      this.buffer = Buffer.alloc(0);
      return;
    }
    throw malformed('Codex app-server ended with an incomplete JSON line.');
  }
}

function malformed(message: string): AppError {
  return new AppError(
    'protocolMalformed',
    message,
    'Press r to restart the connection.'
  );
}
