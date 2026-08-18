import {describe, expect, it} from 'vitest';
import {
  parseAccountResponse,
  parseLoginCompletedNotification,
  parseLoginStartResponse,
  parseRateLimitsResponse,
  parseUsageResponse
} from '../../src/codex/parsers.js';
import {
  normalizeDailyUsage,
  normalizeRateLimits,
  normalizeUsageSummary
} from '../../src/domain/normalization.js';

describe('protocol parsing and normalization', () => {
  it('classifies authentication without retaining account fields', () => {
    expect(
      parseAccountResponse({
        requiresOpenaiAuth: true,
        account: {
          type: 'chatgpt',
          planType: 'plus',
          email: 'not-retained@example.invalid',
          unknown: true
        }
      })
    ).toEqual({kind: 'chatgpt', planType: 'plus'});
    expect(
      parseAccountResponse({requiresOpenaiAuth: true, account: null})
    ).toEqual({kind: 'signedOut'});
    expect(
      parseAccountResponse({
        requiresOpenaiAuth: false,
        account: {type: 'apiKey'}
      })
    ).toEqual({kind: 'apiKeyUnsupported'});
  });

  it('normalizes all windows, prefers keyed duplicates, and clamps remaining', () => {
    const parsed = parseRateLimitsResponse({
      rateLimits: {
        limitId: 'codex',
        primary: {
          usedPercent: 20,
          windowDurationMins: 300,
          resetsAt: 1_900_000_000
        }
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          limitName: 'Codex requests',
          primary: {
            usedPercent: 20,
            windowDurationMins: 300,
            resetsAt: 1_900_000_000
          },
          secondary: {
            usedPercent: 120,
            windowDurationMins: 10_080,
            resetsAt: null
          },
          futureField: 'accepted'
        }
      },
      ignoredCredits: {}
    });
    const limits = normalizeRateLimits(parsed, new Date('2026-07-24T00:00:00Z'));
    expect(limits).toHaveLength(2);
    expect(limits[0]).toMatchObject({
      displayName: 'Codex requests',
      windowKind: 'primary',
      remainingPercent: 80
    });
    expect(limits[1]).toMatchObject({
      windowKind: 'secondary',
      remainingPercent: 0
    });
  });

  it('derives a useful label when optional metadata is missing', () => {
    const response = parseRateLimitsResponse({
      rateLimits: {
        primary: {usedPercent: -10, windowDurationMins: null, resetsAt: null}
      }
    });
    expect(normalizeRateLimits(response)[0]).toMatchObject({
      displayName: 'Primary usage limit',
      remainingPercent: 100
    });
  });

  it('preserves valid service day keys and ignores invalid buckets', () => {
    const usage = parseUsageResponse({
      summary: {
        lifetimeTokens: 1_234,
        currentStreakDays: 4,
        longestStreakDays: 13,
        peakDailyTokens: 456,
        longestRunningTurnSec: 5_375,
        unknown: true
      },
      dailyUsageBuckets: [
        {startDate: '2026-07-23', tokens: 100},
        {startDate: 'not-a-day', tokens: 200}
      ],
      futureField: true
    });
    expect(
      normalizeDailyUsage(usage, new Date('2026-07-24T00:00:00Z'))
    ).toEqual([
      {
        dayKey: '2026-07-23',
        tokens: 100,
        fetchedAt: '2026-07-24T00:00:00.000Z'
      }
    ]);
    expect(normalizeUsageSummary(usage)).toEqual({
      lifetimeTokens: 1_234,
      currentStreakDays: 4,
      longestStreakDays: 13,
      peakDailyTokens: 456,
      longestRunningTurnSeconds: 5_375
    });
  });

  it('accepts nullable summary metrics and rejects invalid values', () => {
    expect(
      parseUsageResponse({
        summary: {
          lifetimeTokens: null,
          currentStreakDays: null,
          longestStreakDays: null,
          peakDailyTokens: null,
          longestRunningTurnSec: null
        },
        dailyUsageBuckets: null
      })
    ).toEqual({
      summary: {
        lifetimeTokens: null,
        currentStreakDays: null,
        longestStreakDays: null,
        peakDailyTokens: null,
        longestRunningTurnSec: null
      },
      dailyUsageBuckets: null
    });
    expect(() =>
      parseUsageResponse({
        summary: {lifetimeTokens: -1},
        dailyUsageBuckets: null
      })
    ).toThrow(/incompatible/u);
  });

  it('rejects missing required protocol structures', () => {
    expect(() => parseRateLimitsResponse({})).toThrow(/incompatible/u);
    expect(() => parseUsageResponse({dailyUsageBuckets: []})).toThrow(
      /incompatible/u
    );
    expect(() => parseAccountResponse({account: null})).toThrow(/incompatible/u);
  });

  it('accepts only managed HTTPS ChatGPT login responses', () => {
    expect(
      parseLoginStartResponse({
        type: 'chatgpt',
        authUrl: 'https://example.invalid/authorize',
        loginId: 'login-fixture',
        unknown: true
      })
    ).toEqual({
      authUrl: 'https://example.invalid/authorize',
      loginId: 'login-fixture'
    });
    expect(() =>
      parseLoginStartResponse({
        type: 'chatgpt',
        authUrl: 'http://example.invalid/authorize',
        loginId: 'login-fixture'
      })
    ).toThrow(/incompatible/u);
    expect(() =>
      parseLoginStartResponse({type: 'chatgptAuthTokens'})
    ).toThrow(/incompatible/u);
  });

  it('parses login completion without retaining server error text', () => {
    expect(
      parseLoginCompletedNotification({
        loginId: 'login-fixture',
        success: false,
        error: 'must not be retained'
      })
    ).toEqual({loginId: 'login-fixture', success: false});
  });
});
