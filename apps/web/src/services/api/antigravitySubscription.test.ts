import { describe, expect, it } from 'vitest';
import { parseAntigravitySubscriptionSummary } from './antigravitySubscription';

describe('parseAntigravitySubscriptionSummary', () => {
  it('parses free-tier subscription data from a proxied body string', () => {
    const summary = parseAntigravitySubscriptionSummary({
      body: JSON.stringify({
        currentTier: {
          id: 'free-tier',
          name: 'Antigravity',
        },
        paidTier: {
          id: 'free-tier',
          name: 'Antigravity Starter Quota',
        },
      }),
    });

    expect(summary).toMatchObject({
      plan: 'free',
      tierId: 'free-tier',
      tierName: 'Antigravity Starter Quota',
      source: 'paid',
      currentTier: {
        id: 'free-tier',
        name: 'Antigravity',
      },
      paidTier: {
        id: 'free-tier',
        name: 'Antigravity Starter Quota',
      },
    });
  });
});
