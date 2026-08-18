import type {
  CreditEstimate,
  CreditEstimateSummary,
  CreditRate,
  TodayUsageGroup,
  TokenBreakdown
} from './types.js';

const MILLION = 1_000_000;

export const CREDIT_RATE_CARD: readonly CreditRate[] = [
  rated('gpt-5.6-sol', 'GPT-5.6 Sol', ['gpt-5.6-sol'], 125, 12.5, 750),
  rated(
    'daybreak-blue',
    'Daybreak Blue',
    ['daybreak-blue', 'gpt-daybreak-blue'],
    125,
    12.5,
    750
  ),
  rated(
    'daybreak-red',
    'Daybreak Red',
    ['daybreak-red', 'gpt-daybreak-red'],
    312.5,
    31.25,
    1_875
  ),
  rated('gpt-5.6-terra', 'GPT-5.6 Terra', ['gpt-5.6-terra'], 50, 5, 300),
  rated('gpt-5.6-luna', 'GPT-5.6 Luna', ['gpt-5.6-luna'], 5, 0.5, 30),
  rated('gpt-5.5', 'GPT-5.5', ['gpt-5.5'], 125, 12.5, 750),
  rated('gpt-5.4', 'GPT-5.4', ['gpt-5.4'], 62.5, 6.25, 375),
  rated(
    'gpt-5.4-mini',
    'GPT-5.4 mini',
    ['gpt-5.4-mini'],
    18.75,
    1.875,
    113
  ),
  {
    kind: 'researchPreview',
    id: 'gpt-5.3-codex-spark',
    displayName: 'GPT-5.3-Codex-Spark',
    aliases: ['gpt-5.3-codex-spark']
  },
  rated(
    'gpt-image-2-image',
    'GPT-Image-2 (image)',
    ['gpt-image-2-image', 'gpt-image-2 (image)'],
    200,
    50,
    750
  ),
  rated(
    'gpt-image-2-text',
    'GPT-Image-2 (text)',
    ['gpt-image-2-text', 'gpt-image-2 (text)'],
    125,
    31.25,
    250
  )
];

const RATE_BY_ALIAS = new Map<string, CreditRate>(
  CREDIT_RATE_CARD.flatMap(rate =>
    rate.aliases.map(alias => [normalizeModel(alias), rate] as const)
  )
);

export function findCreditRate(model: string): CreditRate | undefined {
  return RATE_BY_ALIAS.get(normalizeModel(model));
}

export function estimateCredits(
  model: string,
  tokens: TokenBreakdown
): CreditEstimate {
  const rate = findCreditRate(model);
  if (rate === undefined) {
    return {status: 'unpriced', rateName: undefined, reason: 'unknownModel'};
  }
  if (rate.kind === 'researchPreview') {
    return {
      status: 'unpriced',
      rateName: rate.displayName,
      reason: 'researchPreview'
    };
  }
  if (tokens.cachedInputTokens > tokens.inputTokens) {
    return {
      status: 'unpriced',
      rateName: rate.displayName,
      reason: 'inconsistentCounters'
    };
  }

  const uncachedInputTokens = Math.max(
    tokens.inputTokens - tokens.cachedInputTokens,
    0
  );
  const inputCredits =
    (uncachedInputTokens * rate.inputCreditsPerMillion) / MILLION;
  const cachedInputCredits =
    (tokens.cachedInputTokens * rate.cachedInputCreditsPerMillion) / MILLION;
  const outputCredits =
    (tokens.outputTokens * rate.outputCreditsPerMillion) / MILLION;
  return {
    status: 'estimated',
    rateName: rate.displayName,
    uncachedInputTokens,
    inputCredits,
    cachedInputCredits,
    outputCredits,
    totalCredits: inputCredits + cachedInputCredits + outputCredits
  };
}

export function summarizeCreditEstimates(
  groups: readonly TodayUsageGroup[]
): CreditEstimateSummary {
  let estimatedCredits = 0;
  let pricedGroupCount = 0;
  let unpricedGroupCount = 0;
  for (const group of groups) {
    const estimate = estimateCredits(group.model, group);
    if (estimate.status === 'estimated') {
      estimatedCredits += estimate.totalCredits;
      pricedGroupCount++;
    } else {
      unpricedGroupCount++;
    }
  }
  return {estimatedCredits, pricedGroupCount, unpricedGroupCount};
}

export function describeUnpricedEstimate(estimate: CreditEstimate): string {
  if (estimate.status === 'estimated') {
    return '';
  }
  if (estimate.reason === 'researchPreview') {
    return 'research preview';
  }
  if (estimate.reason === 'inconsistentCounters') {
    return 'inconsistent counters';
  }
  return 'rate unavailable';
}

function rated(
  id: string,
  displayName: string,
  aliases: readonly string[],
  inputCreditsPerMillion: number,
  cachedInputCreditsPerMillion: number,
  outputCreditsPerMillion: number
): CreditRate {
  return {
    kind: 'rated',
    id,
    displayName,
    aliases,
    inputCreditsPerMillion,
    cachedInputCreditsPerMillion,
    outputCreditsPerMillion
  };
}

function normalizeModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/[()]/gu, '')
    .replace(/[\s_]+/gu, '-')
    .replace(/-+/gu, '-');
}
