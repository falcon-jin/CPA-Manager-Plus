import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthFileItem, CodexQuotaState } from '@/types';
import { AuthFileQuotaSection } from './AuthFileQuotaSection';

const { mocks } = vi.hoisted(() => {
  const quotaStoreState: Record<string, unknown> = {
    codexQuota: {},
  };

  return {
    mocks: {
      quotaStoreState,
      refreshQuota: vi.fn(),
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

const findButtonByText = (renderer: ReactTestRenderer, text: string) => {
  const button = renderer.root.findAllByType('button').find((node) => getText(node).includes(text));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
};

const renderSection = (
  quotaOverride?: CodexQuotaState | null,
  fileOverride: AuthFileItem = file
) => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <AuthFileQuotaSection
        file={fileOverride}
        quotaType="codex"
        disableControls={false}
        quotaOverride={quotaOverride}
        onRefreshQuota={mocks.refreshQuota}
      />
    );
  });
  return renderer;
};

describe('AuthFileQuotaSection Codex quota scoping', () => {
  beforeEach(() => {
    mocks.refreshQuota.mockReset();
    mocks.quotaStoreState.codexQuota = {};
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

  it('shows an explicit refresh button when quota is already loaded', () => {
    const renderer = renderSection(matchingQuota);

    expect(getText(renderer.root)).toContain('codex_quota.plan_pro');
    expect(findButtonByText(renderer, 'auth_files.quota_refresh_single')).toBeDefined();
  });

  it('keeps the visible refresh label in the accessible name while retaining the hint title', () => {
    const renderer = renderSection(matchingQuota);
    const button = findButtonByText(renderer, 'auth_files.quota_refresh_single');

    expect(button.props.title).toBe('auth_files.quota_refresh_hint');
    expect(button.props['aria-label']).toBe('auth_files.quota_refresh_single');
  });

  it('delegates refresh for the current credential', async () => {
    const renderer = renderSection(matchingQuota);

    await act(async () => {
      findButtonByText(renderer, 'auth_files.quota_refresh_single').props.onClick();
    });

    expect(mocks.refreshQuota).toHaveBeenCalledWith(file);
  });

  it('disables the refresh button while quota is loading', () => {
    const renderer = renderSection({ ...matchingQuota, status: 'loading' });

    expect(findButtonByText(renderer, 'auth_files.quota_refresh_single').props.disabled).toBe(true);
  });

  it.each([
    ['status disabled', { status: 'disabled' }],
    ['state inactive', { state: 'inactive' }],
  ])('disables the refresh button for normalized %s auth files', (_label, disabledState) => {
    const renderer = renderSection(matchingQuota, { ...file, ...disabledState });

    expect(findButtonByText(renderer, 'auth_files.quota_refresh_single').props.disabled).toBe(true);
  });
});
