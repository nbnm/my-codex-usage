import {AppError} from '../domain/errors.js';
import type {
  AccountStatus,
  AccountUsageDTO,
  CodexRuntimeInfo,
  LoginPrompt,
  RateLimitSnapshotDTO,
  RateLimitsDTO,
  RateLimitWindowDTO
} from '../domain/types.js';

export function parseInitializeResponse(value: unknown): CodexRuntimeInfo {
  const object = requiredRecord(value, 'initialize response');
  requiredString(object.platformFamily, 'initialize platformFamily');
  requiredString(object.platformOs, 'initialize platformOs');
  requiredString(object.userAgent, 'initialize userAgent');
  const codexHome = requiredString(object.codexHome, 'initialize codexHome');
  if (codexHome.trim() === '') {
    throw incompatible('initialize codexHome');
  }
  return {codexHome};
}

export function parseAccountResponse(value: unknown): AccountStatus {
  const object = requiredRecord(value, 'account response');
  requiredBoolean(
    object.requiresOpenaiAuth,
    'account requiresOpenaiAuth'
  );
  if (object.account === null || object.account === undefined) {
    return {kind: 'signedOut'};
  }

  const account = requiredRecord(object.account, 'account');
  const type = requiredString(account.type, 'account type');
  if (type === 'chatgpt') {
    return {
      kind: 'chatgpt',
      planType: requiredString(account.planType, 'ChatGPT planType')
    };
  }
  if (type === 'apiKey') {
    return {kind: 'apiKeyUnsupported'};
  }
  return {kind: 'unsupported', accountType: type};
}

export function parseRateLimitsResponse(value: unknown): RateLimitsDTO {
  const object = requiredRecord(value, 'rate-limits response');
  const rateLimits = parseRateLimitSnapshot(object.rateLimits, 'rateLimits');
  let rateLimitsByLimitId: Record<string, RateLimitSnapshotDTO> | null = null;
  if (object.rateLimitsByLimitId !== null && object.rateLimitsByLimitId !== undefined) {
    const byId = requiredRecord(
      object.rateLimitsByLimitId,
      'rateLimitsByLimitId'
    );
    rateLimitsByLimitId = {};
    for (const [limitId, snapshot] of Object.entries(byId)) {
      rateLimitsByLimitId[limitId] = parseRateLimitSnapshot(
        snapshot,
        `rateLimitsByLimitId.${limitId}`
      );
    }
  }
  return {rateLimits, rateLimitsByLimitId};
}

export function parseUsageResponse(value: unknown): AccountUsageDTO {
  const object = requiredRecord(value, 'usage response');
  const summary = requiredRecord(object.summary, 'usage summary');
  const parsedSummary = {
    lifetimeTokens: nullableNonNegativeSafeInteger(
      summary.lifetimeTokens,
      'usage summary lifetimeTokens'
    ),
    currentStreakDays: nullableNonNegativeSafeInteger(
      summary.currentStreakDays,
      'usage summary currentStreakDays'
    ),
    longestStreakDays: nullableNonNegativeSafeInteger(
      summary.longestStreakDays,
      'usage summary longestStreakDays'
    ),
    peakDailyTokens: nullableNonNegativeSafeInteger(
      summary.peakDailyTokens,
      'usage summary peakDailyTokens'
    ),
    longestRunningTurnSec: nullableNonNegativeSafeInteger(
      summary.longestRunningTurnSec,
      'usage summary longestRunningTurnSec'
    )
  };
  if (object.dailyUsageBuckets === null || object.dailyUsageBuckets === undefined) {
    return {summary: parsedSummary, dailyUsageBuckets: null};
  }
  if (!Array.isArray(object.dailyUsageBuckets)) {
    throw incompatible('usage dailyUsageBuckets');
  }
  return {
    summary: parsedSummary,
    dailyUsageBuckets: object.dailyUsageBuckets.map((bucket, index) => {
      const record = requiredRecord(bucket, `dailyUsageBuckets[${index}]`);
      return {
        startDate: requiredString(
          record.startDate,
          `dailyUsageBuckets[${index}].startDate`
        ),
        tokens: requiredSafeInteger(
          record.tokens,
          `dailyUsageBuckets[${index}].tokens`
        )
      };
    })
  };
}

export function parseLoginStartResponse(value: unknown): LoginPrompt {
  const object = requiredRecord(value, 'login response');
  if (requiredString(object.type, 'login type') !== 'chatgpt') {
    throw incompatible('login type');
  }
  const authUrl = requiredString(object.authUrl, 'login authUrl');
  const loginId = requiredString(object.loginId, 'login loginId');
  if (loginId.trim() === '') {
    throw incompatible('login loginId');
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(authUrl);
  } catch {
    throw incompatible('login authUrl');
  }
  if (parsedUrl.protocol !== 'https:') {
    throw incompatible('login authUrl');
  }
  return {authUrl: parsedUrl.toString(), loginId};
}

export function parseLoginCompletedNotification(
  value: unknown
): {loginId: string | null; success: boolean} {
  const object = requiredRecord(value, 'login completion');
  return {
    loginId: nullableString(object.loginId, 'login completion loginId'),
    success: requiredBoolean(object.success, 'login completion success')
  };
}

function parseRateLimitSnapshot(
  value: unknown,
  field: string
): RateLimitSnapshotDTO {
  const object = requiredRecord(value, field);
  return {
    limitId: nullableString(object.limitId, `${field}.limitId`),
    limitName: nullableString(object.limitName, `${field}.limitName`),
    planType: nullableString(object.planType, `${field}.planType`),
    primary: nullableWindow(object.primary, `${field}.primary`),
    secondary: nullableWindow(object.secondary, `${field}.secondary`),
    rateLimitReachedType: nullableString(
      object.rateLimitReachedType,
      `${field}.rateLimitReachedType`
    )
  };
}

function nullableWindow(value: unknown, field: string): RateLimitWindowDTO | null {
  if (value === null || value === undefined) {
    return null;
  }
  const object = requiredRecord(value, field);
  return {
    usedPercent: requiredSafeInteger(object.usedPercent, `${field}.usedPercent`),
    windowDurationMins: nullableSafeInteger(
      object.windowDurationMins,
      `${field}.windowDurationMins`
    ),
    resetsAt: nullableSafeInteger(object.resetsAt, `${field}.resetsAt`)
  };
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw incompatible(field);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw incompatible(field);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return requiredString(value, field);
}

function nullableNonNegativeSafeInteger(
  value: unknown,
  field: string
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const number = requiredSafeInteger(value, field);
  if (number < 0) {
    throw incompatible(field);
  }
  return number;
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw incompatible(field);
  }
  return value;
}

function requiredSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw incompatible(field);
  }
  return value as number;
}

function nullableSafeInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return requiredSafeInteger(value, field);
}

function incompatible(field: string): AppError {
  return new AppError(
    'protocolIncompatible',
    `Codex returned an incompatible ${field}.`,
    'Update my-codex-usage or use a supported Codex version.'
  );
}
