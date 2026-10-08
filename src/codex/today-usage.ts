import {createReadStream} from 'node:fs';
import {lstat, readdir} from 'node:fs/promises';
import {basename, isAbsolute, join, relative, resolve, sep} from 'node:path';
import type {
  TodayUsageGroup,
  TodayUsageSnapshot,
  TodayUsageSource,
  TokenBreakdown
} from '../domain/types.js';

const SESSION_ROOT_NAMES = ['sessions', 'archived_sessions'] as const;
const MAXIMUM_LINE_BYTES = 4 * 1024 * 1024;
const MAXIMUM_FILE_COUNT = 10_000;
const UNKNOWN_LABEL = 'unknown';

type FileIdentity = string;

type CandidateScan = {
  files: string[];
  skippedFileCount: number;
  inaccessibleRootCount: number;
};

type GroupAccumulator = TodayUsageGroup;

type RecordContext = {
  projectFolder: string;
  worktreePath?: string;
  model: string;
  effort: string;
};

type RecordResult =
  | {kind: 'context'; context: RecordContext}
  | {kind: 'usage'; counts: TokenBreakdown}
  | {kind: 'ignore'}
  | {kind: 'invalid'};

type FileScanResult = {
  tokenEventCount: number;
  skippedRecordCount: number;
};

export type TodayUsageSourceOptions = {
  now?: () => Date;
  maximumLineBytes?: number;
  maximumFileCount?: number;
};

export class SessionTodayUsageSource implements TodayUsageSource {
  private readonly now: () => Date;
  private readonly maximumLineBytes: number;
  private readonly maximumFileCount: number;

  constructor(options: TodayUsageSourceOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maximumLineBytes = options.maximumLineBytes ?? MAXIMUM_LINE_BYTES;
    this.maximumFileCount = options.maximumFileCount ?? MAXIMUM_FILE_COUNT;
  }

  async readToday(
    codexHome: string,
    signal?: AbortSignal
  ): Promise<TodayUsageSnapshot> {
    throwIfAborted(signal);
    const sampled = this.now();
    const sampledAt = sampled.toISOString();
    const dayKey = sampledAt.slice(0, 10);
    const dayStart = Date.parse(`${dayKey}T00:00:00.000Z`);
    const candidates = await findCandidateFiles(
      codexHome,
      dayStart,
      this.maximumFileCount,
      signal
    );
    const groups = new Map<string, GroupAccumulator>();
    let tokenEventCount = 0;
    let skippedRecordCount = 0;
    let skippedFileCount =
      candidates.skippedFileCount + candidates.inaccessibleRootCount;
    let scannedFileCount = 0;

    for (const file of candidates.files) {
      throwIfAborted(signal);
      try {
        const result = await scanRolloutFile(
          file,
          dayKey,
          codexHome,
          groups,
          this.maximumLineBytes,
          signal
        );
        tokenEventCount += result.tokenEventCount;
        skippedRecordCount += result.skippedRecordCount;
        scannedFileCount++;
      } catch (error) {
        if (signal?.aborted === true) {
          throw error;
        }
        skippedFileCount++;
      }
    }

    const orderedGroups = [...groups.values()].sort(
      (left, right) =>
        compareDescending(left.totalTokens, right.totalTokens) ||
        left.projectFolder.localeCompare(right.projectFolder) ||
        (left.worktreePath ?? '').localeCompare(right.worktreePath ?? '') ||
        left.model.localeCompare(right.model) ||
        left.effort.localeCompare(right.effort)
    );
    const total = sumBreakdowns(orderedGroups);
    const totalOverflow = total === undefined;
    const unavailable = totalOverflow ||
      candidates.inaccessibleRootCount === SESSION_ROOT_NAMES.length &&
      candidates.files.length === 0;
    const warning = totalOverflow
      ? 'Current-day token totals exceeded the supported numeric range.'
      : unavailable
      ? 'Local Codex session metadata is unavailable.'
      : skippedFileCount > 0 || skippedRecordCount > 0
        ? 'Some unreadable or malformed local records were skipped.'
        : undefined;

    return {
      status: unavailable ? 'unavailable' : 'ready',
      dayKey,
      sampledAt,
      groups: totalOverflow ? [] : orderedGroups,
      total: total ?? emptyBreakdown(),
      scannedFileCount,
      tokenEventCount,
      skippedRecordCount,
      skippedFileCount,
      warning
    };
  }
}

export function aggregateTodayUsageRecords(
  records: readonly unknown[],
  dayKey: string,
  codexHome: string
): Pick<
  TodayUsageSnapshot,
  'groups' | 'total' | 'tokenEventCount' | 'skippedRecordCount'
> {
  const groups = new Map<string, GroupAccumulator>();
  let context: RecordContext = {
    projectFolder: UNKNOWN_LABEL,
    model: UNKNOWN_LABEL,
    effort: UNKNOWN_LABEL
  };
  let tokenEventCount = 0;
  let skippedRecordCount = 0;

  for (const record of records) {
    const result = parseAllowedRecord(record, dayKey, codexHome);
    if (result.kind === 'context') {
      context = result.context;
    } else if (result.kind === 'usage') {
      if (!addUsageGroup(groups, context, result.counts)) {
        skippedRecordCount++;
        continue;
      }
      tokenEventCount++;
    } else if (result.kind === 'invalid') {
      skippedRecordCount++;
    }
  }

  const orderedGroups = [...groups.values()].sort(
    (left, right) =>
      compareDescending(left.totalTokens, right.totalTokens) ||
      left.projectFolder.localeCompare(right.projectFolder) ||
      (left.worktreePath ?? '').localeCompare(right.worktreePath ?? '') ||
      left.model.localeCompare(right.model) ||
      left.effort.localeCompare(right.effort)
  );
  const total = sumBreakdowns(orderedGroups);
  if (total === undefined) {
    throw new RangeError('Current-day token totals exceeded the supported range.');
  }
  return {
    groups: orderedGroups,
    total,
    tokenEventCount,
    skippedRecordCount
  };
}

async function findCandidateFiles(
  codexHome: string,
  dayStart: number,
  maximumFileCount: number,
  signal?: AbortSignal
): Promise<CandidateScan> {
  const files: string[] = [];
  const identities = new Set<FileIdentity>();
  let skippedFileCount = 0;
  let inaccessibleRootCount = 0;

  const walk = async (directory: string, root: boolean): Promise<void> => {
    throwIfAborted(signal);
    let entries;
    try {
      entries = await readdir(directory, {withFileTypes: true});
    } catch (error) {
      if (isMissing(error)) {
        return;
      }
      if (root) {
        inaccessibleRootCount++;
      } else {
        skippedFileCount++;
      }
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      throwIfAborted(signal);
      if (entry.isSymbolicLink()) {
        continue;
      }
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(child, false);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }
      if (files.length >= maximumFileCount) {
        skippedFileCount++;
        continue;
      }
      try {
        const metadata = await lstat(child);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          continue;
        }
        if (metadata.mtimeMs < dayStart) {
          continue;
        }
        const identity = `${metadata.dev}:${metadata.ino}`;
        if (identities.has(identity)) {
          continue;
        }
        identities.add(identity);
        files.push(child);
      } catch {
        skippedFileCount++;
      }
    }
  };

  for (const rootName of SESSION_ROOT_NAMES) {
    await walk(join(codexHome, rootName), true);
  }
  files.sort((left, right) => left.localeCompare(right));
  return {files, skippedFileCount, inaccessibleRootCount};
}

async function scanRolloutFile(
  file: string,
  dayKey: string,
  codexHome: string,
  groups: Map<string, GroupAccumulator>,
  maximumLineBytes: number,
  signal?: AbortSignal
): Promise<FileScanResult> {
  const stream = createReadStream(file);
  let pending = Buffer.alloc(0);
  let discardingOversizedLine = false;
  let context: RecordContext = {
    projectFolder: UNKNOWN_LABEL,
    model: UNKNOWN_LABEL,
    effort: UNKNOWN_LABEL
  };
  let tokenEventCount = 0;
  let skippedRecordCount = 0;

  const abort = (): void => {
    stream.destroy(signal?.reason instanceof Error ? signal.reason : undefined);
  };
  signal?.addEventListener('abort', abort, {once: true});
  try {
    for await (const rawChunk of stream) {
      throwIfAborted(signal);
      const chunk = Buffer.isBuffer(rawChunk)
        ? rawChunk
        : Buffer.from(rawChunk);
      const data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      pending = Buffer.alloc(0);
      let offset = 0;

      while (offset < data.length) {
        const newline = data.indexOf(0x0a, offset);
        if (newline < 0) {
          const tail = data.subarray(offset);
          if (discardingOversizedLine) {
            break;
          }
          if (tail.length > maximumLineBytes) {
            skippedRecordCount++;
            discardingOversizedLine = true;
          } else {
            pending = Buffer.from(tail);
          }
          break;
        }

        if (discardingOversizedLine) {
          discardingOversizedLine = false;
          offset = newline + 1;
          continue;
        }

        let line = data.subarray(offset, newline);
        offset = newline + 1;
        if (line.at(-1) === 0x0d) {
          line = line.subarray(0, -1);
        }
        if (line.length === 0) {
          continue;
        }
        if (line.length > maximumLineBytes) {
          skippedRecordCount++;
          continue;
        }
        const processed = processLine(line, dayKey, codexHome, context, groups);
        context = processed.context;
        tokenEventCount += processed.tokenEventCount;
        skippedRecordCount += processed.skippedRecordCount;
      }
    }

    if (!discardingOversizedLine && pending.length > 0) {
      const processed = processLine(pending, dayKey, codexHome, context, groups);
      tokenEventCount += processed.tokenEventCount;
      skippedRecordCount += processed.skippedRecordCount;
    }
    throwIfAborted(signal);
  } finally {
    signal?.removeEventListener('abort', abort);
    stream.destroy();
  }
  return {tokenEventCount, skippedRecordCount};
}

function processLine(
  line: Buffer,
  dayKey: string,
  codexHome: string,
  context: RecordContext,
  groups: Map<string, GroupAccumulator>
): {context: RecordContext; tokenEventCount: number; skippedRecordCount: number} {
  let record: unknown;
  try {
    const text = new TextDecoder('utf-8', {fatal: true}).decode(line);
    record = JSON.parse(text) as unknown;
  } catch {
    return {context, tokenEventCount: 0, skippedRecordCount: 1};
  }

  const result = parseAllowedRecord(record, dayKey, codexHome);
  if (result.kind === 'context') {
    return {context: result.context, tokenEventCount: 0, skippedRecordCount: 0};
  }
  if (result.kind === 'usage') {
    return addUsageGroup(groups, context, result.counts)
      ? {context, tokenEventCount: 1, skippedRecordCount: 0}
      : {context, tokenEventCount: 0, skippedRecordCount: 1};
  }
  return {
    context,
    tokenEventCount: 0,
    skippedRecordCount: result.kind === 'invalid' ? 1 : 0
  };
}

function parseAllowedRecord(
  record: unknown,
  dayKey: string,
  codexHome: string
): RecordResult {
  if (!isObject(record)) {
    return {kind: 'ignore'};
  }
  const payload = record.payload;
  if (!isObject(payload)) {
    return {kind: 'ignore'};
  }
  if (record.type === 'turn_context') {
    const worktreePath = worktreePathFromCwd(payload.cwd, codexHome);
    return {
      kind: 'context',
      context: {
        projectFolder: projectFolderFromCwd(payload.cwd),
        ...(worktreePath === undefined ? {} : {worktreePath}),
        model: parseSafeLabel(payload.model),
        effort: parseSafeLabel(payload.effort)
      }
    };
  }
  if (record.type !== 'event_msg' || payload.type !== 'token_count') {
    return {kind: 'ignore'};
  }
  if (!isTimestampInDay(record.timestamp, dayKey)) {
    return {kind: 'ignore'};
  }
  const info = payload.info;
  if (!isObject(info) || !isObject(info.last_token_usage)) {
    return {kind: 'invalid'};
  }
  const counts = parseBreakdown(info.last_token_usage);
  return counts === undefined
    ? {kind: 'invalid'}
    : {kind: 'usage', counts};
}

function parseBreakdown(value: Record<string, unknown>): TokenBreakdown | undefined {
  const inputTokens = parseCounter(value.input_tokens);
  const cachedInputTokens = parseCounter(value.cached_input_tokens);
  const cacheWriteInputTokens =
    value.cache_write_input_tokens === undefined
      ? 0
      : parseCounter(value.cache_write_input_tokens);
  const outputTokens = parseCounter(value.output_tokens);
  const reasoningOutputTokens = parseCounter(value.reasoning_output_tokens);
  const totalTokens = parseCounter(value.total_tokens);
  if (
    inputTokens === undefined ||
    cachedInputTokens === undefined ||
    cacheWriteInputTokens === undefined ||
    outputTokens === undefined ||
    reasoningOutputTokens === undefined ||
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  };
}

function addUsageGroup(
  groups: Map<string, GroupAccumulator>,
  context: RecordContext,
  counts: TokenBreakdown
): boolean {
  const key = `${context.projectFolder}\u0000${context.worktreePath ?? ''}\u0000${context.model}\u0000${context.effort}`;
  const current = groups.get(key) ?? {
    projectFolder: context.projectFolder,
    ...(context.worktreePath === undefined
      ? {}
      : {worktreePath: context.worktreePath}),
    model: context.model,
    effort: context.effort,
    eventCount: 0,
    ...emptyBreakdown()
  };
  const next = addBreakdowns(current, counts);
  if (next === undefined || !Number.isSafeInteger(current.eventCount + 1)) {
    return false;
  }
  groups.set(key, {
    projectFolder: current.projectFolder,
    ...(current.worktreePath === undefined
      ? {}
      : {worktreePath: current.worktreePath}),
    model: current.model,
    effort: current.effort,
    eventCount: current.eventCount + 1,
    ...next
  });
  return true;
}

function addBreakdowns(
  left: TokenBreakdown,
  right: TokenBreakdown
): TokenBreakdown | undefined {
  const result = {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteInputTokens:
      left.cacheWriteInputTokens + right.cacheWriteInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens:
      left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens
  };
  return Object.values(result).every(Number.isSafeInteger) ? result : undefined;
}

function sumBreakdowns(
  values: readonly TokenBreakdown[]
): TokenBreakdown | undefined {
  let sum = emptyBreakdown();
  for (const value of values) {
    const next = addBreakdowns(sum, value);
    if (next === undefined) {
      return undefined;
    }
    sum = next;
  }
  return sum;
}

function compareDescending(left: number, right: number): number {
  return left === right ? 0 : left > right ? -1 : 1;
}

function emptyBreakdown(): TokenBreakdown {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  };
}

function parseCounter(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function parseSafeLabel(value: unknown): string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[\x20-\x7e]+$/u.test(value)
    ? value
    : UNKNOWN_LABEL;
}

export function projectFolderFromCwd(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4_096 ||
    !isAbsolute(value)
  ) {
    return UNKNOWN_LABEL;
  }
  const folder = basename(value).normalize('NFC');
  if (
    folder.length === 0 ||
    folder.length > 128 ||
    folder === '.' ||
    folder === '..' ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(folder)
  ) {
    return UNKNOWN_LABEL;
  }
  return folder;
}

export function worktreePathFromCwd(
  value: unknown,
  codexHome: string
): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4_096 ||
    !isAbsolute(value) ||
    codexHome.length === 0 ||
    codexHome.length > 4_096 ||
    !isAbsolute(codexHome) ||
    hasUnsafePathCharacters(value) ||
    hasUnsafePathCharacters(codexHome)
  ) {
    return undefined;
  }

  const trimmedCwd = value.replace(/\/+$/u, '');
  const rawComponents = trimmedCwd.slice(1).split(sep);
  if (
    trimmedCwd.length === 0 ||
    rawComponents.some(
      component =>
        component.length === 0 ||
        component === '.' ||
        component === '..'
    )
  ) {
    return undefined;
  }

  const worktreeRoot = resolve(codexHome, 'worktrees');
  const normalizedCwd = resolve(trimmedCwd);
  const containedPath = relative(worktreeRoot, normalizedCwd);
  if (
    containedPath.length === 0 ||
    containedPath === '..' ||
    containedPath.startsWith(`..${sep}`) ||
    isAbsolute(containedPath)
  ) {
    return undefined;
  }

  const components = containedPath.split(sep).map(component =>
    component.normalize('NFC')
  );
  if (
    components.some(
      component =>
        component.length === 0 ||
        component.length > 128 ||
        component === '.' ||
        component === '..' ||
        hasUnsafePathCharacters(component)
    )
  ) {
    return undefined;
  }
  const displayPath = ['worktrees', ...components].join('/');
  return displayPath.length <= 512 ? displayPath : undefined;
}

function hasUnsafePathCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(
    value
  );
}

function isTimestampInDay(value: unknown, dayKey: string): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === dayKey;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isObject(error) && error.code === 'ENOENT';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw signal.reason;
  }
}
