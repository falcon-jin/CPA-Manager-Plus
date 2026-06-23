import { act } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthFileItem } from '@/types';
import type { QuotaConfig } from './quotaConfigs';
import { QuotaSection } from './QuotaSection';

type TestQuotaState = {
  status: 'idle' | 'loading' | 'success' | 'error';
  windows: unknown[];
  error?: string;
  errorStatus?: number;
  rateLimitResetCreditsAvailableCount?: number | null;
};

type TestQuotaData = {
  resetCredits: number;
};

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
      fetchQuota: vi.fn(),
      quotaStoreState,
      resetQuota: vi.fn(),
      showConfirmation: vi.fn(),
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

vi.mock('@/hooks/useHeaderRefresh', () => ({
  triggerHeaderRefresh: vi.fn(),
}));

vi.mock('@/stores', () => ({
  useNotificationStore: (selector: (state: unknown) => unknown) =>
    selector({
      showConfirmation: mocks.showConfirmation,
      showNotification: mocks.showNotification,
    }),
  useQuotaStore: (selector: (state: unknown) => unknown) => selector(mocks.quotaStoreState),
  useThemeStore: (selector: (state: unknown) => unknown) => selector({ resolvedTheme: 'light' }),
}));

const FULL_FILE_NAME = 'very-long-account-name@example.com.json';
const MASKED_FILE_NAME = 'ver***@example.com.json';

const testFile: AuthFileItem = {
  name: FULL_FILE_NAME,
  type: 'codex',
};

const successQuota: TestQuotaState = {
  status: 'success',
  windows: [],
  rateLimitResetCreditsAvailableCount: 2,
};

const testConfig: QuotaConfig<TestQuotaState, TestQuotaData> = {
  type: 'codex',
  i18nPrefix: 'codex_quota',
  filterFn: () => true,
  fetchQuota: (file, t) => mocks.fetchQuota(file, t) as Promise<TestQuotaData>,
  storeSelector: (state) => state.codexQuota,
  storeSetter: 'setCodexQuota',
  buildLoadingState: () => ({ status: 'loading', windows: [] }),
  buildSuccessState: (data) => ({
    status: 'success',
    windows: [],
    rateLimitResetCreditsAvailableCount: data.resetCredits,
  }),
  buildErrorState: (message, status) => ({
    status: 'error',
    windows: [],
    error: message,
    errorStatus: status,
  }),
  cardClassName: 'codex-card',
  controlsClassName: 'codex-controls',
  controlClassName: 'codex-control',
  gridClassName: 'codex-grid',
  resetQuota: (file, t) => mocks.resetQuota(file, t) as Promise<TestQuotaData>,
  canResetQuota: (_file, quota) =>
    quota?.status === 'success' && (quota.rateLimitResetCreditsAvailableCount ?? 0) > 0,
  renderQuotaItems: () => <div>quota loaded</div>,
};

const getText = (node: ReactTestInstance): string =>
  node.children
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child);
      return getText(child);
    })
    .join('');

const renderSection = () => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      <QuotaSection
        config={testConfig}
        files={[testFile]}
        loading={false}
        disabled={false}
        accountDisplayMode="masked"
      />
    );
  });
  return renderer;
};

const findButtonByText = (renderer: ReactTestRenderer, text: string) => {
  const button = renderer.root.findAllByType('button').find((node) => getText(node).includes(text));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
};

describe('QuotaSection account display mode', () => {
  beforeEach(() => {
    mocks.fetchQuota.mockReset();
    mocks.resetQuota.mockReset();
    mocks.showConfirmation.mockReset();
    mocks.showNotification.mockReset();
    mocks.quotaStoreState.codexQuota = {
      [FULL_FILE_NAME]: successQuota,
    };
    (mocks.quotaStoreState.setCodexQuota as ReturnType<typeof vi.fn>).mockClear();
  });

  it('uses masked names in single quota refresh notifications', async () => {
    mocks.fetchQuota.mockResolvedValue({ resetCredits: 1 });
    const renderer = renderSection();

    await act(async () => {
      findButtonByText(renderer, 'codex_quota.refresh_button').props.onClick();
      await Promise.resolve();
    });

    const message = String(mocks.showNotification.mock.calls[0]?.[0] ?? '');
    expect(message).toContain(MASKED_FILE_NAME);
    expect(message).not.toContain(FULL_FILE_NAME);
  });

  it('uses masked names in failed single quota refresh notifications', async () => {
    mocks.fetchQuota.mockRejectedValue(new Error('network failed'));
    const renderer = renderSection();

    await act(async () => {
      findButtonByText(renderer, 'codex_quota.refresh_button').props.onClick();
      await Promise.resolve();
    });

    const message = String(mocks.showNotification.mock.calls[0]?.[0] ?? '');
    expect(message).toContain(MASKED_FILE_NAME);
    expect(message).not.toContain(FULL_FILE_NAME);
  });

  it('uses masked names in quota reset confirmation and success notification', async () => {
    mocks.resetQuota.mockResolvedValue({ resetCredits: 1 });
    const renderer = renderSection();

    act(() => {
      findButtonByText(renderer, 'codex_quota.reset_action_button').props.onClick();
    });

    const confirmation = mocks.showConfirmation.mock.calls[0]?.[0] as {
      message: string;
      onConfirm: () => Promise<void>;
    };
    expect(confirmation.message).toContain(MASKED_FILE_NAME);
    expect(confirmation.message).not.toContain(FULL_FILE_NAME);

    await act(async () => {
      await confirmation.onConfirm();
    });

    const message = String(mocks.showNotification.mock.calls[0]?.[0] ?? '');
    expect(message).toContain(MASKED_FILE_NAME);
    expect(message).not.toContain(FULL_FILE_NAME);
  });

  it('uses masked names in failed quota reset notifications', async () => {
    mocks.resetQuota.mockRejectedValue(new Error('reset failed'));
    const renderer = renderSection();

    act(() => {
      findButtonByText(renderer, 'codex_quota.reset_action_button').props.onClick();
    });

    const confirmation = mocks.showConfirmation.mock.calls[0]?.[0] as {
      onConfirm: () => Promise<void>;
    };

    await act(async () => {
      await confirmation.onConfirm();
    });

    const message = String(mocks.showNotification.mock.calls[0]?.[0] ?? '');
    expect(message).toContain(MASKED_FILE_NAME);
    expect(message).not.toContain(FULL_FILE_NAME);
  });
});
