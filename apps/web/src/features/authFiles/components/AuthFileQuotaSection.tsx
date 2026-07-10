import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  getQuotaStoreKey,
  KIMI_CONFIG,
  XAI_CONFIG,
} from '@/components/quota';
import { IconRefreshCw } from '@/components/ui/icons';
import { useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { resolveQuotaErrorMessage, type QuotaProviderType } from '@/features/authFiles/constants';
import { QuotaProgressBar } from '@/features/authFiles/components/QuotaProgressBar';
import styles from '@/features/authFiles/AuthFilesPage.module.scss';

type QuotaState = { status?: string; error?: string; errorStatus?: number } | undefined;
type InlineQuotaConfig = {
  i18nPrefix: string;
  getStoreKey?: (file: AuthFileItem) => string;
  renderQuotaItems: (quota: unknown, t: TFunction, helpers: unknown) => unknown;
  scopeState?: (file: AuthFileItem, state: QuotaState) => QuotaState;
};

const getQuotaConfig = (type: QuotaProviderType) => {
  if (type === 'antigravity') return ANTIGRAVITY_CONFIG;
  if (type === 'claude') return CLAUDE_CONFIG;
  if (type === 'codex') return CODEX_CONFIG;
  if (type === 'kimi') return KIMI_CONFIG;
  return XAI_CONFIG;
};

export type AuthFileQuotaSectionProps = {
  file: AuthFileItem;
  quotaType: QuotaProviderType;
  disableControls: boolean;
  quotaOverride?: QuotaState | null;
  onRefreshQuota: (file: AuthFileItem) => void | Promise<unknown>;
};

export function AuthFileQuotaSection(props: AuthFileQuotaSectionProps) {
  const { file, quotaType, disableControls, quotaOverride, onRefreshQuota } = props;
  const { t } = useTranslation();
  const config = getQuotaConfig(quotaType) as unknown as InlineQuotaConfig;
  const storeKey = getQuotaStoreKey(config, file);

  const storedQuota = useQuotaStore((state) => {
    if (quotaType === 'antigravity') return state.antigravityQuota[storeKey] as QuotaState;
    if (quotaType === 'claude') return state.claudeQuota[storeKey] as QuotaState;
    if (quotaType === 'codex') {
      return (state.codexQuota[storeKey] ?? state.codexQuota[file.name]) as QuotaState;
    }
    if (quotaType === 'kimi') return state.kimiQuota[storeKey] as QuotaState;
    return state.xaiQuota[storeKey] as QuotaState;
  });
  const quota = config.scopeState ? config.scopeState(file, storedQuota) : storedQuota;

  const displayQuota = quotaOverride === undefined ? quota : (quotaOverride ?? undefined);
  const quotaStatus = displayQuota?.status ?? 'idle';
  const canRefreshQuota = !disableControls && !file.disabled;
  const quotaErrorMessage = resolveQuotaErrorMessage(
    t,
    displayQuota?.errorStatus,
    displayQuota?.error || t('common.unknown_error')
  );

  return (
    <div className={styles.quotaSection}>
      <div className={styles.quotaSectionHeader}>
        <button
          type="button"
          className={styles.quotaRefreshButton}
          onClick={() => void onRefreshQuota(file)}
          disabled={!canRefreshQuota || quotaStatus === 'loading'}
          title={t('auth_files.quota_refresh_hint')}
          aria-label={t('auth_files.quota_refresh_hint')}
        >
          <IconRefreshCw size={13} aria-hidden="true" />
          {t('auth_files.quota_refresh_single')}
        </button>
      </div>
      {quotaStatus === 'loading' ? (
        <div className={styles.quotaMessage}>{t(`${config.i18nPrefix}.loading`)}</div>
      ) : quotaStatus === 'idle' ? (
        <div className={styles.quotaMessage}>{t(`${config.i18nPrefix}.idle`)}</div>
      ) : quotaStatus === 'error' ? (
        <div className={styles.quotaError}>
          {t(`${config.i18nPrefix}.load_failed`, {
            message: quotaErrorMessage,
          })}
        </div>
      ) : displayQuota ? (
        (config.renderQuotaItems(displayQuota, t, { styles, QuotaProgressBar }) as ReactNode)
      ) : (
        <div className={styles.quotaMessage}>{t(`${config.i18nPrefix}.idle`)}</div>
      )}
    </div>
  );
}
