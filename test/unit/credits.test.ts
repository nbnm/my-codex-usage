import {describe, expect, it} from 'vitest';
import {
  CREDIT_RATE_CARD,
  estimateCredits,
  findCreditRate,
  summarizeCreditEstimates
} from '../../src/domain/credits.js';
import type {TodayUsageGroup, TokenBreakdown} from '../../src/domain/types.js';

const tokens: TokenBreakdown = {
  inputTokens: 1_000_000,
  cachedInputTokens: 400_000,
  cacheWriteInputTokens: 200_000,
  outputTokens: 100_000,
  reasoningOutputTokens: 80_000,
  totalTokens: 1_100_000
};

describe('current-day credit estimates', () => {
  it('contains the complete supplied rate card', () => {
    expect(CREDIT_RATE_CARD.map(rate => rate.displayName)).toEqual([
      'GPT-5.6 Sol',
      'Daybreak Blue',
      'Daybreak Red',
      'GPT-5.6 Terra',
      'GPT-5.6 Luna',
      'GPT-5.5',
      'GPT-5.4',
      'GPT-5.4 mini',
      'GPT-5.3-Codex-Spark',
      'GPT-Image-2 (image)',
      'GPT-Image-2 (text)'
    ]);
    expect(findCreditRate('GPT-Image-2 (text)')?.displayName).toBe(
      'GPT-Image-2 (text)'
    );
    expect(findCreditRate('gpt-daybreak-red')?.displayName).toBe('Daybreak Red');
    expect(
      CREDIT_RATE_CARD.map(rate =>
        rate.kind === 'rated'
          ? [
              rate.displayName,
              rate.inputCreditsPerMillion,
              rate.cachedInputCreditsPerMillion,
              rate.outputCreditsPerMillion
            ]
          : [rate.displayName, 'research preview']
      )
    ).toEqual([
      ['GPT-5.6 Sol', 125, 12.5, 750],
      ['Daybreak Blue', 125, 12.5, 750],
      ['Daybreak Red', 312.5, 31.25, 1_875],
      ['GPT-5.6 Terra', 50, 5, 300],
      ['GPT-5.6 Luna', 5, 0.5, 30],
      ['GPT-5.5', 125, 12.5, 750],
      ['GPT-5.4', 62.5, 6.25, 375],
      ['GPT-5.4 mini', 18.75, 1.875, 113],
      ['GPT-5.3-Codex-Spark', 'research preview'],
      ['GPT-Image-2 (image)', 200, 50, 750],
      ['GPT-Image-2 (text)', 125, 31.25, 250]
    ]);
  });

  it('subtracts cached input and prices output once', () => {
    const estimate = estimateCredits('gpt-5.6-sol', tokens);
    expect(estimate).toMatchObject({
      status: 'estimated',
      uncachedInputTokens: 600_000,
      inputCredits: 75,
      cachedInputCredits: 5,
      outputCredits: 75,
      totalCredits: 155
    });
  });

  it('does not charge cache-write or reasoning counters a second time', () => {
    const changedDetails = {
      ...tokens,
      cacheWriteInputTokens: 999_999_999,
      reasoningOutputTokens: 999_999_999
    };
    expect(estimateCredits('gpt-5.6-sol', changedDetails)).toEqual(
      estimateCredits('gpt-5.6-sol', tokens)
    );
  });

  it('leaves research-preview, unknown, and inconsistent rows unpriced', () => {
    expect(estimateCredits('gpt-5.3-codex-spark', tokens)).toMatchObject({
      status: 'unpriced',
      reason: 'researchPreview'
    });
    expect(estimateCredits('future-model', tokens)).toEqual({
      status: 'unpriced',
      rateName: undefined,
      reason: 'unknownModel'
    });
    expect(
      estimateCredits('gpt-5.6-sol', {
        ...tokens,
        inputTokens: 1,
        cachedInputTokens: 2
      })
    ).toMatchObject({status: 'unpriced', reason: 'inconsistentCounters'});
  });

  it('reports a priced-only subtotal when some groups are unpriced', () => {
    const groups: TodayUsageGroup[] = [
      group('gpt-5.6-sol'),
      group('gpt-5.3-codex-spark'),
      group('future-model')
    ];
    expect(summarizeCreditEstimates(groups)).toEqual({
      estimatedCredits: 155,
      pricedGroupCount: 1,
      unpricedGroupCount: 2
    });
  });
});

function group(model: string): TodayUsageGroup {
  return {...tokens, model, effort: 'high', eventCount: 1};
}
