import { describe, expect, it } from 'vitest';
import { getSortedCodexResetCreditExpiries, resolveQuotaDisplayState } from './quotaConfigs';

type TestQuotaState = {
  status: 'idle' | 'loading' | 'success' | 'error';
  errorStatus?: number;
  fetchedAtMs?: number;
  observedAtMs?: number;
  observedFromUsageHeaders?: boolean;
  windows?: unknown[];
};

describe('getSortedCodexResetCreditExpiries', () => {
  it('filters expired or invalid reset credits and sorts by expiry time', () => {
    const expiries = getSortedCodexResetCreditExpiries(
      [
        {
          id: 'late',
          status: 'available',
          grantedAt: '2026-06-29T00:00:00Z',
          expiresAt: '2026-07-19T00:42:09Z',
        },
        {
          id: 'expired',
          status: 'available',
          grantedAt: '2026-06-29T00:00:00Z',
          expiresAt: '2026-07-17T08:31:33Z',
        },
        {
          id: 'invalid',
          status: 'available',
          grantedAt: '2026-06-29T00:00:00Z',
          expiresAt: 'not-a-date',
        },
        {
          id: 'early',
          status: 'available',
          grantedAt: '2026-06-29T00:00:00Z',
          expiresAt: '2026-07-18T08:31:33Z',
        },
      ],
      new Date('2026-07-18T00:00:00Z').getTime()
    );

    expect(expiries.map((item) => item.id)).toEqual(['early', 'late']);
    expect(expiries.map((item) => item.expiresAtMs)).toEqual([
      new Date('2026-07-18T08:31:33Z').getTime(),
      new Date('2026-07-19T00:42:09Z').getTime(),
    ]);
  });
});

describe('resolveQuotaDisplayState', () => {
  it('keeps a newer manual quota refresh over an older header snapshot', () => {
    const activeQuota: TestQuotaState = {
      status: 'success',
      fetchedAtMs: 2_000,
      windows: [],
    };
    const observedQuota: TestQuotaState = {
      status: 'success',
      observedAtMs: 1_000,
      observedFromUsageHeaders: true,
      windows: [],
    };

    expect(resolveQuotaDisplayState(activeQuota, observedQuota)).toBe(activeQuota);
  });

  it('uses a newer header snapshot when it is fresher than the manual quota refresh', () => {
    const activeQuota: TestQuotaState = {
      status: 'success',
      fetchedAtMs: 1_000,
      windows: [],
    };
    const observedQuota: TestQuotaState = {
      status: 'success',
      observedAtMs: 2_000,
      observedFromUsageHeaders: true,
      windows: [],
    };

    expect(resolveQuotaDisplayState(activeQuota, observedQuota)).toBe(observedQuota);
  });

  it('keeps 401 quota errors so reauth controls stay visible', () => {
    const activeQuota: TestQuotaState = {
      status: 'error',
      errorStatus: 401,
    };
    const observedQuota: TestQuotaState = {
      status: 'success',
      observedAtMs: 2_000,
    };

    expect(resolveQuotaDisplayState(activeQuota, observedQuota)).toBe(activeQuota);
  });
});
