# My Codex Usage — Current Implementation Plan

- **Status:** Current-day project/worktree/model/effort console implemented and validated
- **Command and package:** `my-codex-usage`
- **Runtime:** macOS 14+, Node.js 22+
- **Protocol baseline:** `codex-cli 0.144.3`
- **Distribution:** locally packed npm tarball

This file records the current architecture and acceptance-gated implementation
sequence. [PRD.md](PRD.md) is the requirements source of truth and
[AGENTS.md](AGENTS.md) defines repository working agreements. Chronological
iteration history is intentionally omitted.

## 1. Current Architecture

```text
CLI / Ink / plain output
          │
          ▼
Single-instance lease → RefreshCoordinator (serialized full/live scopes)
  ┌───────────────┼────────────────┐
  ▼               ▼                ▼
Codex client   History store   Local usage source
  │               │                │
app-server    history v4      sqlite3 -readonly
```

Planned interfaces:

```ts
type CodexRuntimeInfo = {codexHome: string};

interface CodexAccountClient {
  initialize(signal?: AbortSignal): Promise<CodexRuntimeInfo>;
  readAccount(signal?: AbortSignal): Promise<AccountStatus>;
  readRateLimits(signal?: AbortSignal): Promise<RateLimitsDTO>;
  readUsage(signal?: AbortSignal): Promise<AccountUsageDTO>;
  startChatGPTLogin(signal?: AbortSignal): Promise<LoginPrompt>;
  waitForLoginCompletion(loginId: string, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

interface LocalUsageSource {
  readAggregate(
    codexHome: string,
    signal?: AbortSignal
  ): Promise<LocalUsageAggregate | undefined>;
}

interface UsageRefreshCoordinator {
  loadCached(): Promise<DashboardSnapshot>;
  refresh(
    trigger: RefreshTrigger,
    scope?: "full" | "live"
  ): Promise<DashboardSnapshot>;
  startAutomaticRefresh(
    callback: (state: DashboardSnapshot) => void
  ): void;
  close(): Promise<void>;
}
```

Protocol DTOs, domain state, persisted records, and renderer props remain
separate. UI code never spawns processes or writes storage.

The default/`--today` branch initializes app-server only to obtain `codexHome`,
closes the child, and then uses a separate read-only metadata reader and renderer. It
does not load or write dashboard history and does not acquire the writer lease.

## 2. Acceptance-Gated Phases

### Phase A — Specification and release identity

- [x] Add `LOCAL-006`, `DATA-011`, `CLI-010`, and `TUI-034` to the PRD.
- [x] Update AGENTS and README for persisted daily observation, v4 isolation,
  lease ownership, and source separation.
- [x] Align package manifest, lockfile, runtime constant, CLI output, and
  app-server client identity at `0.2.0`.

Gate: requirements are traceable and every version surface reports 0.2.0.

### Phase B — History v4 and observed-day model

- [x] Add runtime-validated `LocalUsageDayObservation` and retain 180 UTC days.
- [x] Implement first-sample baseline, positive accumulation, no-change,
  aggregate-reset segmentation, multi-reset accumulation, and midnight reset.
- [x] Read/write `history-v4.json`; use `history.json` only as a read-only
  v1/v2/v3 migration source.
- [x] Convert a v3 checkpoint into a zero-delta observation for its UTC day.
- [x] Preserve legacy bytes, quarantine only corrupt v4, and keep atomic
  user-only writes.

Gate: migration, isolation, retention, reset, midnight, permission, and
prohibited-field tests pass.

Requirements: `LOCAL-004`–`LOCAL-006`, `DATA-001`–`DATA-011`.

### Phase C — Single-instance protection

- [x] Add an atomically acquired user-only lease with owner ID, PID, version,
  and start time only.
- [x] Reject a live owner with exit 1 and upgrade/quit guidance.
- [x] Reclaim a verified stale lease and release only by matching owner ID.
- [x] Acquire only after argument/help/version/platform handling and release
  after coordinator and terminal cleanup.

Gate: live-owner, stale recovery, ownership, signals, renderer failures, and
bypass tests pass.

Requirements: `CLI-010`, `TUI-001`, `TUI-031`.

### Phase D — Coordinator and presentation

- [x] Persist each valid local sample into its UTC-day observation and derive
  live state from persisted history.
- [x] Prefer today in daily selection when a local observation exists.
- [x] Render the observed-today line in activity, overview, compact, and plain
  views while retaining the independent incomplete service state.
- [x] Prove local values do not alter service bars, weekly sums, statistics,
  summaries, lifetime totals, freshness, or scales.

Gate: all local states render at 80×24 and compact sizes; plain output is
ANSI-free; service-accounted values remain byte-for-byte independent.

Requirements: `USAGE-002`–`USAGE-009`, `LOCAL-005`–`LOCAL-006`,
`TUI-030`, `TUI-032`–`TUI-034`.

### Phase E — Validation and installation transition

- [x] Run typecheck, all tests, production build, packed temporary-prefix
  install, and PTY terminal-restoration checks.
- [x] Perform sanitized read-only live validation without exposing aggregate or
  account values.
- [x] Re-resolve and SIGTERM only verified running global 0.1.0 instances.
- [x] Pack outside the repository, replace the global installation, verify
  `my-codex-usage --version` is 0.2.0, and launch one interactive instance.
- [x] Preserve legacy history and do not publish.

Gate: one v0.2.0 instance owns the lease, v4 state is isolated, all acceptance
criteria pass, and no package is published.

### Phase F — Historical local domain and state

- [x] Add runtime-facing local period/statistics models.
- [x] Expose retained `localUsageDays` on every dashboard state without
  changing history schema v4.
- [x] Derive separate local daily and Monday–Sunday UTC weekly periods,
  coverage, averages, and deterministic extrema for 7/30/90/180 days.
- [x] Preserve observed zeroes, missing dates, current-period metadata,
  sample/reset counts, and first/latest sample times.
- [x] Prove local calculations cannot change service periods, statistics,
  summaries, freshness, or chart scales.

Gate: domain, coordinator, migration-cache, range, weekly-boundary, missing,
zero, and source-isolation tests pass.

Requirements: `LOCAL-007`, `USAGE-010`, `DATA-011`.

### Phase G — Historical local presentation foundation

- [x] Remove source-selection state and the `s` switch.
- [x] Expose service and retained local periods together with synchronized
  range, grouping, calendar, selection, and navigation behavior.
- [x] Set the historical dashboard default to 30 trailing UTC days while
  retaining explicit 7/30/90/180-day options.
- [x] Preserve raw service/local details and ANSI-free plain output as the
  provenance foundation for the joined chart.
- [x] Render-test lagging service, no local history, no-color, compact, and
  180-day states.

Gate: historical local observations are selectable for every supported range,
underlying source histories remain unchanged, and the UI has no source switch.

Requirements: `TUI-035`, `TUI-036`, `LOCAL-007`, `USAGE-010`.

### Phase H — Single joined Activity chart

- [x] Add joined daily/weekly period models, coverage-aware source selection,
  provenance counts, and statistics calculated from exactly the selected
  values.
- [x] Replace the service/local plot pair with one full-height joined plot and
  `S`/`L`/`M` source guide while preserving calendar, weekend, selection, and
  no-color behavior.
- [x] Render joined details and statistics without changing authoritative
  service summaries or persisted source histories.
- [x] Put joined periods and statistics first in plain output, followed by
  compact service and local audit sections.
- [x] Prove completed-day service precedence, current-day local precedence,
  gap filling, delayed-bucket replacement, and absence of same-day addition.
- [x] Validate, pack 0.2.0 outside the repository, replace only the verified
  running instance, and relaunch without publishing.

Gate: one chart exposes a stable provenance-aware series across all ranges and
groupings; every plotted value has one deterministic source, joined statistics
match the plot, and raw service/local histories remain unchanged.

Requirements: `USAGE-009`–`USAGE-010`, `LOCAL-005`, `LOCAL-007`,
`TUI-004`, `TUI-017`–`TUI-036`.

### Phase I — Current-day detailed token console

- [x] Specify `--today`, current-UTC-day scope, typed token columns, local-only
  caveats, lease isolation, and the narrow session-event privacy exception.
- [x] Add a defensive, streaming reader that tracks only project/model/effort context
  and sums current-day `last_token_usage` counters from eligible regular local
  session files.
- [x] Add deterministic domain aggregation and separate interactive/plain
  current-day views with totals, source diagnostics, empty/error states,
  no-color behavior, manual refresh, and ten-second automatic refresh.
- [x] Prove that protocol total is aggregated directly rather than recomputed
  across detail columns, and that no
  identifier, path, content, or raw record reaches view state, logs, output, or
  persistence.
- [x] Validate typecheck, tests, build, temporary packed install, help/plain
  smoke tests, and alternate-screen restoration without publishing.

Gate: `my-codex-usage --today` shows a live current-UTC-day table grouped by
project, model, and effort; `--today --plain` is ANSI-free; all privacy, temporal,
malformed-input, and terminal-lifecycle tests pass.

Requirements: `CLI-011`, `TODAY-001`–`TODAY-008`, `TUI-001`, `TUI-008`,
`TUI-031`.

### Phase J — Default current snapshot and credit estimates

- [x] Make the current-UTC-day project/model/effort snapshot the argument-free default;
  retain `--today` as an explicit alias and add `--dashboard` for the historical
  interface while preserving dashboard inference for range/group/local flags.
- [x] Add a typed, immutable credit rate card with explicit model aliases and a
  research-preview/unpriced state.
- [x] Calculate base credits from uncached input, cached input, and output
  without double-counting cached, cache-write, or reasoning counters.
- [x] Render per-group credit estimates and a priced-groups subtotal in both
  adaptive Ink and ANSI-free plain output, including unknown-rate caveats.
- [x] Add CLI, calculation, TUI, plain-output, help, and packed-command tests;
  validate the default and explicit dashboard entry points.

Gate: `my-codex-usage` opens the current-day snapshot, `my-codex-usage
--dashboard` opens historical usage, every supported model uses the documented
rate, unpriced models remain visibly unpriced, and no token category is billed
twice.

Requirements: `CLI-003`, `CLI-011`, `TODAY-001`–`TODAY-010`.

### Phase K — Current-day project-folder attribution

- [x] Expand the allowed `turn_context` metadata to `cwd`, immediately derive
  only a display-safe final folder label, and discard the absolute path.
- [x] Group current-day rows by project-folder label, model, and effort so each
  row carries its own token counters and base credit estimate.
- [x] Add the Project column/label to adaptive Ink, plain output, totals,
  legends, help, and user documentation without persisting detailed rows.
- [x] Prove context changes, missing/unsafe paths, Unicode names,
  duplicate-basename merging, ANSI safety, and absence of absolute or unrelated
  parent paths in returned or rendered state.
- [x] Validate typecheck, all tests, build, packed install, alternate-screen
  restoration, and a sanitized live run without printing full paths.

Gate: the default current-day view identifies the sanitized project folder for
every token/credit row while no absolute path, parent component, raw record, or
new persisted field crosses the reader boundary.

Requirements: `TODAY-001`–`TODAY-011`, `TUI-001`, `TUI-008`, `TUI-031`.

### Phase L — Current-day managed-worktree paths

- [x] Derive a bounded `worktrees/<relative-components>` display value only
  when `turn_context.cwd` is contained beneath `<codexHome>/worktrees`.
- [x] Include the optional worktree path in aggregation identity, ordering,
  adaptive Ink rows, plain output, help, and documentation.
- [x] Keep normal local checkouts path-free and prevent traversal, control
  characters, absolute Codex-home disclosure, logging, and persistence.
- [x] Prove distinct worktrees with identical project basenames remain separate
  and validate the packed default console against live sanitized metadata.

Gate: today mode identifies managed worktrees with a Codex-home-relative path
while absolute paths and non-worktree parent directories never cross the
reader boundary.

Requirements: `TODAY-001`–`TODAY-012`, `TUI-001`, `TUI-008`, `TUI-031`.

### Phase M — Reduced current-day columns

- [x] Remove Write, Counted, Protocol, and Unattributed from wide and compact
  Ink rows, grand totals, warnings, help, and plain output.
- [x] Retain Input, Cached, Output, Reason, Credits, project/worktree context,
  raw parsing, row ordering, and credit behavior.
- [x] Remove presentation-only accounting types/helpers that no longer have a
  consumer and update user/contributor documentation.
- [x] Prove the four removed labels/values are absent across wide, compact,
  plain, no-color, packaged, and live output.

Gate: Today mode presents only Input, Cached, Output, Reason, and Credits while
the underlying read-only scan and credit estimates remain unchanged.

Requirements: `TODAY-002`, `TODAY-008`–`TODAY-010`, `TODAY-013`.

## 3. Test Matrix

### Unit and integration

- Version/discovery, JSONL framing, response correlation, protocol parsers, and
  normalized limit behavior.
- Fixed local SQLite invocation, safe parsing, optional failures, cancellation,
  and output bounds.
- History v1/v2/v3-to-v4 migration, legacy isolation, permissions, atomic
  replacement, local-day retention, quarantine, and prohibited-field absence.
- Lease atomic acquisition, live-owner rejection, stale recovery, owner-safe
  release, bypass, and signal/error cleanup.
- Full/live refresh coalescing, queued promotion, one-/five-minute fake timers,
  baseline/delta/reset handling, service lag, and clean shutdown.
- Daily/weekly aggregation, statistics, chart geometry, accessibility, source
  freshness, and live-observation rendering.
- Coverage-aware joined daily/weekly periods, source provenance, no-overlap
  selection, stable scaling, and joined-first plain output with source audits.

### Packaging and manual

- Baseline 80×24, wide, compact, color/no-color, alternate-screen restoration,
  redirected plain output, and managed-login guidance.
- Temporary-prefix installation of a tarball produced outside the repository.
- Sanitized live read using only approved account methods and the fixed local
  aggregate query.

## 4. Fixed Defaults

- Default command: current-UTC-day project/worktree/model/effort snapshot. `--dashboard` opens
  the historical interface, whose default range is thirty trailing UTC days
  grouped by day.
- Full refresh: launch, manual `r`, and every five minutes.
- Live refresh: current limits and optional local aggregate every 60 seconds.
- Local aggregate: enabled unless `--no-local`; it may fill today or a
  missing/pending service date in the derived joined series but is never added
  to a service value for the same day.
- Current-day detail: default or explicit `--today`, current UTC day only,
  sanitized final project-folder labels, ten-second interactive refresh, no
  persistence, no writer lease, and no account calls.
- Stale threshold: 90 minutes from the last successful current-limit read.
- Storage: one user-only atomic `history-v4.json`; legacy `history.json` is
  read-only.
- Process model: one refresh-capable instance protected by a user-only lease.
- Runtime dependencies: Ink and React only.
- No registry publication, backend, telemetry, general thread/turn inspection,
  content parsing beyond the `TODAY-004` metadata exception, historical detailed breakdown, configurable dashboard
  intervals, or service/local accounting reconciliation. The sole event-file
  exception is the current-day token metadata reader in `TODAY-001`–`TODAY-005`.
