import {isAbsolute} from 'node:path';
import {parseArgs} from 'node:util';
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  type UsageGranularity,
  type UsageRange
} from '../domain/types.js';

export type CliOptions = {
  plain: boolean;
  today: boolean;
  dashboard: boolean;
  range: UsageRange;
  granularity: UsageGranularity;
  codexPath: string | undefined;
  local: boolean;
  color: boolean;
  help: boolean;
  version: boolean;
};

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export function parseCliArguments(argv: string[]): CliOptions {
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        plain: {type: 'boolean'},
        today: {type: 'boolean'},
        dashboard: {type: 'boolean'},
        range: {type: 'string'},
        group: {type: 'string'},
        codex: {type: 'string'},
        'no-color': {type: 'boolean'},
        'no-local': {type: 'boolean'},
        help: {type: 'boolean', short: 'h'},
        version: {type: 'boolean', short: 'v'}
      }
    });

    const rawRange = parsed.values.range ?? '30';
    if (
      rawRange !== '7' &&
      rawRange !== '30' &&
      rawRange !== '90' &&
      rawRange !== '180'
    ) {
      throw new CliUsageError('--range must be 7, 30, 90, or 180.');
    }
    const rawGranularity = parsed.values.group ?? 'day';
    if (rawGranularity !== 'day' && rawGranularity !== 'week') {
      throw new CliUsageError('--group must be day or week.');
    }
    const codexPath = parsed.values.codex;
    if (codexPath !== undefined && !isAbsolute(codexPath)) {
      throw new CliUsageError('--codex must be an absolute path.');
    }
    const explicitToday = parsed.values.today ?? false;
    const explicitDashboard = parsed.values.dashboard ?? false;
    if (explicitToday && explicitDashboard) {
      throw new CliUsageError('--today and --dashboard cannot be combined.');
    }
    const hasDashboardOnlyOption =
      parsed.values.range !== undefined ||
      parsed.values.group !== undefined ||
      parsed.values['no-local'] !== undefined;
    if (
      explicitToday &&
      hasDashboardOnlyOption
    ) {
      throw new CliUsageError(
        '--today cannot be combined with --range, --group, or --no-local.'
      );
    }
    const today = explicitToday || (!explicitDashboard && !hasDashboardOnlyOption);

    return {
      plain: parsed.values.plain ?? false,
      today,
      dashboard: !today,
      range:
        rawRange === '180'
          ? 180
          : rawRange === '90'
            ? 90
            : rawRange === '30'
              ? 30
              : 7,
      granularity: rawGranularity,
      codexPath,
      local: !(parsed.values['no-local'] ?? false),
      color: !(parsed.values['no-color'] ?? false) && !('NO_COLOR' in process.env),
      help: parsed.values.help ?? false,
      version: parsed.values.version ?? false
    };
  } catch (error) {
    if (error instanceof CliUsageError) {
      throw error;
    }
    throw new CliUsageError(
      error instanceof Error ? error.message : 'Invalid command arguments.'
    );
  }
}

export function shouldUsePlainMode(
  options: CliOptions,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
  term: string | undefined = process.env.TERM
): boolean {
  return (
    options.plain ||
    input.isTTY !== true ||
    output.isTTY !== true ||
    term === undefined ||
    term.toLowerCase() === 'dumb'
  );
}

export function helpText(): string {
  return `${PACKAGE_NAME} ${PACKAGE_VERSION}

Current-day Codex tokens and estimated credits by default.
The historical dashboard is available with --dashboard.
One refresh-capable historical dashboard instance may run at a time.

Usage:
  ${PACKAGE_NAME} [--today] [options]
  ${PACKAGE_NAME} --dashboard [dashboard options]

Options:
  --plain              Print one ANSI-free snapshot and exit
  --today              Explicitly select the default current-day snapshot
  --dashboard          Show historical limits and token activity
  --range <7|30|90|180> Dashboard trailing-day range (default: 30)
  --group <day|week>   Dashboard activity grouping (default: day)
  --codex <path>       Absolute path to the Codex executable
  --no-color           Disable color styling
  --no-local           Disable near-live local aggregate sampling
  -h, --help           Show this help
  -v, --version        Show the installed version

Historical dashboard keys:
  r refresh    l login    Tab switch panel    d cycle 7/30/90/180 days
  w toggle day/week    ←/→ select time    ↑/↓ select limit
  ? help    q/Escape quit

Default current-day mode:
  ${PACKAGE_NAME} [--today] [--plain] [--codex <path>] [--no-color]
  r refresh    ? help    q/Escape quit    auto-refresh every 10 seconds
`;
}
