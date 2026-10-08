# Repository Guidance

## Purpose and Sources of Truth

This repository builds `my-codex-usage`, a local TypeScript terminal dashboard
that reads Codex account usage through a child `codex app-server`.

Before changing behavior or architecture, read:

1. [PRD.md](PRD.md) — authoritative product and engineering requirements.
2. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — required MVP sequence and
   acceptance gates.
3. This file — repository working agreements.

Reference stable PRD requirement IDs in tests and implementation summaries.
When requirements change, update both specification files in the same change.
Do not implement deferred scope without explicit approval.

## Runtime and Project Layout

- macOS 14 or newer
- Node.js 22 or newer
- npm with a committed `package-lock.json`
- TypeScript in strict ESM mode
- Ink 7 and React 19 for interactive terminal rendering
- Vitest and Ink testing utilities for automated tests
- Codex CLI 0.144.3 as the initial protocol baseline

Organize sources by responsibility:

```text
src/
├── cli/
├── codex/
├── domain/
├── persistence/
├── refresh/
├── tui/
└── plain/

test/
├── fixtures/
├── unit/
├── integration/
└── tui/
```

Responsibilities:

- `cli/`: argument parsing, mode selection, dependency composition, signals,
  exit codes.
- `codex/`: executable discovery, version checks, child process, JSONL/RPC,
  runtime DTO parsing, typed account client, and privacy-bounded local aggregate
  reader plus the narrowly scoped current-day token-metadata reader.
- `domain/`: normalized limits, daily usage, dashboard state, formatting-safe
  calculations.
- `persistence/`: versioned sanitized history, atomic writes, permissions,
  retention, corrupt-file quarantine.
- `refresh/`: serialized full/live refresh scopes, coalescing, promotion,
  partial success, staleness, scheduling, and cached-state preservation.
- `tui/`: Ink components, keyboard input, adaptive layout, charts, help.
- `plain/`: deterministic ANSI-free output.

Protocol DTOs, domain models, persisted records, and renderer props must remain
separate types. UI code must not spawn child processes or write storage.

## Required Commands

Run these from the repository root:

```bash
node --version
npm --version
codex --version
npm ci
npm run typecheck
npm test
npm run build
npm run clean
```

For development:

```bash
npm run dev -- --plain
npm link
my-codex-usage
```

For package validation:

```bash
npm pack
npm install -g ./my-codex-usage-*.tgz
```

Use a temporary npm prefix for automated install smoke tests. Do not publish to
the npm registry without explicit user authorization.

When changing the supported Codex version or protocol DTOs, generate schemas in
a temporary directory and review the account-method diff:

```bash
codex_schema_dir="$(mktemp -d)"
codex app-server generate-json-schema --out "$codex_schema_dir"
rg -n \
  'account/read|account/rateLimits/read|account/usage/read' \
  "$codex_schema_dir"
```

Do not commit full generated schema bundles. Commit only small sanitized
fixtures required by tests. Fixtures must contain no real email, account ID,
token, prompt, response, thread/turn ID, path, or source content.

## TypeScript and Concurrency Rules

- Enable strict type checking, `noUncheckedIndexedAccess`, exact optional
  properties, and Node ESM module semantics.
- Use explicit runtime parsing at untrusted JSON boundaries. Type assertions
  alone are not validation.
- Accept unknown fields and documented optional fields; reject missing required
  shapes with typed compatibility errors.
- Use `AbortSignal` for request cancellation and shutdown.
- Keep one owner for child-process lifetime and one owner for the JSON-RPC
  pending-request map.
- Settle every pending request exactly once on response, timeout, abort, parse
  failure that invalidates correlation, or process exit.
- Coalesce refreshes by returning the same in-flight promise.
- A full refresh may satisfy a live request. When full work arrives during a
  live refresh, queue one full refresh and serialize it behind the active work.
- Inject clocks, process launchers, file locations, timers, and transports.
  Tests must not wait for real five-minute intervals or use a real account.
- Avoid module-level mutable state except immutable constants.
- Do not use `any` in production code. Prefer `unknown` plus narrowing.
- Never use non-null assertions to bypass protocol uncertainty.
- Keep display-safe errors as enumerated categories with static user messages.

## Codex Security Boundary

Allowed app-server messages:

- `initialize`
- `initialized`
- `account/read`
- `account/login/start` with exactly `{type: "chatgpt"}`
- `account/rateLimits/read`
- `account/usage/read`
- `account/login/completed` notification

Account or limit notifications may be observed only as a signal for a read-only
refetch. Correctness must not depend on their delivery.

Never, except for the exact current-day metadata exception below:

- call `thread/*`, `turn/*`, `item/*`, agent, API-key login,
  `chatgptAuthTokens`, mutation, or rate-limit-reset methods;
- read Codex authentication files or store OAuth/API credentials;
- expose app-server over TCP, WebSocket, a Unix socket, or another listener;
- store or print raw stdout, stderr, or protocol messages;
- persist or log login IDs, authorization URLs, device codes, or login
  notification error text;
- log or persist email addresses, account identifiers, prompts, responses,
  repository paths, file names, source content, thread IDs, or turn IDs; the
  only path-derived value allowed to leave the current-day reader is the safe
  final project-folder label required by `TODAY-011`;
- install, update, move, or modify the user's Codex CLI; or
- add telemetry, a backend, or another outbound integration.

Raw child stderr may exist only in the bounded in-memory ring required by
`RPC-008` and must be cleared on process close.

The dashboard local-state exception is the fixed read-only aggregate required by
`LOCAL-001`–`LOCAL-003`. It must:

- use `/usr/bin/sqlite3 -readonly` with fixed arguments and no shell;
- select only aggregate `threads.tokens_used` and `MAX(threads.updated_at)`;
- never enumerate or select thread IDs, titles, paths, previews, or rollout
  locations;
- keep `codexHome`, the database path, output, and errors in memory only; and
- remain optional so its failure cannot hide current limits or service usage.

The sole session-event exception is `TODAY-001`–`TODAY-005`. It must:

- run only for the default/explicit current-day mode and include only events
  timestamped in the current UTC day;
- inspect only regular `.jsonl` files under the initialized Codex session and
  archived-session roots, never follow symbolic links, and include older
  sessions only when their file was updated during the current UTC day;
- read only top-level timestamps, `turn_context` model/effort/`cwd`, and
  `event_msg.token_count.info.last_token_usage` numeric counters;
- reduce `cwd` immediately to a display-safe final folder name and, only when
  contained beneath `<codexHome>/worktrees`, a bounded
  `worktrees/<relative-components>` display path; discard the absolute path and
  never return, log, render, or persist any other identifier, path, prompt,
  response, reasoning text, command, tool content, or raw record;
- use fatal UTF-8 decoding, a 4 MiB per-line limit, safe non-negative integers,
  cancellation, and bounded display-safe skip counts; and
- remain read-only, current-day-only, non-persistent, local-only, partial, and
  mathematically isolated from service usage, joined Activity, limits,
  summaries, and history.

Project-folder attribution must follow `TODAY-011`: require an absolute macOS
path, use only its final non-control component, reject unsafe or overlong
labels, and fall back to `unknown`. Worktree attribution must follow
`TODAY-012`: normalize both roots, prove containment beneath the managed
worktree root, reject traversal/control components, return only a
Codex-home-relative path, and include it in the aggregation key. Never expose
an absolute path or a non-worktree parent. Never persist or log either value.

Credit estimates for current-day rows must follow `TODAY-009`–`TODAY-010`:

- keep the rate card immutable, typed, and matched through explicit sanitized
  model aliases; never infer a rate from a similar-looking unknown model;
- price uncached input as `input - cached`, cached input separately, and output
  once; cache-write and reasoning counters are informational subsets and must
  not be charged again;
- show research-preview and unknown models as unpriced, and label any aggregate
  as a subtotal for priced groups when unpriced groups exist; and
- keep all estimates in memory and label them partial base-rate estimates, not
  invoices or authoritative service accounting.

Current-day presentation must follow `TODAY-013`: render only Input, Cached,
Output, Reason, and Credits. Keep cache-write, counted, protocol-total, and
unattributed values out of TUI/plain output and warnings. Cached is an Input
subset and Reasoning is an Output subset. Never price omitted counters.

## Domain and Persistence Rules

- Normalize every valid primary, secondary, and limit-ID-specific window.
- Derive labels from supplied metadata; do not hard-code five-hour, weekly, or
  an assumed number of windows.
- Clamp only the display-facing remaining percentage.
- Merge duplicates before rendering or persistence.
- Preserve service-provided daily `YYYY-MM-DD` keys without timezone
  conversion.
- Treat service daily buckets as aggregate tokens. Do not attribute them to a
  model or limit, and do not fabricate missing buckets as authoritative zeroes.
- Always represent the current UTC day as incomplete. Persist its exact bucket
  only when Codex supplies one; never synthesize or persist an estimate or zero
  for an absent current-day bucket.
- Parse and persist only the approved sanitized usage-summary values: lifetime
  tokens, current and longest streak days, peak daily tokens, and
  longest-running turn seconds.
- Derive per-day limit changes only from local hourly observations, keep the
  result in memory, and label it as partial observed change rather than complete
  consumption.
- Bucket observed limit history by UTC clock hour.
- Retain 180 days of hourly limit history, one year of daily usage, and at most
  100 sanitized diagnostics no older than 30 days.
- Failed and partial refreshes must preserve the latest valid snapshot.
- Treat service daily lag as source metadata, not a failed request. Never write
  local aggregate tokens into service daily buckets, summaries, or lifetime
  totals. A derived joined range may select local values only for today or
  missing/pending service dates.
- Persist only source-success timestamps and one sanitized local aggregate
  observation series in schema version 4. Migrate valid v1/v2/v3 files in
  memory.
- Store current data only in `history-v4.json`; treat `history.json` as a
  read-only legacy migration source and never modify, rename, quarantine, or
  delete it.
- The first local aggregate sample of each UTC day is a zero-delta baseline.
  Add only positive same-day changes, retain positive changes across aggregate
  resets, increment reset counts, and never carry a delta across midnight.
- Retain 180 days of sanitized local daily observations. Never let them mutate
  raw service periods, service-only audit statistics, summaries, or lifetime
  totals. Joined periods and their scale/statistics may use local values under
  the documented coverage rule, but never add both sources for one day.
- Expose retained sanitized local days through `DashboardSnapshot` and derive
  local daily/weekly periods and statistics in the domain layer. A sampled zero
  is observed; an unsampled date remains missing.
- Write history atomically with user-only directory and file permissions.
- Corrupt history must be quarantined, never silently overwritten in place.

## Terminal UI Rules

- Interactive mode requires TTY stdin/stdout and a usable `TERM`.
- Interactive mode must use Ink's built-in alternate-screen option so the
  primary terminal and scrollback are hidden while running and restored on
  every exit. Do not manually emit clear-screen or buffer-switch escapes.
- Plain mode must never contain ANSI color, cursor, or alternate-screen
  sequences.
- Meaning must not rely on color. Always show status, values, and reset times in
  text.
- Honor `NO_COLOR` and `--no-color`.
- Treat 80×24 as the baseline layout and test smaller terminals.
- Provide a compact limits view below 60 columns or 16 rows.
- Give the joined Activity plot and active history plot the full usable width
  and approximately 40% of normal terminal height. Use 6–18 plot rows normally
  and 3–6 rows at 16–23 terminal rows. Cap plots by space reserved for required
  text.
- Keep chart renderers independent from Ink. They must return structured rows
  of `low`, `medium`, `high`, `axis`, `muted`, `selected`, `service`, `local`,
  and `mixed` segments so volume, provenance, and no-color glyphs can be tested
  without a terminal.
- Use zero baselines. Scale joined Activity bars against the peak selected
  value from the complete range, including when a ninety- or 180-day viewport
  scrolls. Scale used-capacity history to a fixed 0–100%.
- Daily seven-/thirty-day plots must include every day. Ninety-/180-day daily
  plots and weekly plots that do not fit use a centered, clamped viewport with
  at least two columns per period and keep the selection visible.
- Keep filled activity-bar widths identical within a viewport. Remainder
  columns belong to cell spacing, not bar width, and all guides must use the
  same cell-center geometry.
- Calendar axes use UTC date keys and collision-safe labels. Prefer all dates
  at seven days, Mondays/month boundaries for longer daily views, and month
  transitions for weekly views; omit a label rather than overlap or truncate.
- Mark Saturday/Sunday UTC as non-working days in daily activity and continuous
  history guides. Preserve a text/glyph distinction when color is disabled and
  do not override usage-band colors.
- Use green for 0–50%, yellow above 50–75%, and red above 75–100%. In no-color
  mode use `░`, `▒`, and `█`; retain a separate caret or bold selection marker.
- State in chart text that daily colors are relative token volume, not quota
  health. Never connect observations across a period with no local sample.
- Keep cached content visible while refreshing.
- Show source-specific freshness and a separate `Live observed activity`
  section carrying the exact `local observation—not service-accounted daily
  usage` label.
- Keyboard changes must update the `?` help view and tests in the same change.
- Shared ranges are exactly 7, 30, 90, and 180 trailing calendar days.
  Activity grouping is `day` or Monday–Sunday UTC `week`; Left/Right selects a
  period or observation and Up/Down selects the limit.
- Derive joined daily values before weekly aggregation. Completed reported days
  use service; today and missing/pending service dates use retained local values
  when present. Weekly joined periods sum those selected daily values, retain
  source and missing-day coverage, and remain partial when local data, missing
  days, boundaries, or the current day contribute. Never add both sources for
  one day or fabricate a missing value as zero.
- Completeness is separate from availability: current daily/weekly periods are
  incomplete whether their available service buckets are reported or pending.
- Range statistics must distinguish reported-period and active-period
  averages. Explicitly reported zeroes participate in the former and in
  deterministic minimum/maximum selection.
- Use a single non-neutral root within each chart, reserve semantic colors for
  status, and provide glyph/text distinctions for every colored state.
- Managed login must be reachable with `l` only from an unauthenticated state;
  browser credential entry remains entirely user-controlled.
- Every exit path must close app-server and restore terminal state.
- Interactive and plain dashboard refresh commands must acquire the user-only
  single-instance lease before loading state. Help, version, usage errors, and
  unsupported-platform paths bypass it. Default/explicit current-day mode also
  bypasses it because it never writes shared history. Reclaim only verified stale leases and
  release only a lease whose owner ID matches the current owner.
- Daily mode prefers today when a local observation exists and uses that value
  in the joined chart while separately disclosing any incomplete service
  bucket.
- The Activity panel always shows one joined plot with no source switch.
  Source glyphs are `S` for service, `L` for local, and `M` for mixed weekly
  coverage; selection and source remain distinct without color.
- Joined statistics must be calculated from exactly the plotted values and
  report service/local/missing coverage. Preserve raw service and local models
  for provenance and audits, and never alter authoritative service summaries.
- Plain output renders joined periods and statistics first, then compact
  service and local audit sections. `--no-local` may use persisted observations
  but must identify sampling as disabled.
- The default/`--today` current snapshot is a dedicated console, not another
  dashboard panel. It must show
  current-UTC-day local rows grouped by sanitized project folder, optional
  Codex-home-relative worktree path, model, and effort with input, cached
  input, output, reasoning output, and display-safe base credit
  estimates. `--dashboard` selects the historical
  interface. The current snapshot
  refreshes every ten seconds, uses `r`/`?`/`q`/Escape, preserves the latest
  valid scan, and uses the same alternate-screen and no-color guarantees.
- Tests that change interactive startup or teardown must verify alternate-screen
  entry/exit ordering, cursor restoration, and an untouched plain-mode path.

## Dependency and Change Discipline

- Keep changes focused and preserve unrelated user work.
- Ink, React, TypeScript, TSX, Vitest, and Ink testing utilities are the
  approved dependency set. Any additional runtime dependency requires explicit
  approval and a documented architectural reason.
- Prefer Node built-ins for argument parsing, child processes, files, timers,
  and formatting.
- Add or update tests with every behavior change.
- Do not weaken privacy, runtime validation, or compatibility behavior to make
  a fixture pass.
- Do not add Linux, standalone-binary, background-monitor, notification,
  export, prediction, or publishing work to MVP.
- Cleanup commands and scripts must name exact generated targets. Do not use
  broad `git clean`, repository-wide globs, or cleanup of `node_modules`.
- Production type checking must enable `noUnusedLocals` and
  `noUnusedParameters`.
- Keep the package constant, package manifest, lockfile, app-server initialize
  metadata, lease metadata, and CLI version output aligned at `0.2.0` for this
  release.

## Completion Definition

A change is complete only when:

- `npm run typecheck`, `npm test`, and `npm run build` pass;
- affected interactive and plain states are verified;
- the packed package installs and exposes the expected command when packaging
  is affected;
- storage and diagnostic inspection finds no prohibited fields;
- child processes and terminal state are cleaned up;
- changed behavior is traceable to PRD requirement IDs; and
- `PRD.md` and `IMPLEMENTATION_PLAN.md` are updated when requirements changed.
