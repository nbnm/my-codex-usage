# My Codex Usage — Product Requirements Document

- **Status:** Approved for MVP implementation
- **Product:** My Codex Usage
- **Command:** `my-codex-usage`
- **Platform:** macOS 14 or newer, Node.js 22 or newer
- **Initial Codex protocol baseline:** `codex-cli 0.144.3`
- **Package version:** `0.2.0`
- **Last updated:** 2026-08-17

## 1. Purpose

My Codex Usage is a local terminal dashboard for inspecting the current Codex
limits, their reset times, and recent usage history. Running
`my-codex-usage` opens an interactive terminal UI. A plain-output mode supports
non-interactive terminals and redirected output.

The application reads account information through a locally installed
`codex app-server`, retains bounded sanitized history on the user's Mac, and
does not inspect Codex credentials, conversations, repositories, or source
files. Because service-provided daily usage may lag active Codex work, it also
offers a privacy-bounded observation of aggregate token activity from Codex's
local state database. The Activity chart joins the sources by coverage: it uses
service values for completed reported days and partial local values for today
or service gaps, without adding overlapping same-day values.

This document is the authoritative source for product behavior.
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) defines the delivery sequence,
and [AGENTS.md](AGENTS.md) defines repository working agreements.

## 2. Problem and Users

Codex users can consume several independently resetting usage windows. The
current remaining capacity, reset times, and recent trends are not convenient
to inspect from an existing terminal workflow.

The primary user is a macOS terminal user who:

- has Node.js 22 or newer;
- has Codex CLI 0.144.3 or newer installed;
- has authenticated Codex with a ChatGPT-backed account; and
- wants a local, read-only usage dashboard without a persistent background app.

API-key-only accounts do not expose the ChatGPT subscription usage required by
the MVP. This is an unsupported authentication state, not a zero-usage state.

## 3. Core Journeys

### 3.1 Inspect usage interactively

1. The user runs `my-codex-usage`.
2. Cached history renders immediately when available.
3. The application refreshes through `codex app-server`.
4. The user reviews all current limits and one thirty-day joined Activity
   chart using service data for completed reported days and partial local
   observations for today or service gaps.
5. The user selects exact daily or weekly joined values, inspects their source
   provenance, switches among activity, limit history, and usage overview, or
   changes the range to seven, ninety, or one hundred eighty days.
6. The user presses `q` or Escape and the child process exits cleanly.

### 3.2 Capture a terminal-safe snapshot

1. The user runs `my-codex-usage --plain`, redirects stdout, or invokes the
   command without an interactive terminal.
2. The application performs one refresh.
3. A stable, non-ANSI summary is printed and the process exits.
4. Cached stale data may be printed with an explicit stale warning when a fresh
   response is unavailable.

### 3.3 Recover from an unavailable state

1. Codex is missing, incompatible, signed out, offline, or returns malformed
   data.
2. The dashboard preserves the latest valid snapshot.
3. It presents a specific, display-safe recovery message.
4. When signed out, the user presses `l`, completes the app-server-managed
   ChatGPT browser flow, and the same server connection refreshes automatically.
5. For other conditions, the user fixes the condition and presses `r`, waits
   for the next one-minute current-limit/local observation refresh, or waits
   for the next five-minute full service refresh while the TUI remains open.

## 4. Goals and Success Criteria

- Show every valid rate-limit window and its remaining percentage.
- Show reset times and full-width, vertically expanded
  seven-/thirty-/ninety-/one-hundred-eighty-day terminal charts.
- Show exact reported daily tokens, selected-range statistics, sanitized
  account usage summaries, and clearly labeled partial local limit observations.
- Show independently timestamped current limits, service daily usage, and
  privacy-bounded near-live local activity through one provenance-aware joined
  series without adding overlapping same-day values.
- Fill service gaps with retained partial local observations, replace those
  values when delayed authoritative buckets arrive, and label the joined
  result as non-authoritative whenever local coverage contributes.
- Provide a dedicated current-day console that groups local Codex token events
  by sanitized project-folder name, model, and reasoning effort and reports
  input, cached input, output, reasoning output, and an embedded-rate-card
  credit estimate without exposing session content. This console is the
  default view for an argument-free invocation.
- Start quickly, remain responsive during refresh, and restore the terminal
  after every supported exit path.
- Preserve useful sanitized local history across invocations.
- Work with the documented Node/npm toolchain and without a backend, daemon,
  telemetry, or credential access.
- Produce an npm package that installs a working `my-codex-usage` command.

MVP is successful when all acceptance criteria in section 13 pass against
sanitized fixtures and a read-only Codex CLI 0.144.3 validation.

## 5. Non-Goals

The MVP will not:

- provide a macOS menu-bar, Dock, window, notification, launch-at-login, wake,
  or background-monitoring experience;
- support Linux, Windows, a standalone bundled executable, Homebrew, or npm
  registry publication;
- start, inspect, list, or steer Codex threads, turns, items, or agents;
- read authentication files, directly handle credentials, or directly refresh
  OAuth tokens;
- support API-key-only usage monitoring or multiple accounts;
- expose a network listener or send data to a custom backend;
- consume rate-limit reset credits or call account-mutating endpoints;
- export data or expose configurable refresh intervals;
- predict exhaustion, usage pace, or future limits; or
- collect telemetry, prompts, responses, repository paths, or source content.
- reconstruct token details before the current UTC day, attribute local data to
  an account, repository, prompt, response, thread, or individual request, or
  treat the current-day local breakdown as service-accounted usage.

## 6. MVP Requirements

Requirement IDs are stable and must be referenced by implementation and tests.

### 6.1 Command and compatibility

| ID | Requirement |
| --- | --- |
| `CLI-001` | The npm package and executable name must be `my-codex-usage`. |
| `CLI-002` | `my-codex-usage` must open the interactive TUI only when stdin and stdout are TTYs and `TERM` is not `dumb`; otherwise it must use plain mode. |
| `CLI-003` | The command must support `--plain`, `--today`, `--dashboard`, `--range 7`, `--range 30`, `--range 90`, `--range 180`, `--group day`, `--group week`, `--codex <absolute-path>`, `--no-color`, `--help`, and `--version`. The historical dashboard's default range must be 30 trailing UTC days. |
| `CLI-004` | Invalid arguments must print a concise error and usage summary to stderr and exit `2`. |
| `CLI-005` | Runtime support requires macOS 14 or newer and Node.js 22 or newer. |
| `CLI-006` | Codex discovery order must be `--codex`, `CODEX_PATH`, each `PATH` entry, then documented common macOS locations. |
| `CLI-007` | Each candidate must be a regular executable file and pass `codex --version` within five seconds. |
| `CLI-008` | Codex CLI `0.144.3` is the initial minimum. Missing, invalid, or older versions must produce a specific unavailable or incompatible state. |
| `CLI-009` | Local aggregate sampling must be enabled by default and disabled only for the current command with `--no-local`. |
| `CLI-010` | Every interactive or plain refresh command must acquire one user-only single-instance lease containing only owner ID, PID, package version, and start time. A live owner must cause exit `1` with upgrade/quit guidance; stale leases may be reclaimed and only their owner may release them. Help, version, argument-error, and unsupported-platform paths must bypass the lease. |
| `CLI-011` | An argument-free invocation must select the dedicated current-UTC-day local token-breakdown mode; `--today` is an explicit alias. `--dashboard` selects the historical limits/activity dashboard, and supplying `--range`, `--group`, or `--no-local` without an explicit mode must also select that dashboard for backward compatibility. `--today` and `--dashboard` are mutually exclusive, and explicit `--today` with a dashboard-only option is a usage error. Because current-day mode is read-only and does not use shared history, it must not acquire the dashboard writer lease. |
| `COMPAT-001` | Protocol decoders must ignore unknown fields and tolerate documented nullable or optional fields. |
| `COMPAT-002` | Missing required structures or methods must produce a compatibility error rather than a crash, fabricated zero, or empty success. |

The app-server protocol is experimental and version-specific. Method names and
response shapes must be checked against schemas generated by the selected
Codex baseline. See the current
[Codex app-server reference](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).

### 6.2 Authentication

| ID | Requirement |
| --- | --- |
| `AUTH-001` | After dashboard initialization, the application must call `account/read` with `refreshToken: false`. Current-day detail mode initializes only to obtain `codexHome` and does not require account authentication. |
| `AUTH-002` | A ChatGPT-backed account is the only supported usage-monitoring account type. |
| `AUTH-003` | A null or login-required account must show an unauthenticated state with an `l` action that starts ChatGPT login on the same app-server connection. |
| `AUTH-004` | An API-key-only account must show an unsupported-authentication state and must not display missing subscription usage as zero. |
| `AUTH-005` | Interactive login must call `account/login/start` with only `{type: "chatgpt"}`, open the returned HTTPS `authUrl`, keep `loginId` in memory, and wait for the matching `account/login/completed` notification. |
| `AUTH-006` | After successful login completion, the application must re-run account, rate-limit, and usage reads on the same app-server connection. Failed or cancelled login must return to the unauthenticated state with display-safe recovery copy. |
| `AUTH-007` | The application must never use `apiKey` or internal-only `chatgptAuthTokens` login variants, inspect tokens, persist login IDs/auth URLs, or automate browser credential input. |

### 6.3 Codex app-server integration

| ID | Requirement |
| --- | --- |
| `RPC-001` | Dashboard mode must keep one `codex app-server` child process alive for the command lifetime and terminate it on shutdown. Current-day detail mode must close its initialization process before scanning local metadata. |
| `RPC-002` | Each connection must send `initialize`, await success, send `initialized`, and only then issue account requests. |
| `RPC-003` | Dashboard refreshes must call `account/rateLimits/read` and `account/usage/read`. Current-day detail mode must not call account methods. |
| `RPC-004` | JSON messages must be UTF-8, newline-delimited, and omit a required dependency on a `jsonrpc` field. |
| `RPC-005` | Request IDs must be monotonically increasing and responses must correlate correctly when received out of order. |
| `RPC-006` | Requests must support structured errors, 15-second timeouts, AbortSignal cancellation, and child termination. Pending requests must settle exactly once. |
| `RPC-007` | The line reader must handle split and combined reads, ignore blank lines, reject invalid JSON or UTF-8, and cap an unterminated line at 4 MiB. |
| `RPC-008` | Raw stderr may be held only in a 64 KiB in-memory ring for process diagnostics and must never be persisted or printed. |
| `RPC-009` | Process recovery within one refresh may retry after 1, 2, and 4 seconds. There must be no continuous retry loop after the bound. |
| `RPC-010` | Apart from the managed `account/login/start` flow in `AUTH-005`, no thread, turn, item, agent, API-key login, auth-token injection, account mutation, or reset-credit method may be invoked. |
| `RPC-011` | `account/login/completed` may be consumed only as an in-memory signal correlated to the active login ID. |
| `RPC-012` | The validated `initialize` response must expose `codexHome` to the coordinator as in-memory runtime information. The path must never be logged or persisted. |

Initialization identifies the client as:

```text
name: my_codex_usage
title: My Codex Usage
version: installed package version
```

### 6.4 Normalized usage

| ID | Requirement |
| --- | --- |
| `LIMIT-001` | Every valid primary, secondary, and limit-ID-specific window must be normalized. |
| `LIMIT-002` | Duplicate views of the same limit ID, window kind, duration, and reset must be merged. |
| `LIMIT-003` | Labels must derive from `limitName`, `limitId`, window kind, and duration rather than assuming named five-hour or weekly limits. |
| `LIMIT-004` | Remaining percentage must equal `clamp(100 - usedPercent, 0, 100)`. |
| `LIMIT-005` | Reset time, duration, plan type, limit ID, limit name, and reached-limit type must be preserved when supplied. |
| `LIMIT-006` | Missing optional metadata must produce a useful generic label without hiding a valid window. |
| `LIMIT-007` | Current-limit order is active duration ascending, primary before secondary, then stable limit ID. Reached limits remain visible. |

### 6.5 Refresh and state

| ID | Requirement |
| --- | --- |
| `REFRESH-001` | Cached data must load before the initial network refresh. |
| `REFRESH-002` | The command must attempt a refresh immediately after launch. |
| `REFRESH-003` | Interactive mode must refresh every five minutes while open. |
| `REFRESH-004` | Pressing `r` must request a refresh at any time. Concurrent requests must join one in-flight promise. |
| `REFRESH-005` | Plain mode must perform one refresh, render once, close the child process, and exit. |
| `REFRESH-006` | A refresh must independently record attempt time, success time, and a sanitized outcome. |
| `REFRESH-007` | Data older than 90 minutes is stale. A failure must never erase the latest successful limits or chart history. |
| `REFRESH-008` | Current limits are a usable partial success when daily usage is unavailable. |
| `REFRESH-009` | Dashboard states are loading, fresh, partial, stale, unauthenticated, unavailable, and incompatible. |
| `REFRESH-010` | Full refreshes run on launch, manual `r`, and every five minutes; live refreshes run every 60 seconds and update current limits plus the optional local aggregate. One serialized pipeline must coalesce equal or weaker work: a full refresh satisfies a concurrent live request, and one full refresh is queued when requested during an active live refresh. Overall freshness is based on the latest successful current-limit read. |

### 6.5.1 Usage summaries and daily interpretation

| ID | Requirement |
| --- | --- |
| `USAGE-001` | `account/usage/read` must defensively parse the nullable service summary fields for lifetime tokens, current streak days, longest streak days, peak daily tokens, and longest-running turn seconds. |
| `USAGE-002` | Daily buckets are authoritative aggregate account token usage and must not be represented as model-specific or limit-specific consumption. |
| `USAGE-003` | A missing bucket must be labeled as unreported or pending rather than fabricated as an authoritative zero. |
| `USAGE-004` | For the selected daily or weekly range, the application must calculate total reported tokens, reported and active period counts, average tokens per reported period, average tokens per active period, and the minimum and maximum reported periods. Explicitly reported zero-token periods participate in the reported-period average and extrema. |
| `USAGE-005` | Locally observed daily limit change must be derived only from two or more same-day observations in the same reset segment and labeled as a partial observation in percentage points. Insufficient observations must remain unavailable rather than zero. |
| `USAGE-006` | Weekly aggregation must group the selected trailing calendar days into Monday–Sunday UTC weeks, sum only reported daily buckets, retain reported/active/in-range day counts, and label range-edge, current, and incomplete-reporting weeks as partial without fabricating missing days as zero. |
| `USAGE-007` | Weekly locally observed limit change may sum only available derived daily changes inside the selected week and must report its contributing-day and observation counts as partial local evidence. |
| `USAGE-008` | The current UTC day must always be represented and labeled incomplete. If Codex reports its bucket, the exact value is usable and persisted; otherwise the application must show that the bucket is not yet reported without fabricating zero or estimating tokens. The current UTC week is likewise incomplete. |
| `USAGE-009` | A successful daily-usage response whose newest bucket predates the current UTC day must remain a successful authoritative source response and be labeled with its fetch time, newest service bucket date, and lag. The joined Activity series may fill missing dates with partial local observations but must not alter or mislabel the underlying service buckets. |
| `USAGE-010` | Retained local observations must remain available as a raw daily or Monday–Sunday UTC weekly audit series. A sampled zero increase is an observed zero; a date without an observation is missing. The Activity domain must additionally derive a coverage-aware joined daily series: completed reported days use service values, the current day uses a local value when present, and missing/pending service dates use local values when present. A delayed completed-day service bucket replaces the local value. Service and local values for one day must never be added. Weekly joined periods sum the selected daily values only. |

### 6.5.2 Near-live local observation

| ID | Requirement |
| --- | --- |
| `LOCAL-001` | Unless disabled by `--no-local`, the application must sample only `<codexHome>/state_5.sqlite` through `/usr/bin/sqlite3 -readonly` using fixed process arguments, no shell, and one fixed aggregate query over the `threads.tokens_used` and `threads.updated_at` columns. |
| `LOCAL-002` | The local query may return only a non-negative aggregate token total and latest activity timestamp. It must never select thread IDs, titles, paths, prompts, previews, source content, or rollout locations, and it must never modify Codex state. |
| `LOCAL-003` | Local sampling must support cancellation, stop after two seconds, bound stdout and stderr in memory, reject unsafe or malformed numeric results, and degrade to an optional unavailable state for a missing database or incompatible schema. Current limits and service usage must continue to work. |
| `LOCAL-004` | The first valid sample of each UTC day establishes a zero-delta baseline. Later samples add only non-negative increases from the immediately previous aggregate. An aggregate decrease starts a new segment, increments the reset count, and never subtracts an earlier observed increase. No delta may cross UTC midnight. |
| `LOCAL-005` | Local aggregate totals and deltas must be labeled `local observation—not service-accounted daily usage`. They may fill today or a missing/pending service date in the joined Activity series, but must never be added to a service value for the same date, reconciled against service lifetime totals, or represented as authoritative complete usage. |
| `LOCAL-006` | The application must persist up to 180 days of sanitized `LocalUsageDayObservation` records containing UTC day, first/latest sample times and aggregates, accumulated positive increase, sample count, reset count, and optional latest activity. The current record must drive an `Observed today +N tokens since HH:MM UTC · N samples · partial local` presentation that survives restarts while remaining explicitly incomplete from the first sample. |
| `LOCAL-007` | Every retained local observation inside the selected 7/30/90/180-day range must be available to interactive and plain presentation, including historical dates whose service bucket is absent. The joined Activity series may select a local value only for the current day or a missing/pending service date. Raw service and local audit values must remain accessible, and no overlapping same-day addition is permitted. |

`account/usage/read` maps the backend usage profile directly rather than
combining activity from other local sessions. Its bucket recency is therefore
version- and service-sensitive; see the current
[app-server usage handler](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/account_processor.rs#L1096-L1124)
and [backend client](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs#L327-L338).

### 6.5.3 Current-day detailed local usage

The account usage endpoint reports aggregate daily buckets only. Codex exposes
typed input, cached-input, output, and reasoning-output counts in turn token
events, as documented for JSONL execution output and app-server token-usage
notifications. The dedicated mode therefore uses a narrowly bounded local
metadata reader rather than fabricating a model split from account totals.

| ID | Requirement |
| --- | --- |
| `TODAY-001` | `--today` must show only token events whose top-level timestamp falls in the current UTC day, grouped by sanitized project-folder label, optional Codex-home-relative worktree path, exact model, and reasoning-effort strings. Missing metadata must be grouped as `unknown`, never guessed from configuration defaults. |
| `TODAY-002` | Each group and the grand total must show only input tokens, cached-input tokens, output tokens, and reasoning-output tokens. Cache-write, counted, protocol-total, and unattributed values must not appear in interactive or plain output. The reader may retain validated raw counters internally for aggregation and compatibility checks. |
| `TODAY-003` | The reader may inspect only regular `.jsonl` session files under the initialized `codexHome` session and archived-session roots whose modification time can contain current-day events. It must not follow symbolic links. A session created before today but updated today must remain eligible. |
| `TODAY-004` | For each eligible file, the reader may consume only the top-level timestamp, `turn_context` model/effort/`cwd` metadata, and `event_msg` `token_count` `last_token_usage` counters. It must immediately reduce `cwd` to the display-safe final folder name required by `TODAY-011` and, only for a contained Codex-managed worktree, the relative path required by `TODAY-012`; it must then discard the absolute path and all other fields. Except for that bounded relative worktree display value, it must never render, log, return, or persist an absolute path, parent folder, thread/turn/item ID, title, prompt, response, reasoning text, command, tool data, or source content. |
| `TODAY-005` | Rollout input is untrusted. The reader must use fatal UTF-8 decoding, a 4 MiB per-line bound, safe-integer non-negative counters, cancellation, non-symlink traversal, deterministic aggregation, and display-safe skipped-file/line counts. Malformed unrelated records may be skipped without fabricating usage. |
| `TODAY-006` | Current-day detailed usage is a local, partial observation. It excludes cloud-only, ephemeral, deleted, unavailable, and not-yet-flushed sessions and must never be reconciled with or substituted into service daily usage, joined Activity, limits, lifetime totals, persisted history, or account statistics. |
| `TODAY-007` | Interactive current-day mode must use the alternate screen, refresh on launch, every ten seconds, and on `r`, keep the last valid table visible during refresh, and exit cleanly on `q`, Escape, Ctrl+C, SIGINT, or SIGTERM. Plain mode must scan once, print an ANSI-free table, and exit. |
| `TODAY-008` | The view must show the UTC date, last scan time, partial-local warning, project and worktree-path details, grouped rows sorted by internally aggregated protocol total descending then project/worktree/model/effort, a grand total of the displayed token fields, scanned-file/token-event/skipped-record counts, and an explicit empty or unavailable state. Meaning must remain complete with color disabled. |
| `TODAY-009` | The current-day view must estimate base credits per model using the embedded rate card: GPT-5.6 Sol 125/12.5/750, Daybreak Blue 125/12.5/750, Daybreak Red 312.5/31.25/1875, GPT-5.6 Terra 50/5/300, GPT-5.6 Luna 5/0.5/30, GPT-5.5 125/12.5/750, GPT-5.4 62.5/6.25/375, GPT-5.4 mini 18.75/1.875/113, GPT-Image-2 image 200/50/750, and GPT-Image-2 text 125/31.25/250 credits per million uncached-input/cached-input/output tokens. GPT-5.3-Codex-Spark is research preview with no numeric rate. Model matching must use explicit sanitized aliases; unknown models must remain unpriced. |
| `TODAY-010` | Credit calculation must use `max(inputTokens - cachedInputTokens, 0)` at the input rate, cached input at the cached-input rate, and protocol output at the output rate. Cache-write input and reasoning-output are already represented by those priced protocol categories and must never be added again. Each priced row must show its estimate; a grand subtotal may sum only priced rows and must disclose any unpriced groups. Estimates must be labeled partial base-rate estimates that may exclude fast-mode, tool, enterprise-legacy, or other service adjustments and must never be represented as an invoice or persisted. |
| `TODAY-011` | Current-day attribution may derive one `projectFolder` label from `turn_context.cwd`. The reader must require an absolute macOS path, remove trailing separators, keep only the final folder component, reject terminal-control/bidirectional-control characters and overlong labels, and use `unknown` when no safe label exists. It must never expose or retain the original path or a parent component. Rows without a `worktreePath` that share the same final folder label intentionally merge; managed-worktree rows follow `TODAY-012`. The label is current-day local context rather than service-authoritative project accounting. |
| `TODAY-012` | When a normalized `turn_context.cwd` is strictly contained beneath normalized `<codexHome>/worktrees`, current-day attribution may additionally return `worktrees/<relative-components>` as `worktreePath`. The path must stay relative to `codexHome`, contain no empty, dot, traversal, terminal-control, or bidirectional-control component, and remain within a bounded display length. Non-worktree, root-level, invalid, or escaping paths must return no worktree path. The relative path may be used only for current-day grouping and display; it must never be persisted, logged, expanded to an absolute path, or interpreted to extract an identifier. Different relative worktree paths must remain distinct even when their project basenames match. |
| `TODAY-013` | Cached input must be labeled as a subset of Input and reasoning output as a subset of Output. Cache-write, counted, protocol-total, and unattributed values are internal-only and must not be rendered, warned about, or included in credit estimates. Their omission must not change raw parsing, row ordering, credit calculations, or privacy behavior. |

### 6.6 Persistence and privacy

| ID | Requirement |
| --- | --- |
| `DATA-001` | Current sanitized history must be stored at `~/Library/Application Support/my-codex-usage/history-v4.json`. The legacy `history.json` path is a read-only migration source and must never be written by version 0.2.0 or newer. |
| `DATA-002` | The directory and file must use user-only permissions, and writes must use a temporary file plus atomic rename. |
| `DATA-003` | Daily buckets must be upserted by the service-provided `YYYY-MM-DD` key. |
| `DATA-004` | Limit history must contain at most one observation per logical limit/window per UTC clock hour. |
| `DATA-005` | Daily usage retention is one year and hourly limit-history retention is 180 days. |
| `DATA-006` | At most 100 sanitized diagnostics no older than 30 days may be retained. |
| `DATA-007` | Corrupt or unsupported history files must be quarantined and replaced without crashing. |
| `DATA-008` | Raw stdout, stderr, protocol messages, emails, account IDs, credentials, prompts, responses, repository data, and source content must never be persisted. |
| `DATA-009` | Sanitized usage-summary values may be persisted. Valid earlier history versions must migrate without quarantine or loss of daily usage, limit history, or diagnostics. |
| `DATA-010` | History schema version 4 must migrate valid version-1, version-2, and version-3 records in memory. A valid version-3 checkpoint becomes a zero-delta observation for its UTC day. It must never persist `codexHome`, a database path, raw SQL output, or thread metadata. |
| `DATA-011` | Version 4 must persist source-success timestamps and bounded local daily observations in `history-v4.json`, retain those observations for 180 days, isolate all writes from legacy writers, preserve the legacy file for migration or rollback, and quarantine only a corrupt current-version file. |

The versioned file contains only:

```text
schemaVersion
lastAttemptAt
lastSuccessfulAt
detectedCodexVersion
authenticationState
usageSummary
sourceFreshness
localUsageDays[]
dailyUsage[]
limitHistory[]
diagnostics[]
```

### 6.7 Terminal experience

| ID | Requirement |
| --- | --- |
| `TUI-001` | Interactive output must use Ink and restore the terminal on normal exit, Escape, `q`, SIGINT, SIGTERM, and renderer failure. |
| `TUI-002` | The header must show product, account/plan state, Codex version, freshness, refresh activity, and last successful update. |
| `TUI-003` | Every current limit must show display name, remaining percentage, a Unicode progress bar, duration, and reset time. When a chart is visible, each limit must fit on one line so the plot receives priority in the vertical layout. |
| `TUI-004` | The chart panel must provide one full-width provenance-aware joined daily- or weekly-token Activity plot, per-limit used-capacity plots for seven, thirty, ninety, and one hundred eighty trailing days, plus a usage-overview panel. |
| `TUI-005` | The user must be able to cycle daily/history/overview panels, cycle seven/thirty/ninety/one-hundred-eighty days, toggle day/week activity grouping, select periods or observations with Left/Right, select limits with Up/Down, refresh, show help, and quit from the keyboard. |
| `TUI-006` | Cached data must remain visible while a background refresh runs. |
| `TUI-007` | The interface must reflow on terminal resize and use a compact limits view below 60 columns or 16 rows. |
| `TUI-008` | Meaning must not depend on color. `NO_COLOR` and `--no-color` must disable color styling. |
| `TUI-009` | Loading, empty, partial, stale, authentication, CLI, compatibility, protocol, and temporary failure states must have specific text and recovery guidance. |
| `TUI-010` | Plain output must contain no ANSI cursor or color sequences and must include status, update time, every current limit, and selected-range daily usage. |
| `TUI-011` | Plain mode exits `0` when it prints a usable fresh, partial, or stale snapshot, and `1` when no usable snapshot exists. |
| `TUI-012` | In an unauthenticated interactive state, `l` must start managed ChatGPT login and show opening-browser, waiting, failure, and completion states without rendering the auth URL or login ID. |
| `TUI-013` | Daily charts must distinguish reported, unreported, pending, and selected dates with glyphs and exact text so meaning remains available without color. |
| `TUI-014` | The selected daily point must show its date and exact reported value, while the selected limit must show its observed percentage-point increase or an insufficient-observation message. |
| `TUI-015` | The terminal palette must use restrained semantic and panel-specific colors, honor `NO_COLOR` and `--no-color`, and never make color the sole encoding. |
| `TUI-016` | Plain mode must include the sanitized usage summary, grouping, selected-range statistics, reported period values and coverage, and available observed limit changes for the requested 7/30/90/180-day range. |
| `TUI-017` | At 24 or more rows, the joined Activity plot should target 40% of terminal height, bounded to 6–18 plot rows and capped by the space remaining after required header, limits, details, and footer content. At 16–23 rows it must use a reduced 3–6-row plot while secondary statistics collapse. Limit history retains the same sizing behavior. |
| `TUI-018` | Activity plots must use the complete available chart width. Seven- and thirty-day daily ranges show every day; ninety-/one-hundred-eighty-day daily ranges and weekly ranges that do not fit show the maximum centered, clamped viewport that fits at a minimum two-column period cell while keeping the selected period visible. |
| `TUI-019` | Every Activity viewport must retain a zero baseline and use the peak selected joined token value from the entire selected range as its stable maximum. The plot must show compact zero, midpoint, and maximum labels, visible date bounds, off-screen indicators, and exact selected-period text. |
| `TUI-020` | Limit history must plot `usedPercent = 100 - remainingPercent` against a fixed 0–100% axis over the selected time range. Observations map proportionally in time, gaps remain visible, and column collisions use the maximum observed used percentage without changing the exact selected-observation text. |
| `TUI-021` | Plot rows must expose structured `low`, `medium`, `high`, `axis`, `muted`, `selected`, `service`, `local`, and `mixed` segments. Filled values use green at 0–50%, yellow above 50–75%, and red above 75–100%; no-color output uses `░`, `▒`, and `█` respectively. Selection and source provenance must remain visible independently with caret and `S`/`L`/`M` markers. |
| `TUI-022` | Activity colors encode joined token volume relative to the joined selected-range peak and must be labeled as relative volume rather than quota health. A separate non-color source guide must identify `S` service, `L` local, and `M` mixed weekly periods. Limit-history colors encode actual percentage of the selected limit used. |
| `TUI-023` | Day grouping is the default. Pressing `w` toggles day/week activity grouping, while `d` cycles `7 → 30 → 90 → 180 → 7`; either change selects the latest period containing a joined value. |
| `TUI-024` | Weekly joined periods must display their UTC date span, service/local/missing-day coverage, partial status, exact selected-value sum, and share of the joined range total. A non-color `~` marker must identify an unselected partial period. |
| `TUI-025` | The Activity detail area must show joined total, valued and active period counts, both averages, exact minimum and maximum values, and compact service/local/missing coverage counts for the plotted grain. It must explicitly wrap or collapse secondary statistics and recalculate plot height rather than clip terminal output. |
| `TUI-026` | Day/week grouping changes only account activity aggregation. Limit history remains a continuous observation plot over the selected trailing-day range. |
| `TUI-027` | All joined Activity bars in one viewport must use an identical filled width and share distributed cells with selection, source, weekend, and calendar guides. Remainder columns belong to cell spacing rather than bar width. |
| `TUI-028` | Activity and limit-history plots must use collision-safe UTC calendar axes. Seven-day activity labels every day; longer daily views prioritize visible bounds, month boundaries, and Mondays; weekly views prioritize visible bounds and month transitions. Lower-priority labels must be omitted rather than truncated or overlapped. |
| `TUI-029` | Saturday and Sunday UTC must be marked as non-working days in daily activity and limit-history guides without replacing the quantitative color bands. No-color activity output uses a visible `W`; weekly bars omit weekend styling because every Monday–Sunday bucket includes a weekend. |
| `TUI-030` | Current daily and weekly joined details, legends, and plain output must distinguish an incomplete service value, a partial local selection, and a period with no usable value. Completeness and source must be explicit text or glyph metadata rather than inferred from color. |
| `TUI-031` | Interactive mode must render in the terminal alternate screen so the dashboard is the only visible content while running. Every exit path must restore the primary screen, prior scrollback, cursor visibility, and input mode. Plain, redirected, help, version, argument-error, unsupported-platform, and `TERM=dumb` output must never enter the alternate screen. |
| `TUI-032` | Activity and overview panels must show a separate live-observation section with local aggregate total, latest local activity, sample time, observed increase and interval when available, and explicit baseline, reset, unavailable, or disabled states. The section must carry the `LOCAL-005` label. |
| `TUI-033` | Interactive and plain output must show source-specific freshness for current limits, the daily response fetch, and the newest service bucket. Plain output must include the local observation state without ANSI sequences. |
| `TUI-034` | Daily mode must select the current UTC day by default when a local observation exists. The joined Activity value for today must use that local observation, show its baseline/latest sample, sample/reset counts, and partial-local label, and separately disclose whether Codex supplied an incomplete service bucket. Usage Overview must retain authoritative service summary semantics. |
| `TUI-035` | The Activity panel must always show one joined plot without a source switch. Completed reported days select service values; today and missing/pending service dates select available local values; missing dates remain missing; and a delayed historical service bucket replaces a prior local selection. Same-day source values must never be added. |
| `TUI-036` | The joined Activity view must support day/week grouping, 7/30/90/180-day ranges, full-width geometry, navigation, and no-color behavior. Its source guide uses `S`, `L`, `M`, and missing/pending glyphs independently of selection and volume color. Selected details must show the chosen value and provenance. Plain output must print joined values and statistics first, followed by compact service and local audit sections. |

## 7. Architecture

```text
CLI argument parsing
       │
       ├── plain renderer
       └── Ink application
                │
                ▼
                RefreshCoordinator
          ┌──────────┼──────────┐
          ▼          ▼          ▼
 CodexAccountClient  │   LocalUsageSource
          │          │          │
          ▼          ▼          ▼
  JsonRpcTransport HistoryStore sqlite3 -readonly
          │
          ▼
   codex app-server
```

Protocol DTO parsing, normalized domain models, persisted records, and rendered
view state are separate layers. UI components do not spawn processes or write
history directly.

## 8. Data Flow

1. Parse arguments and determine interactive or plain mode. When the default
   current-day view or explicit `--today` is selected, initialize only far
   enough to obtain the in-memory `codexHome`,
   close app-server, scan current-day local token metadata, render the
   dedicated view, and skip dashboard history and lease.
2. Acquire the single-instance lease, then load and prune v4 sanitized history,
   migrating the read-only legacy file only when no current file exists.
3. Locate and validate Codex.
4. Start app-server and complete initialization.
5. Read authentication state.
6. Fetch rate limits and usage independently, retaining separate source
   timestamps and the newest returned daily bucket date.
7. When enabled, sample the fixed local aggregate query without retaining
   `codexHome` outside memory.
8. Normalize valid results, usage summaries, and daily buckets; update the
   current UTC local observation from the aggregate sample; expose the retained
   local-day collection to view state; and merge cached history without
   crossing source accounting boundaries.
9. Persist a sanitized atomic snapshot after a usable success.
10. Render state; schedule one-minute live and five-minute full refreshes.
11. Close app-server and local subprocesses, restore the terminal, and release
    the lease only when the current process owns it.

## 9. Failure Handling

- Invalid arguments: usage error, exit `2`.
- Missing/old Codex: explicit unavailable/incompatible message.
- Signed out or API key only: `codex login` guidance; no false zero values.
- Rate limits fail with cache: preserve and mark stale.
- Usage fails while rate limits succeed: partial state.
- Daily response succeeds with old buckets: fresh current limits plus an
  explicit `service data through DATE` label.
- Local database is absent, incompatible, malformed, or slow: local observation
  unavailable; service data continues without a primary warning.
- Current-day detail files are unavailable or malformed: preserve the last
  valid table in interactive mode and show bounded skipped-record counts or a
  display-safe unavailable state; never print raw file data or paths beyond the
  validated Codex-home-relative worktree value allowed by `TODAY-012`.
- Another live dashboard owns the lease: do not start app-server; exit `1` with
  guidance to quit the older instance and verify the installed version.
- Corrupt persisted data: quarantine with a timestamped `.corrupt` suffix,
  start clean, and record only a sanitized diagnostic.
- Process/protocol failure: settle pending requests, apply bounded backoff, and
  preserve the latest usable state.

## 10. Security and Privacy

- Local read-only integration only. The optional dashboard query uses the fixed
  aggregate columns `tokens_used` and `updated_at` and never enumerates rows.
- The default/`--today` exception reads only the token, model/effort, and
  working-directory metadata listed
  in `TODAY-001`–`TODAY-005` from eligible current-day local session events.
  The working directory is reduced immediately to its safe final folder name
  and, only when contained beneath the managed worktree root, a bounded
  Codex-home-relative worktree path. Absolute paths, unrelated parent paths,
  raw records, and all content-bearing fields are ignored and never leave the
  reader.
- No authentication-file access, direct credential handling, telemetry, or network
  listener.
- ChatGPT OAuth is owned and persisted by Codex app-server. The TUI handles only
  a transient HTTPS authorization URL and login correlation ID in memory.
- No raw app-server logging.
- Display-safe errors use enumerated categories and static recovery copy.
- History files and directories are readable and writable only by the user.
- The lease contains no account or usage values and is user-only.
- Child-process environment is inherited only as needed to run Codex; no
  environment values are persisted.
- `codexHome`, database paths, SQL output, and local process errors remain
  ephemeral and display-safe.

## 11. Terminal Accessibility

- Status and chart meaning are conveyed in text as well as color.
- Exact percentages, dates, reset times, and selected chart values are
  available as text.
- Keyboard help is always reachable with `?`.
- Layouts remain readable at 80×24 and degrade to a compact view on smaller
  terminals.
- Animation is limited to a refresh indicator and may be disabled when output
  is non-interactive.

## 12. Distribution

The MVP is an npm package installed from a locally produced tarball:

```bash
npm pack
npm install -g ./my-codex-usage-*.tgz
```

Publishing to the npm registry is an explicit later action and is not part of
MVP implementation or validation.

## 13. Acceptance Criteria

The MVP is accepted when:

1. `npm ci`, type checking, tests, and production build succeed.
2. A packed tarball installs into a temporary npm prefix and exposes
   `my-codex-usage`.
3. Interactive mode renders all three panels and every range at 80×24 and
   120×40, uses at least 90% of usable chart width, responds to all documented
   keys, occupies the alternate screen without exposing primary scrollback, and
   restores the primary screen on every exit path.
4. Daily and limit-history plots preserve their documented global scales while
   selecting and scrolling, expose exact selected values, and remain
   interpretable with color disabled.
   Activity bars have identical filled widths, calendar labels do not collide,
   and UTC weekends remain identifiable.
5. Plain mode is ANSI-free and follows the specified exit codes.
6. Sanitized fixtures prove every protocol, normalization, refresh,
   persistence, and error-state requirement.
7. The v4 history file and lease contain only approved fields and pass
   retention, isolation, ownership, and permission tests.
8. A manual read-only run against Codex CLI 0.144.3 shows current limits
   without starting Codex work or exposing sensitive data.
9. The current UTC day is always visible and explicitly incomplete; a missing
   service bucket never becomes a persisted or displayed zero.
10. Plain and other non-interactive commands emit no alternate-screen escape
    sequences and do not clear terminal history.
11. A fixture with lagging service buckets fills missing joined dates from
    local observations while leaving the underlying service history unchanged
    and visibly labels the selected provenance.
12. History migrations from versions 1, 2, and 3 write schema version 4 only
    to `history-v4.json`, preserve `history.json` byte-for-byte, and contain no
    prohibited local paths or thread metadata.
13. First-sample, same-day increase, no-change, reset, multi-reset, midnight,
    and 180-day-retention fixtures prove persistent observed-today behavior,
    current-day local selection, and no overlapping same-day addition.
14. Live-owner rejection, stale-lease recovery, owner-safe release, signal
    cleanup, and help/version bypass are verified.
15. A retained historical local observation fills a joined Activity gap and
    appears in the plain-output audit when the same date has no service bucket;
    a later service bucket deterministically replaces it, and joined statistics
    match exactly the plotted values.
16. Current-day fixtures prove per-model/per-effort input, cache, output, and
    reasoning aggregation; cross-midnight exclusion; malformed and
    oversized-record handling; direct internal protocol-total aggregation;
    no prohibited fields in returned state or output; ANSI-free plain output;
    ten-second refresh; and alternate-screen restoration.
17. An argument-free invocation opens the current-day snapshot; `--dashboard`
    and historical-only options open the historical dashboard. Credit fixtures
    prove exact rate matching, uncached-input subtraction, no cache/reasoning
    double count, rated-only subtotals, research-preview handling, and an
    explicit unpriced result for unknown models.
18. Current-day project fixtures prove folder/model/effort grouping, per-folder
    credit attribution, context changes within one session, safe Unicode folder
    labels, `unknown` fallback, duplicate-basename merging for non-worktree
    rows, and absence of absolute or unrelated parent paths from domain state,
    TUI/plain output, and persistence.
19. Worktree fixtures prove contained paths are rendered relative to
    `codexHome`, distinct worktrees with the same project basename stay
    separate, local checkout rows use no worktree path, traversal/control input
    is rejected, and neither the absolute Codex home nor a worktree path enters
    persistence or diagnostics.
20. Accounting fixtures prove cache-write, counted, protocol-total, and
    unattributed values stay absent from TUI/plain output and never change row
    or subtotal credit estimates.

## 14. Deferred Scope

Linux and Windows support, standalone binaries, Homebrew, registry publishing,
background monitoring, notifications, exports, custom refresh intervals,
predictions, and additional account types are deferred. This section records
scope boundaries only and is not a release plan. Historical detailed token
breakdowns, per-thread or per-request attribution, absolute-path display,
parent-path disambiguation, and persistence of detailed token events are also
deferred.
