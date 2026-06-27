import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthFileItem, CodexQuotaState } from '@/types';
import { AuthFileQuotaSection } from './AuthFileQuotaSection';

const { mocks } = vi.hoisted(() => {
  const quotaStoreState: Record<string, unknown> = {
    codexQuota: {},
  };

  quotaStoreState.setCodexQuota = vi.fn((updater: unknown) => {
    const current = quotaStoreState.codexQuota as Record<string, unknown>;
    quotaStoreState.codexQuota =
      typeof updater === 'function' ? (updater as (prev: typeof current) => typeof current)(current) : updater;
  });

  return {
    mocks: {
      quotaStoreState,
      showNotification: vi.fn(),
    },
  };
});

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/stores', () => ({
  useNotificationStore: (selector: (state: unknown) => unknown) =>
    selector({
      showNotification: mocks.showNotification,
    }),
  useQuotaStore: (selector: (state: unknown) => unknown) => selector(mocks.quotaStoreState),
}));

const file: AuthFileItem = {
  name: 'shared-codex.json',
  type: 'codex',
  authIndex: 1,
};

const matchingQuota: CodexQuotaState = {
  status: 'success',
  windows: [],
  planType: 'pro',
  subscriptionActiveUntil: null,
  rateLimitResetCreditsAvailableCount: 2,
  authFileKey: 'shared-codex.json::1',
  authFileName: 'shared-codex.json',
  authIndex: '1',
};

const mismatchedQuota: CodexQuotaState = {
  ...matchingQuota,
  authFileKey: 'shared-codex.json::0',
  authIndex: '0',
};

const legacyQuotaWithoutIdentity: CodexQuotaState = {
  status: 'success',
  windows: [],
  planType: 'pro',
  subscriptionActiveUntil: null,
  rateLimitResetCreditsAvailableCount: 2,
};

const getText = (node: ReactTestInstance): string =>
  node.children
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child);
      return getText(child);
    })
    .join('');

const renderSection = (quotaOverride?: CodexQuotaState | null) => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <AuthFileQuotaSection
        file={file}
        quotaType="codex"
        disableControls={false}
        quotaOverride={quotaOverride}
      />
    );
  });
  return renderer;
};

describe('AuthFileQuotaSection Codex quota scoping', () => {
  beforeEach(() => {
    mocks.showNotification.mockReset();
    mocks.quotaStoreState.codexQuota = {};
    (mocks.quotaStoreState.setCodexQuota as ReturnType<typeof vi.fn>).mockClear();
  });

  it('does not fall back to stored Codex quota when override explicitly clears display quota', () => {
    mocks.quotaStoreState.codexQuota = {
      [file.name]: matchingQuota,
    };

    const renderer = renderSection(null);
    const text = getText(renderer.root);

    expect(text).toContain('codex_quota.idle');
    expect(text).not.toContain('codex_quota.plan_pro');
  });

  it('reads matching stored Codex quota by auth file identity key', () => {
    mocks.quotaStoreState.codexQuota = {
      [matchingQuota.authFileKey as string]: matchingQuota,
    };

    const renderer = renderSection();
    const text = getText(renderer.root);

    expect(text).toContain('codex_quota.plan_pro');
    expect(text).not.toContain('codex_quota.idle');
  });

  it('ignores stored Codex quota from another same-name auth file', () => {
    mocks.quotaStoreState.codexQuota = {
      [mismatchedQuota.authFileKey as string]: mismatchedQuota,
    };

    const renderer = renderSection();
    const text = getText(renderer.root);

    expect(text).toContain('codex_quota.idle');
    expect(text).not.toContain('codex_quota.plan_pro');
  });

  it('ignores legacy Codex quota without identity for auth-indexed files', () => {
    mocks.quotaStoreState.codexQuota = {
      [file.name]: legacyQuotaWithoutIdentity,
    };

    const renderer = renderSection();
    const text = getText(renderer.root);

    expect(text).toContain('codex_quota.idle');
    expect(text).not.toContain('codex_quota.plan_pro');
  });
});
