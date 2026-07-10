import { act, createElement, createRef, useImperativeHandle, type Ref } from 'react';
import { create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import {
  useAuthFileQuotaRefresh,
  type UseAuthFileQuotaRefreshResult,
} from './useAuthFileQuotaRefresh';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    fetchCodexQuota: vi.fn(),
    showNotification: vi.fn(),
  },
}));

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options?.name ? `${key}:${options.name}` : key,
  }),
}));

vi.mock('@/utils/quota', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/quota')>();
  return {
    ...actual,
    fetchCodexQuota: mocks.fetchCodexQuota,
  };
});

vi.mock('@/stores', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores')>();
  return {
    ...actual,
    useNotificationStore: (
      selector: (state: { showNotification: typeof mocks.showNotification }) => unknown
    ) => selector({ showNotification: mocks.showNotification }),
  };
});

const codexQuotaData = {
  planType: 'team',
  windows: [],
  subscriptionActiveUntil: null,
  rateLimitResetCreditsAvailableCount: 0,
  rateLimitResetCredits: [],
  rateLimitResetCreditsError: null,
};

const file: AuthFileItem = {
  name: 'team.json',
  type: 'codex',
  authIndex: 1,
};

function HookHarness({ hookRef }: { hookRef: Ref<UseAuthFileQuotaRefreshResult> }) {
  const hook = useAuthFileQuotaRefresh();
  useImperativeHandle(hookRef, () => hook, [hook]);
  return null;
}

const mountHook = () => {
  const hookRef = createRef<UseAuthFileQuotaRefreshResult>();

  act(() => {
    create(createElement(HookHarness, { hookRef }));
  });

  return {
    getCurrent: () => {
      if (!hookRef.current) {
        throw new Error('Failed to mount useAuthFileQuotaRefresh test harness');
      }
      return hookRef.current;
    },
  };
};

describe('useAuthFileQuotaRefresh', () => {
  beforeEach(() => {
    useQuotaStore.setState({
      antigravityQuota: {},
      claudeQuota: {},
      codexQuota: {},
      kimiQuota: {},
      xaiQuota: {},
    });
    mocks.fetchCodexQuota.mockReset();
    mocks.showNotification.mockReset();
  });

  it('refreshes one credential and stores the scoped Codex result', async () => {
    mocks.fetchCodexQuota.mockResolvedValue(codexQuotaData);
    const hook = mountHook();

    await act(async () => {
      expect(await hook.getCurrent().refreshQuotaForFile(file)).toBe(true);
    });

    expect(mocks.fetchCodexQuota).toHaveBeenCalledWith(file, expect.any(Function));
    expect(useQuotaStore.getState().codexQuota['team.json::1']).toMatchObject({
      status: 'success',
      authFileKey: 'team.json::1',
    });
    expect(mocks.showNotification).toHaveBeenCalledWith(
      'auth_files.quota_refresh_success:team.json',
      'success'
    );
  });

  it('preserves prior Codex windows when refresh fails', async () => {
    useQuotaStore.setState({
      codexQuota: {
        'team.json::1': {
          status: 'success',
          windows: [{ id: 'five-hour', label: '5-hour', usedPercent: 30, resetLabel: '-' }],
          planType: 'team',
          subscriptionActiveUntil: null,
          rateLimitResetCreditsAvailableCount: 0,
          authFileKey: 'team.json::1',
          authFileName: 'team.json',
          authIndex: '1',
        },
      },
    });
    mocks.fetchCodexQuota.mockRejectedValue(new Error('refresh failed'));
    const hook = mountHook();

    await act(async () => {
      expect(await hook.getCurrent().refreshQuotaForFile(file, { notify: false })).toBe(false);
    });

    expect(useQuotaStore.getState().codexQuota['team.json::1']).toMatchObject({
      status: 'error',
      error: 'refresh failed',
      windows: [{ id: 'five-hour', usedPercent: 30 }],
    });
  });

  it('filters current-page targets before requesting quota', async () => {
    mocks.fetchCodexQuota.mockResolvedValue(codexQuotaData);
    const hook = mountHook();

    await act(async () => {
      await hook
        .getCurrent()
        .refreshQuotaForFiles([
          file,
          { name: 'disabled.json', type: 'codex', disabled: true },
          { name: 'runtime.json', type: 'codex', runtimeOnly: true },
          { name: 'unsupported.json', type: 'qwen' },
        ]);
    });

    expect(mocks.fetchCodexQuota).toHaveBeenCalledTimes(1);
    expect(mocks.fetchCodexQuota).toHaveBeenCalledWith(file, expect.any(Function));
    expect(mocks.showNotification).not.toHaveBeenCalled();
  });

  it('runs at most four current-page requests concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.fetchCodexQuota.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return codexQuotaData;
    });
    const hook = mountHook();
    const files: AuthFileItem[] = Array.from({ length: 5 }, (_, index) => ({
      name: `team-${index}.json`,
      type: 'codex',
      authIndex: index,
    }));

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = hook.getCurrent().refreshQuotaForFiles(files);
    });
    await vi.waitFor(() => expect(mocks.fetchCodexQuota).toHaveBeenCalledTimes(4));
    expect(maxActive).toBe(4);
    release();
    await act(async () => refreshPromise);

    expect(mocks.fetchCodexQuota).toHaveBeenCalledTimes(5);
    expect(maxActive).toBe(4);
  });
});
