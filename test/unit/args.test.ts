import {describe, expect, it} from 'vitest';
import {
  CliUsageError,
  helpText,
  parseCliArguments,
  shouldUsePlainMode
} from '../../src/cli/args.js';

describe('CLI arguments', () => {
  it('parses the public options', () => {
    expect(parseCliArguments([]).range).toBe(30);
    expect(parseCliArguments([])).toMatchObject({today: true, dashboard: false});
    expect(
      parseCliArguments([
        '--plain',
        '--range',
        '180',
        '--group',
        'week',
        '--codex',
        '/opt/homebrew/bin/codex',
        '--no-color',
        '--no-local'
      ])
    ).toMatchObject({
      plain: true,
      today: false,
      dashboard: true,
      range: 180,
      granularity: 'week',
      codexPath: '/opt/homebrew/bin/codex',
      local: false,
      color: false
    });
  });

  it('rejects invalid range and relative executable paths', () => {
    expect(() => parseCliArguments(['--range', '14'])).toThrow(CliUsageError);
    expect(parseCliArguments(['--range', '90']).range).toBe(90);
    expect(parseCliArguments(['--range', '180']).range).toBe(180);
    expect(() => parseCliArguments(['--group', 'month'])).toThrow(
      CliUsageError
    );
    expect(() => parseCliArguments(['--codex', 'codex'])).toThrow(CliUsageError);
  });

  it('parses the current-day mode and rejects historical-only combinations', () => {
    expect(parseCliArguments(['--today', '--plain', '--no-color'])).toMatchObject({
      today: true,
      plain: true,
      color: false
    });
    expect(parseCliArguments(['--dashboard'])).toMatchObject({
      today: false,
      dashboard: true
    });
    expect(parseCliArguments(['--plain'])).toMatchObject({
      today: true,
      dashboard: false
    });
    expect(() => parseCliArguments(['--today', '--dashboard'])).toThrow(
      CliUsageError
    );
    expect(() => parseCliArguments(['--today', '--range', '30'])).toThrow(
      CliUsageError
    );
    expect(() => parseCliArguments(['--today', '--group', 'day'])).toThrow(
      CliUsageError
    );
    expect(() => parseCliArguments(['--today', '--no-local'])).toThrow(
      CliUsageError
    );
  });

  it('falls back to plain output without two TTY streams', () => {
    const tty = {isTTY: true} as unknown as NodeJS.ReadStream;
    const output = {isTTY: true} as unknown as NodeJS.WriteStream;
    const pipe = {isTTY: false} as unknown as NodeJS.ReadStream;
    const options = parseCliArguments([]);
    expect(shouldUsePlainMode(options, tty, output, 'xterm-256color')).toBe(false);
    expect(shouldUsePlainMode(options, pipe, output, 'xterm-256color')).toBe(true);
    expect(shouldUsePlainMode(options, tty, output, 'dumb')).toBe(true);
  });

  it('documents 180-day and day/week controls', () => {
    expect(helpText()).toContain('my-codex-usage 0.2.0');
    expect(helpText()).toContain(
      'One refresh-capable historical dashboard instance'
    );
    expect(helpText()).toContain('--range <7|30|90|180>');
    expect(helpText()).toContain('--today');
    expect(helpText()).toContain('--dashboard');
    expect(helpText()).toContain('Current-day Codex tokens');
    expect(helpText()).toContain('default: 30');
    expect(helpText()).toContain('--group <day|week>');
    expect(helpText()).toContain('--no-local');
    expect(helpText()).toContain('w toggle day/week');
    expect(helpText()).not.toContain('switch service/local');
  });
});
