# My Codex Usage

`my-codex-usage` is a local terminal dashboard for current-day Codex tokens,
base credit estimates, account limits, reset times, service-reported activity,
and privacy-bounded local observations. An argument-free launch opens the live
current-day project/worktree/model/effort snapshot; `--dashboard` opens
historical usage. It runs on macOS, communicates with the installed
`codex app-server`, and does not require a separate backend.

The dashboard joins two Activity sources into one coverage-aware series:

- **Service usage** is the authoritative daily or weekly token history returned
  by Codex. Service buckets can arrive several days after the activity occurred.
- **Local observations** are partial token increases measured while this tool is
  sampling Codex's local state. They fill today or a service gap until a delayed
  completed-day service bucket arrives.

The chart never adds both sources for the same day. Completed reported days use
service values; today and missing/pending service dates use available local
values. Joined totals and statistics describe exactly those plotted selections,
not an authoritative service-accounted total.

## Features

- Every current Codex rate-limit window, remaining capacity, reset time, and
  duration.
- Full-width Activity and limit-history charts for 7, 30, 90, or 180 days.
- Daily and Monday–Sunday UTC weekly aggregation.
- One full-width joined Activity chart with visible service/local provenance.
- Exact selected-period values, averages, minima, maxima, and coverage.
- Interactive Ink TUI and deterministic ANSI-free `--plain` output.
- Five-minute service refreshes and one-minute current-limit/local refreshes.
- Sanitized local history with no telemetry, backend, or credential parsing.
- Automatic alternate-screen restoration when the interactive dashboard exits.
- A default current-day local breakdown by project folder, managed-worktree
  path, model, and reasoning effort with input, cached input, output, reasoning
  output, and embedded-rate-card credit estimates.

## Purpose and architecture

The tool answers two related questions without sending usage data to another
service:

1. **What is Codex using today?** The default current-day console reads only
   bounded token metadata from local Codex session events and attributes it to
   a sanitized project folder, optional managed-worktree path, model, and
   effort.
2. **How are my account limits and recent activity changing?** The historical
   dashboard reads the account, rate-limit, and usage methods exposed by the
   local Codex app-server and combines delayed service buckets with clearly
   labeled partial local observations.

The executable has two isolated runtime paths:

```text
my-codex-usage (src/cli.tsx)
├── default / --today
│   ├── discover Codex and initialize app-server to locate Codex home
│   ├── close app-server
│   ├── scan current-UTC-day token metadata read-only
│   ├── aggregate by project/worktree/model/effort in memory
│   └── render with Ink or deterministic plain text
└── --dashboard
    ├── acquire the single-writer lease and load sanitized history
    ├── keep one JSONL app-server client alive
    ├── refresh account, rate limits, and service usage
    ├── sample the fixed read-only SQLite aggregate when enabled
    ├── normalize, join, and persist bounded domain history
    └── render with Ink or deterministic plain text
```

The layers deliberately keep protocol data, calculations, persistence, and UI
separate:

| Layer | Source | Responsibility |
| --- | --- | --- |
| CLI and lifecycle | `src/cli.tsx`, `src/cli/` | Parse options, choose today/dashboard and interactive/plain modes, own signals, alternate-screen lifecycle, and the dashboard lease. |
| Codex integration | `src/codex/` | Discover and validate Codex, own the child process and JSON-RPC transport, parse untrusted DTOs, and perform the two narrowly bounded local reads. |
| Domain | `src/domain/` | Normalize limits and usage, calculate joined periods and statistics, aggregate current-day rows, and estimate credits. |
| Refresh and persistence | `src/refresh/`, `src/persistence/` | Serialize refresh scopes, preserve usable cached state, migrate and atomically write sanitized history, and enforce retention. |
| Presentation | `src/tui/`, `src/plain/` | Render domain state only; these layers never spawn Codex or write storage. |

Service buckets, local dashboard observations, and current-day session metadata
remain distinct source types. The joined historical chart selects one value per
day by documented coverage rules; it never adds overlapping sources. The
current-day table is non-persistent and never feeds account totals, charts, or
history. See [PRD.md](PRD.md) for the exact security and accounting contracts.

## Requirements

| Requirement | Minimum | Notes |
| --- | --- | --- |
| macOS | 14 or newer | Linux and Windows are not supported by this MVP. |
| Node.js | 22 or newer | Includes the npm client used to build and install the package. |
| npm | Compatible with Node.js 22+ | The lockfile was generated with npm 11. |
| Codex CLI | 0.144.3 or newer | The app-server protocol is experimental and version-sensitive. |
| SQLite CLI | `/usr/bin/sqlite3` | Included with supported macOS versions and used read-only. |
| Authentication | ChatGPT-backed Codex login | API-key-only accounts do not expose subscription usage limits. |

Verify the local environment before installing:

```bash
sw_vers -productVersion
node --version
npm --version
codex --version
codex login status
/usr/bin/sqlite3 --version
```

`node --version` must report `v22` or newer. `codex --version` must report
`codex-cli 0.144.3` or newer.

If Node.js is not installed, install a current Node.js release from the
[official Node.js download page](https://nodejs.org/en/download).

## Install and authenticate Codex

Install or update the official Codex CLI:

```bash
npm install --global @openai/codex
codex --version
```

Sign in through the ChatGPT browser flow:

```bash
codex login
codex login status
```

Choose **Sign in with ChatGPT** when prompted. This dashboard requires the
ChatGPT-backed account state because API-key-only authentication does not
provide the subscription rate-limit and daily-usage information it displays.

The dashboard can also start the same ChatGPT browser flow when it detects a
signed-out account: launch it and press `l`. Browser credential entry remains
entirely controlled by Codex and ChatGPT.

See the official [Codex CLI guide](https://learn.chatgpt.com/docs/codex/cli)
and [OpenAI authentication guide](https://learn.chatgpt.com/docs/auth) for
current Codex installation and login guidance.

## Install `my-codex-usage`

The package is private and is not published to the npm registry. Do not run:

```text
npm install --global my-codex-usage
```

Install it from an existing repository checkout or downloaded source archive.

### Recommended: packed global installation

From the repository root:

```bash
cd /path/to/my-codex-usage

npm ci
npm run typecheck
npm test
npm run build

package_dir="$(mktemp -d)"
npm pack --pack-destination "$package_dir"
npm install --global "$package_dir"/my-codex-usage-*.tgz

my-codex-usage --version
```

The final command must print:

```text
0.2.0
```

Confirm that the executable is on `PATH`:

```bash
command -v my-codex-usage
my-codex-usage --help
```

The temporary package directory may be removed after installation. The globally
installed command no longer depends on that tarball.

### Development installation

Use an npm link when actively changing the source:

```bash
cd /path/to/my-codex-usage

npm ci
npm run dev -- --plain
npm run typecheck
npm test
npm run build
npm link

my-codex-usage --version
my-codex-usage
```

`npm run dev -- --plain` runs the TypeScript entry point directly. `npm link`
exposes the repository build as the global `my-codex-usage` command.

Before replacing a linked development command with a packed build, unlink it:

```bash
npm unlink --global my-codex-usage
```

Then repeat the packed global installation steps.

## Quick start

1. Confirm that Codex is logged in with ChatGPT:

   ```bash
   codex login status
   ```

2. Launch the interactive current-day snapshot:

   ```bash
   my-codex-usage
   ```

3. Review token and estimated-credit totals grouped by project folder, exact model, and effort.
   The snapshot refreshes every ten seconds.
4. Press `q` or Escape to exit. The previous terminal screen and scrollback are
   restored.

To open the historical limits and Activity dashboard instead:

```bash
my-codex-usage --dashboard
```

The default current-day view is local and partial. It reports only token events
available in local Codex session files for the current UTC day; it is not the
service-accounted daily bucket. It needs a working Codex installation but does
not require an account usage call or a ChatGPT login to read already-local
events.

For a non-interactive snapshot:

```bash
my-codex-usage --plain
```

## Command-line options

| Option | Behavior |
| --- | --- |
| `--plain` | Scan once, print a non-ANSI report for the selected view, and exit. With no view option, this is the current-day snapshot. |
| `--today` | Explicitly select the default current-UTC-day local token and credit snapshot. |
| `--dashboard` | Open the historical limits and joined-Activity dashboard. |
| `--range 7` | Start with the trailing 7-day range. |
| `--range 30` | Start the historical dashboard with the trailing 30-day range. This is its default. |
| `--range 90` | Start with the trailing 90-day range. |
| `--range 180` | Start with the trailing 180-day range. |
| `--group day` | Group Activity by UTC calendar day. This is the default. |
| `--group week` | Group the selected trailing-day range into Monday–Sunday UTC weeks. |
| `--codex /absolute/path/to/codex` | Use a specific executable instead of automatic discovery. The path must be absolute. |
| `--no-color` | Disable ANSI color while preserving glyph and text distinctions. |
| `--no-local` | Stop new local aggregate sampling for this invocation. Previously persisted local observations remain visible. |
| `-h`, `--help` | Print command help without acquiring the instance lease. |
| `-v`, `--version` | Print package version without acquiring the instance lease. |

Examples:

```bash
my-codex-usage
my-codex-usage --today
my-codex-usage --plain
my-codex-usage --dashboard
my-codex-usage --dashboard --range 30
my-codex-usage --dashboard --range 180 --group week
my-codex-usage --dashboard --plain --range 90
my-codex-usage --codex /opt/homebrew/bin/codex
my-codex-usage --no-color
NO_COLOR=1 my-codex-usage
my-codex-usage --dashboard --no-local
```

For backward compatibility, `--range`, `--group`, or `--no-local` also imply
`--dashboard` when neither view flag is present. Explicit `--today` cannot be
combined with those dashboard-only options.

Codex discovery uses this order:

1. `--codex`;
2. `CODEX_PATH`;
3. each executable named `codex` on `PATH`;
4. supported common macOS installation locations.

## Interactive keys

| Key | Action |
| --- | --- |
| `r` | Perform a full account, rate-limit, service-usage, and local refresh. |
| `l` | Start ChatGPT login when the dashboard is signed out. |
| Tab | Cycle Activity, limit history, and usage overview. |
| `d` | Cycle `7 → 30 → 90 → 180 → 7` days. |
| `w` | Toggle daily and Monday–Sunday UTC weekly Activity. |
| Left/Right | Select a day, week, or exact history observation. |
| Up/Down | Select the limit used by limit-history and observed-change views. |
| `?` | Open or close keyboard help. |
| `q`, Escape | Quit and restore the previous terminal screen. |
| Ctrl+C | Quit through the dashboard's managed cleanup path. |

The Activity panel uses one joined series. Left/Right selects a calendar period;
range and day/week changes recalculate the same coverage-aware series. Source
glyphs identify `S` service, `L` local, and `M` mixed weekly coverage.

The default/`--today` console has a smaller key set: `r` refreshes immediately,
`?` toggles help, and `q` or Escape quits. It automatically refreshes every ten
seconds.

## Interactive and plain modes

Interactive mode requires:

- TTY stdin;
- TTY stdout; and
- a usable `TERM` value other than `dumb`.

It uses the terminal's alternate screen, like `vim` or `htop`. The normal
terminal contents are hidden while the dashboard is running and restored on
`q`, Escape, Ctrl+C, SIGINT, SIGTERM, renderer failure, or normal exit.

The application automatically uses plain mode for pipes, redirected output,
`TERM=dumb`, or non-interactive environments:

```bash
my-codex-usage --plain
my-codex-usage --plain > usage-report.txt
my-codex-usage | sed -n '1,40p'
TERM=dumb my-codex-usage
```

Plain output never includes cursor movement, color, or alternate-screen escape
sequences. The argument-free/plain path prints the current-day table. Use
`my-codex-usage --dashboard --plain` for joined periods, statistics, and compact
service/local provenance audits. `--today` cannot be combined with `--range`,
`--group`, or `--no-local` because those options describe the historical
dashboard.

### Current-day project, worktree, model, and effort breakdown

Codex's account usage endpoint exposes aggregate daily buckets, not a project,
model, or reasoning-effort split. The dedicated mode reads the per-response
token-count metadata and active working-directory context that Codex writes to
local session event files. It groups each event by sanitized project-folder
name, active model, and effort.

The token field names match Codex's documented JSONL turn-completion usage and
app-server token-usage structures; see the official
[Codex non-interactive mode reference](https://learn.chatgpt.com/docs/non-interactive-mode)
and [app-server reference](https://learn.chatgpt.com/docs/app-server).

Columns are:

- **Project** — only the final folder name from the turn's working directory;
- **Worktree** — `worktrees/<relative-components>` for a Codex-managed
  worktree, relative to Codex home; local checkout rows show `—`;
- **Model** — the exact model string recorded for the turn;
- **Effort** — the exact reasoning-effort string recorded for the turn;
- **Input** — protocol input tokens;
- **Cached input** — Codex's cached-input token counter, a subset of Input;
- **Output** — protocol output tokens;
- **Reasoning output** — Codex's reasoning-output token counter, a subset of
  Output;
- **Credits** — a partial base-rate estimate for the exact matched model.

Write, Counted, Protocol, and Unattributed are intentionally omitted from both
interactive and plain output. They are not needed for the base credit estimate.
Rows are grouped by project-folder label, optional managed-worktree path, exact
model, and effort strings; missing or unsafe metadata appears as
`unknown`. Only the final folder component is kept for a normal checkout: for
example, `/Volumes/Work/example-app` becomes `example-app`. If the directory is
beneath Codex home's managed `worktrees` folder, the Worktree column
additionally shows a relative value such as
`worktrees/<worktree>/<project>`. This keeps two worktrees with the same project
basename separate without displaying the absolute Codex home or user home.
Detailed rows and worktree paths are never persisted.

Credits are estimated with:

```text
uncached input = max(input − cached input, 0)
credits = uncached input × input rate / 1,000,000
        + cached input × cached rate / 1,000,000
        + output × output rate / 1,000,000
```

Cache-write input is already contained in the input category, and reasoning
output is already contained in output, so neither is charged a second time.
The embedded rate card is:

| Model | Input / 1M | Cached input / 1M | Output / 1M |
| --- | ---: | ---: | ---: |
| GPT-5.6 Sol | 125 credits | 12.5 credits | 750 credits |
| Daybreak Blue | 125 credits | 12.5 credits | 750 credits |
| Daybreak Red | 312.5 credits | 31.25 credits | 1,875 credits |
| GPT-5.6 Terra | 50 credits | 5 credits | 300 credits |
| GPT-5.6 Luna | 5 credits | 0.5 credits | 30 credits |
| GPT-5.5 | 125 credits | 12.5 credits | 750 credits |
| GPT-5.4 | 62.5 credits | 6.25 credits | 375 credits |
| GPT-5.4 mini | 18.75 credits | 1.875 credits | 113 credits |
| GPT-5.3-Codex-Spark | Research preview; no numeric rate | — | — |
| GPT-Image-2 (image) | 200 credits | 50 credits | 750 credits |
| GPT-Image-2 (text) | 125 credits | 31.25 credits | 250 credits |

The displayed credit number is not an invoice or authoritative account
deduction. Unknown model aliases remain unpriced, and the estimate may omit
fast-mode, tool, enterprise-legacy, or other service adjustments. The rate card
comes from the official [Codex usage limits and credits reference](https://learn.chatgpt.com/docs/pricing).

This mode is deliberately bounded:

- only events timestamped in the current UTC day are counted;
- sessions created earlier but updated today are eligible;
- cloud-only, ephemeral, deleted, unavailable, and not-yet-flushed activity is
  not visible;
- the reader ignores all prompts, responses, reasoning text, commands, IDs,
  titles, repository content, parent/absolute paths, and tool content;
- detailed rows are never persisted or merged with the dashboard history; and
- the result is a partial local observation, not an account invoice or an
  authoritative daily service total.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Successful command, or plain output contained usable limits, service history, or local history. |
| `1` | No usable data, unsupported platform, another live instance, or an operational failure. |
| `2` | Invalid command-line arguments. |

## Understanding the data

### Service usage

Service daily buckets come from `account/usage/read` and are the authoritative
aggregate account token history. They can lag recent Codex sessions even when
the request itself succeeds.

- Missing buckets are shown as missing or pending, never as zero.
- The current UTC day and week are always marked incomplete.
- Raw service audits and lifetime summary metrics remain authoritative and
  service-only.

### Joined Activity

The interactive chart and primary plain-output section use one stable coverage
rule:

- a completed day with a reported service bucket uses the service value;
- the current UTC day uses a local observation when one exists;
- a missing or pending service date uses a retained local observation when one
  exists;
- a date without either source remains missing; and
- a delayed completed-day service bucket replaces the prior local selection.

Service and local values for one day are never added. Weekly mode first applies
the daily rule, then sums the selected daily values. A weekly bar may therefore
be `S` service-only, `L` local-only, or `M` mixed. Any local contribution keeps
the joined period explicitly partial and non-authoritative.

### Local observations

When enabled, the dashboard runs one fixed read-only aggregate query against
Codex's local `state_5.sqlite`. The first sample of each UTC day establishes a
zero-delta baseline. Later positive increases are accumulated for that day.

Consequences:

- Usage before the first sample is unknown.
- The dashboard must be running to collect new one-minute samples.
- A day with samples but no increase is an observed zero.
- A day without samples is missing, not zero.
- Aggregate decreases begin a new segment and never create negative usage.
- Local audit values remain available separately in plain output.
- Joined colors represent volume relative to the joined range peak.
- A red Activity bar does not mean a Codex quota is exhausted.

Retained local dates, including yesterday, automatically fill joined chart gaps
until the equivalent service bucket arrives. Local values remain labeled
`local observation—not service-accounted daily usage`.

### Limit history

Current limits refresh every minute while the TUI is open. Locally observed
limit history is bucketed by UTC hour and retained for 180 days. Its chart shows
percentage used on a fixed 0–100% scale.

## Refresh behavior

| Trigger | Work performed |
| --- | --- |
| Launch | Full account, limits, service usage, and optional local refresh. |
| `r` | Full refresh. |
| Every 60 seconds | Current limits and optional local aggregate. |
| Every 5 minutes | Full refresh including account and service usage. |

Only one refresh-capable process may run at a time. A user-only lease prevents
multiple dashboards or plain refreshes from writing history concurrently.
`--help`, `--version`, and argument errors do not acquire this lease.
The read-only, non-persistent default/`--today` mode also bypasses the writer
lease, so it may be inspected while the historical dashboard is running.

## Storage and retention

Current sanitized state is stored at:

```text
~/Library/Application Support/my-codex-usage/history-v4.json
```

The directory may also contain:

| File | Purpose |
| --- | --- |
| `history-v4.json` | Current sanitized history and source timestamps. |
| `history.json` | Read-only legacy migration source. Version 0.2.0 never changes or deletes it. |
| `instance-v4.lock` | Active-process owner ID, PID, version, and start time. Removed by its owner on exit. |
| `*.corrupt-*` | Quarantined corrupt current-version history, when recovery was necessary. |

Retention limits:

- service daily buckets: one year;
- local daily observations: 180 days;
- hourly limit observations: 180 days;
- sanitized diagnostics: at most 100 entries and no older than 30 days.

History writes use a temporary file followed by atomic replacement. The
application directory and files use user-only permissions.

## Privacy and security

The application is local-only and read-only toward Codex.

It may call only:

- `initialize` and `initialized`;
- `account/read`;
- `account/rateLimits/read`;
- `account/usage/read`;
- the managed ChatGPT `account/login/start` flow; and
- the corresponding login-completion notification.

The optional SQLite source uses `/usr/bin/sqlite3 -readonly` with fixed
arguments and returns only:

- non-negative `SUM(threads.tokens_used)`; and
- `MAX(threads.updated_at)`.

The dashboard does not read or persist:

- Codex authentication files or credentials;
- emails or account identifiers;
- thread, turn, or item identifiers;
- titles, prompts, responses, previews, absolute paths, unrelated parent paths,
  or source content;
- raw app-server stdout, stderr, or protocol traffic; or
- telemetry or backend data.

Use `--no-local` if local aggregate sampling is not desired.

The default/explicit `--today` exception reads only timestamps,
model/effort/working-directory metadata, and numeric token counters from
eligible current-day local session events. It keeps a display-safe final
project-folder name and, for a contained Codex-managed worktree only, a bounded
path relative to Codex home. It does not follow symbolic links and never
returns, logs, renders, or persists the absolute path, unrelated parent
folders, ignored content-bearing fields, or raw records. The relative worktree
path is current-day display metadata only and is never persisted.

## Updating

Quit the active dashboard with `q` or Escape before updating.

From the repository root:

```bash
npm ci
npm run typecheck
npm test
npm run build

package_dir="$(mktemp -d)"
npm pack --pack-destination "$package_dir"
npm install --global "$package_dir"/my-codex-usage-*.tgz

my-codex-usage --version
```

The package is not published automatically. Updating Codex itself is separate:

```bash
npm install --global @openai/codex
codex --version
```

## Uninstalling

Quit the dashboard, then remove the global npm command:

```bash
npm uninstall --global my-codex-usage
```

Uninstalling the package intentionally preserves local history. To inspect the
remaining application data:

```bash
ls -la "$HOME/Library/Application Support/my-codex-usage"
```

To remove only the current v4 history after reviewing it:

```bash
rm "$HOME/Library/Application Support/my-codex-usage/history-v4.json"
```

This does not remove the read-only legacy `history.json` or any explicitly
quarantined files.

## Troubleshooting

### `my-codex-usage: command not found`

Confirm the npm global prefix and installed executable:

```bash
npm prefix --global
ls -l "$(npm prefix --global)/bin/my-codex-usage"
```

For the current shell, add the npm global binary directory to `PATH`:

```bash
export PATH="$(npm prefix --global)/bin:$PATH"
```

Add the equivalent export to `~/.zshrc` if it should persist in future shells.

### Node.js or Codex is missing or too old

```bash
node --version
codex --version
```

Install Node.js 22 or newer, then install or update Codex:

```bash
npm install --global @openai/codex
```

If Codex is installed somewhere unusual, use an absolute path:

```bash
my-codex-usage --codex /absolute/path/to/codex
```

### The dashboard says sign-in is required

Check the current authentication method:

```bash
codex login status
```

Run `codex login` and complete **Sign in with ChatGPT**, or press `l` in the
dashboard. An API-key-only login remains unsupported for subscription usage
monitoring.

### Another instance is running

Only one interactive or plain refresh process may own the history lease. Return
to the running dashboard and quit with `q` or Escape, then retry. Do not delete
the lease while its owner is running.

`my-codex-usage --help` and `my-codex-usage --version` remain available while
another instance is active.

### Recent service usage is missing

A successful service response can still contain delayed daily buckets. Check
the displayed `service through YYYY-MM-DD` date and the source glyph beneath
each joined Activity bar. `L` identifies a partial local gap fill, while `S`
identifies a service value.

Local observations are partial and start at the first sample of each UTC day.
They cannot reconstruct usage that occurred before sampling began.

### Local observations are missing or unavailable

Confirm the macOS SQLite executable exists:

```bash
test -x /usr/bin/sqlite3 && /usr/bin/sqlite3 --version
```

The local database must also have been initialized by Codex. Missing or
incompatible local state affects only the optional local section; current
limits and service usage continue working.

`--no-local` stops new samples but still permits display of sanitized local
history already stored on disk.

### Plain output appears instead of the TUI

Check terminal detection:

```bash
test -t 0 && echo "stdin is a TTY" || echo "stdin is not a TTY"
test -t 1 && echo "stdout is a TTY" || echo "stdout is not a TTY"
echo "${TERM:-unset}"
```

Interactive mode requires both TTY streams and a `TERM` value other than
`dumb`. Pipes and redirection intentionally select plain mode.

### Charts are compact, clipped, or difficult to distinguish

The full dashboard requires at least 60 columns and 16 rows; 80×24 or larger is
recommended. Inspect the current terminal dimensions with:

```bash
stty size
```

Resize the terminal and rerun the command. Disable color without losing
meaning:

```bash
my-codex-usage --no-color
```

No-color charts use `░`, `▒`, and `█`, and mark UTC weekends with `W`.

## Development

Available npm scripts:

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the exact dependency versions from `package-lock.json`. |
| `npm run dev -- --plain` | Run the TypeScript CLI directly in plain mode. |
| `npm run typecheck` | Run strict TypeScript checks without emitting files. |
| `npm test` | Run the complete Vitest suite once. |
| `npm run test:watch` | Run Vitest in watch mode. |
| `npm run build` | Clean `dist`, compile production JavaScript, and mark the executable runnable. |
| `npm run clean` | Remove only the generated `dist` directory. |
| `npm link` | Link the current package into npm's global command directory. |

Before handing off a change:

```bash
npm run typecheck
npm test
npm run build
```

When packaging is affected, validate a tarball in a temporary npm prefix rather
than overwriting the user's global installation.

Contributor workflow:

1. Read [PRD.md](PRD.md), [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), and
   [AGENTS.md](AGENTS.md), then identify the requirement IDs affected by the
   change.
2. Keep process/protocol work in `src/codex`, calculations in `src/domain`,
   history writes in `src/persistence`, coordination in `src/refresh`, and
   rendering in `src/tui` or `src/plain`.
3. Update the PRD and implementation plan in the same change when behavior or
   architecture changes.
4. Add focused unit, integration, or render coverage and run the three
   validation commands above.
5. If packaging changes, create the tarball in a temporary directory and smoke
   test it with a temporary npm prefix. Do not publish it to npm.

## Project documentation

- [PRD.md](PRD.md) is the authoritative product and engineering specification.
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) records the acceptance-gated
  implementation.
- [AGENTS.md](AGENTS.md) defines repository conventions, security boundaries,
  and completion requirements.

Setup and operation correspond to `CLI-001`–`CLI-011`, `AUTH-002`–`AUTH-007`,
`LOCAL-001`–`LOCAL-007`, `TODAY-001`–`TODAY-013`, and
`TUI-031`–`TUI-036` in the PRD.
