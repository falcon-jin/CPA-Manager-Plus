import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ANTIGRAVITY_CONFIG,
  buildQuotaFailureState,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  getQuotaStoreKey,
  getScopedQuotaState,
  KIMI_CONFIG,
  type QuotaConfig,
  type QuotaStore,
  XAI_CONFIG,
} from '@/components/quota/quotaConfigs';
import { useNotificationStore, useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { getStatusFromError, isRuntimeOnlyAuthFile, resolveAuthProvider } from '@/utils/quota';

export type RefreshAuthFileQuotaOptions = { notify?: boolean };

export type UseAuthFileQuotaRefreshResult = {
  refreshQuotaForFile: (
    file: AuthFileItem,
    options?: RefreshAuthFileQuotaOptions
  ) => Promise<boolean>;
  refreshQuotaForFiles: (files: AuthFileItem[]) => Promise<void>;
  refreshingQuotaFiles: boolean;
};

type QuotaSetter<TState> = (
  updater: Record<string, TState> | ((previous: Record<string, TState>) => Record<string, TState>)
) => void;

export function useAuthFileQuotaRefresh(): UseAuthFileQuotaRefreshResult {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const inFlightRef = useRef(new Set<string>());
  const pageRefreshInFlightRef = useRef(false);
  const [refreshingQuotaFiles, setRefreshingQuotaFiles] = useState(false);

  const executeQuotaRefresh = useCallback(
    async <TState, TData>(
      config: QuotaConfig<TState, TData>,
      file: AuthFileItem,
      options: RefreshAuthFileQuotaOptions = {}
    ): Promise<boolean> => {
      const state = useQuotaStore.getState() as QuotaStore;
      const storedQuota = config.storeSelector(state);
      const previousQuota = getScopedQuotaState(config, storedQuota, file);
      const storeKey = getQuotaStoreKey(config, file);
      const requestKey = `${config.type}:${storeKey}`;

      if (isRuntimeOnlyAuthFile(file) || !config.filterFn(file)) return false;
      if ((previousQuota as { status?: string } | undefined)?.status === 'loading') return false;
      if (inFlightRef.current.has(requestKey)) return false;

      const setQuota = state[config.storeSetter] as unknown as QuotaSetter<TState>;
      inFlightRef.current.add(requestKey);

      try {
        setQuota((previous) => ({
          ...previous,
          [storeKey]: config.buildLoadingState(file),
        }));

        const data = await config.fetchQuota(file, t);
        setQuota((previous) => ({
          ...previous,
          [storeKey]: config.buildSuccessState(data, file),
        }));

        if (options.notify !== false) {
          showNotification(t('auth_files.quota_refresh_success', { name: file.name }), 'success');
        }
        return true;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : t('common.unknown_error');
        const status = getStatusFromError(error);
        setQuota((previous) => ({
          ...previous,
          [storeKey]: buildQuotaFailureState(config, message, status, file, previousQuota),
        }));

        if (options.notify !== false) {
          showNotification(
            t('auth_files.quota_refresh_failed', { name: file.name, message }),
            'error'
          );
        }
        return false;
      } finally {
        inFlightRef.current.delete(requestKey);
      }
    },
    [showNotification, t]
  );

  const refreshQuotaForFile = useCallback(
    async (file: AuthFileItem, options?: RefreshAuthFileQuotaOptions): Promise<boolean> => {
      switch (resolveAuthProvider(file)) {
        case 'antigravity':
          return executeQuotaRefresh(ANTIGRAVITY_CONFIG, file, options);
        case 'claude':
          return executeQuotaRefresh(CLAUDE_CONFIG, file, options);
        case 'codex':
          return executeQuotaRefresh(CODEX_CONFIG, file, options);
        case 'kimi':
          return executeQuotaRefresh(KIMI_CONFIG, file, options);
        case 'xai':
          return executeQuotaRefresh(XAI_CONFIG, file, options);
        default:
          return false;
      }
    },
    [executeQuotaRefresh]
  );

  const refreshQuotaForFiles = useCallback(
    async (files: AuthFileItem[]): Promise<void> => {
      if (pageRefreshInFlightRef.current) return;
      pageRefreshInFlightRef.current = true;
      setRefreshingQuotaFiles(true);

      try {
        for (let index = 0; index < files.length; index += 4) {
          const batch = files.slice(index, index + 4);
          await Promise.all(batch.map((file) => refreshQuotaForFile(file, { notify: false })));
        }
      } finally {
        pageRefreshInFlightRef.current = false;
        setRefreshingQuotaFiles(false);
      }
    },
    [refreshQuotaForFile]
  );

  return {
    refreshQuotaForFile,
    refreshQuotaForFiles,
    refreshingQuotaFiles,
  };
}
