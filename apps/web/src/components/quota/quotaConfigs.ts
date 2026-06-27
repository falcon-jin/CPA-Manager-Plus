/**
 * Quota configuration definitions.
 */

import React from 'react';
import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import type {
  AntigravityQuotaState,
  AuthFileItem,
  ClaudeExtraUsage,
  ClaudeQuotaState,
  ClaudeQuotaWindow,
  CodexQuotaState,
  CodexQuotaWindow,
  KimiQuotaRow,
  KimiQuotaState,
  XaiBillingSummary,
  XaiQuotaState,
} from '@/types';
import type { UsageHeaderSnapshot } from '@/services/api/usageService';
import type { AntigravityQuotaData, CodexQuotaData } from '@/utils/quota';
import { IconInfo } from '@/components/ui/icons';
import { resetCodexQuota } from '@/services/api/codexQuota';
import {
  normalizePlanType,
  resolveCodexChatgptAccountId,
  resolveCodexPlanType,
  formatQuotaResetTime,
  formatKimiResetHint,
  fetchAntigravityQuota,
  fetchClaudeQuota,
  fetchCodexQuota,
  fetchKimiQuota,
  fetchXaiQuota,
  buildCodexQuotaWindows,
  isAntigravityFile,
  isClaudeFile,
  isCodexFile,
  isDisabledAuthFile,
  isKimiFile,
  isXaiFile,
} from '@/utils/quota';
import {
  buildObservedCodexQuotaFromHeaderSnapshot,
  getHeaderSnapshotErrorCode,
  getHeaderSnapshotErrorKind,
  getHeaderSnapshotPlanType,
  getHeaderSnapshotRecoverAtMs,
  getHeaderSnapshotTraceId,
  getHeaderSnapshotUsedPercent,
  hasUsageHeaderQuotaSignal,
} from '@/utils/usageHeaderSnapshots';
import { normalizeAuthIndex } from '@/utils/authIndex';
import type { QuotaRenderHelpers } from './QuotaCard';
import styles from '@/features/quota/QuotaPage.module.scss';

type QuotaUpdater<T> = T | ((prev: T) => T);

type QuotaType = 'antigravity' | 'claude' | 'codex' | 'kimi' | 'xai';
export type QuotaSortMode = 'default' | 'name-asc' | 'plan-desc' | 'plan-asc';

const QUOTA_PROGRESS_HIGH_THRESHOLD = 70;
const QUOTA_PROGRESS_MEDIUM_THRESHOLD = 30;
const CODEX_INFO_WINDOW_IDS = new Set(['five-hour', 'weekly', 'monthly']);
export interface QuotaStore {
  antigravityQuota: Record<string, AntigravityQuotaState>;
  claudeQuota: Record<string, ClaudeQuotaState>;
  codexQuota: Record<string, CodexQuotaState>;
  kimiQuota: Record<string, KimiQuotaState>;
  xaiQuota: Record<string, XaiQuotaState>;
  setAntigravityQuota: (updater: QuotaUpdater<Record<string, AntigravityQuotaState>>) => void;
  setClaudeQuota: (updater: QuotaUpdater<Record<string, ClaudeQuotaState>>) => void;
  setCodexQuota: (updater: QuotaUpdater<Record<string, CodexQuotaState>>) => void;
  setKimiQuota: (updater: QuotaUpdater<Record<string, KimiQuotaState>>) => void;
  setXaiQuota: (updater: QuotaUpdater<Record<string, XaiQuotaState>>) => void;
  clearQuotaCache: () => void;
}

export interface QuotaConfig<TState, TData> {
  type: QuotaType;
  i18nPrefix: string;
  cardIdleMessageKey?: string;
  filterFn: (file: AuthFileItem) => boolean;
  fetchQuota: (file: AuthFileItem, t: TFunction) => Promise<TData>;
  storeSelector: (state: QuotaStore) => Record<string, TState>;
  storeSetter: keyof QuotaStore;
  getStoreKey?: (file: AuthFileItem) => string;
  buildLoadingState: (file?: AuthFileItem) => TState;
  buildSuccessState: (data: TData, file?: AuthFileItem) => TState;
  buildErrorState: (message: string, status?: number, file?: AuthFileItem) => TState;
  scopeState?: (file: AuthFileItem, state: TState | undefined) => TState | undefined;
  cardClassName: string;
  controlsClassName: string;
  controlClassName: string;
  gridClassName: string;
  getSearchText?: (file: AuthFileItem, quota: TState | undefined, t: TFunction) => unknown[];
  getPlanSortRank?: (file: AuthFileItem, quota: TState | undefined) => number | null;
  buildObservedState?: (
    file: AuthFileItem,
    snapshot: UsageHeaderSnapshot | undefined,
    t: TFunction
  ) => TState | undefined;
  resetQuota?: (file: AuthFileItem, t: TFunction) => Promise<TData>;
  canResetQuota?: (file: AuthFileItem, quota: TState | undefined) => boolean;
  renderQuotaItems: (quota: TState, t: TFunction, helpers: QuotaRenderHelpers) => ReactNode;
}

export const getQuotaStoreKey = <TState, TData>(
  config: Pick<QuotaConfig<TState, TData>, 'getStoreKey'>,
  file: AuthFileItem
): string => config.getStoreKey?.(file) ?? file.name;

const renderAntigravityItems = (
  quota: AntigravityQuotaState,
  t: TFunction,
  helpers: QuotaRenderHelpers
): ReactNode => {
  const { styles: styleMap, QuotaProgressBar } = helpers;
  const { createElement: h, Fragment } = React;
  const groups = quota.groups ?? [];

  if (groups.length === 0) {
    return h('div', { className: styleMap.quotaMessage }, t('antigravity_quota.empty_models'));
  }

  const nowMs = Date.now() + (quota.serverTimeOffsetMs ?? 0);

  return h(
    Fragment,
    null,
    ...groups.flatMap((group) => {
      const shouldRenderGroupHeader = group.buckets.length > 1 || Boolean(group.description);
      const groupHeader = shouldRenderGroupHeader
        ? [
            h(
              'div',
              { key: `${group.id}-header`, className: styleMap.quotaMessage },
              group.description
                ? h('span', { title: group.description }, group.label)
                : h('span', null, group.label)
            ),
          ]
        : [];

      return [
        ...groupHeader,
        ...group.buckets.map((bucket) => {
          const clamped = Math.max(0, Math.min(1, bucket.remainingFraction));
          const percent = Math.round(clamped * 100);
          const resetMs = bucket.resetTime ? new Date(bucket.resetTime).getTime() : Number.NaN;
          const resetLabel =
            bucket.resetTime && !Number.isNaN(resetMs) && resetMs <= nowMs
              ? t('antigravity_quota.refresh_available')
              : formatQuotaResetTime(bucket.resetTime);

          return h(
            'div',
            { key: `${group.id}-${bucket.id}`, className: styleMap.quotaRow },
            h(
              'div',
              { className: styleMap.quotaRowHeader },
              h(
                'span',
                { className: styleMap.quotaModel, title: bucket.description },
                bucket.label
              ),
              h(
                'div',
                { className: styleMap.quotaMeta },
                h('span', { className: styleMap.quotaPercent }, `${percent}%`),
                h('span', { className: styleMap.quotaReset }, resetLabel)
              )
            ),
            h(QuotaProgressBar, {
              percent,
              highThreshold: QUOTA_PROGRESS_HIGH_THRESHOLD,
              mediumThreshold: QUOTA_PROGRESS_MEDIUM_THRESHOLD,
            })
          );
        }),
      ];
    })
  );
};

const PREMIUM_CODEX_PLAN_TYPES = new Set(['pro', 'prolite', 'pro-lite', 'pro_lite']);

const getCodexPlanLabel = (planType: string | null | undefined, t: TFunction): string | null => {
  const normalized = normalizePlanType(planType);
  if (!normalized) return null;
  if (normalized === 'pro') return t('codex_quota.plan_pro');
  if (PREMIUM_CODEX_PLAN_TYPES.has(normalized) && normalized !== 'pro') {
    return t('codex_quota.plan_prolite');
  }
  if (normalized === 'plus') return t('codex_quota.plan_plus');
  if (normalized === 'team') return t('codex_quota.plan_team');
  if (normalized === 'free') return t('codex_quota.plan_free');
  return planType || normalized;
};

const getCodexEffectivePlanType = (file: AuthFileItem, quota?: CodexQuotaState): string | null =>
  resolveCodexPlanType(file) ?? quota?.planType ?? null;

const getCodexPlanSortRank = (file: AuthFileItem, quota?: CodexQuotaState): number | null => {
  const normalized = normalizePlanType(getCodexEffectivePlanType(file, quota));
  if (!normalized) return null;
  if (normalized === 'pro') return 50;
  if (PREMIUM_CODEX_PLAN_TYPES.has(normalized) && normalized !== 'pro') return 40;
  if (normalized === 'team') return 30;
  if (normalized === 'plus') return 20;
  if (normalized === 'free') return 10;
  return 0;
};

const getCodexSearchText = (
  file: AuthFileItem,
  quota: CodexQuotaState | undefined,
  t: TFunction
): unknown[] => {
  const planType = getCodexEffectivePlanType(file, quota);
  const planLabel = getCodexPlanLabel(planType, t);
  const accountId = resolveCodexChatgptAccountId(file);
  return [
    planType,
    planLabel,
    accountId,
    quota?.observedErrorKind,
    quota?.observedErrorCode,
    quota?.observedTraceId,
    quota?.activeLimit,
    quota?.creditsHasCredits,
    quota?.creditsUnlimited,
    quota?.creditsBalance,
    quota?.rateLimitReachedType,
    quota?.primaryOverSecondaryLimitPercent,
    quota?.observedAtMs,
  ];
};

type DisplayQuotaState = {
  status?: 'idle' | 'loading' | 'success' | 'error';
  errorStatus?: number | null;
  fetchedAtMs?: number;
  observedAtMs?: number;
};

const readFiniteTimestamp = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const buildCodexQuotaAuthIdentity = (file: AuthFileItem | undefined) => {
  if (!file?.name) return {};
  const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex ?? file['auth-index']);
  return {
    authFileKey: `${file.name}::${authIndex ?? '-'}`,
    authFileName: file.name,
    authIndex,
  };
};

export const getCodexQuotaStoreKey = (file: AuthFileItem): string =>
  buildCodexQuotaAuthIdentity(file).authFileKey ?? file.name;

const scopeCodexQuotaStateToAuthFile = (
  file: AuthFileItem,
  state: CodexQuotaState | undefined
): CodexQuotaState | undefined => {
  if (!state) return undefined;
  const identity = buildCodexQuotaAuthIdentity(file);
  if (!state.authFileKey) return identity.authIndex === null ? state : undefined;
  return state.authFileKey === identity.authFileKey ? state : undefined;
};

export const resolveQuotaDisplayState = <TState extends DisplayQuotaState>(
  activeQuota: TState | undefined,
  observedQuota: TState | undefined
): TState | undefined => {
  if (activeQuota && activeQuota.status !== 'idle' && activeQuota.status !== 'error') {
    if (activeQuota.status === 'success' && observedQuota?.status === 'success') {
      const fetchedAtMs = readFiniteTimestamp(activeQuota.fetchedAtMs);
      const observedAtMs = readFiniteTimestamp(observedQuota.observedAtMs);
      if (fetchedAtMs !== null && observedAtMs !== null && observedAtMs > fetchedAtMs) {
        return observedQuota;
      }
    }
    return activeQuota;
  }

  if (activeQuota?.status === 'error' && activeQuota.errorStatus === 401) {
    return activeQuota;
  }

  return observedQuota ?? activeQuota;
};

export const buildObservedCodexQuotaState = (
  file: AuthFileItem,
  snapshot: UsageHeaderSnapshot | undefined,
  t: TFunction
): CodexQuotaState | undefined => {
  if (!hasUsageHeaderQuotaSignal(snapshot)) return undefined;
  const observedQuota = buildObservedCodexQuotaFromHeaderSnapshot(snapshot);
  const usedPercent = getHeaderSnapshotUsedPercent(snapshot);
  const recoverAtMS = getHeaderSnapshotRecoverAtMs(snapshot);
  const recoverLabel = recoverAtMS ? new Date(recoverAtMS).toLocaleString() : '-';
  const headerPlanType = observedQuota?.planType || getHeaderSnapshotPlanType(snapshot);
  const planType = resolveCodexPlanType(file) ?? (headerPlanType || null);
  const observedWindows = observedQuota?.payload
    ? buildCodexQuotaWindows(observedQuota.payload, t, planType)
    : [];
  const windows: CodexQuotaWindow[] =
    observedWindows.length > 0
      ? observedWindows
      : usedPercent !== null || recoverAtMS
        ? [
            {
              id: 'usage-header-observed',
              label: t('codex_quota.observed_window', {
                defaultValue: 'Latest request',
              }),
              usedPercent,
              resetLabel: recoverLabel,
            },
          ]
        : [];

  return {
    status: 'success',
    windows,
    planType,
    activeLimit: observedQuota?.activeLimit ?? null,
    creditsHasCredits: observedQuota?.creditsHasCredits ?? null,
    creditsUnlimited: observedQuota?.creditsUnlimited ?? null,
    creditsBalance: observedQuota?.creditsBalance ?? null,
    rateLimitReachedType: observedQuota?.rateLimitReachedType ?? null,
    primaryOverSecondaryLimitPercent: observedQuota?.primaryOverSecondaryLimitPercent ?? null,
    observedFromUsageHeaders: true,
    observedResetCreditsUnknown: true,
    observedAtMs: snapshot?.timestamp_ms,
    observedTraceId: getHeaderSnapshotTraceId(snapshot),
    observedErrorKind: getHeaderSnapshotErrorKind(snapshot),
    observedErrorCode: getHeaderSnapshotErrorCode(snapshot),
  };
};

type CodexQuotaTooltipRow = {
  key: string;
  label: string;
  value: string;
};

const formatCodexTooltipPercent = (value: number | null): string | null =>
  value === null ? null : `${Math.round(value)}%`;

const buildCodexWindowTooltipRows = (
  quota: CodexQuotaState,
  window: CodexQuotaWindow,
  windowLabel: string,
  usedPercent: number | null,
  remainingPercent: number | null,
  t: TFunction
): CodexQuotaTooltipRow[] => {
  const rows: CodexQuotaTooltipRow[] = [];
  const usedLabel = formatCodexTooltipPercent(usedPercent);
  const remainingLabel = formatCodexTooltipPercent(remainingPercent);

  if (quota.observedFromUsageHeaders) {
    rows.push({
      key: 'source',
      label: t('codex_quota.tooltip_source_label'),
      value: t('codex_quota.tooltip_source_header'),
    });

    if (quota.observedAtMs && Number.isFinite(quota.observedAtMs)) {
      rows.push({
        key: 'recorded-at',
        label: t('codex_quota.tooltip_recorded_at_label'),
        value: new Date(quota.observedAtMs).toLocaleString(),
      });
    }
  } else {
    rows.push({
      key: 'source',
      label: t('codex_quota.tooltip_source_label'),
      value: t('codex_quota.tooltip_source_api'),
    });

    if (quota.fetchedAtMs && Number.isFinite(quota.fetchedAtMs)) {
      rows.push({
        key: 'fetched-at',
        label: t('codex_quota.tooltip_fetched_at_label'),
        value: new Date(quota.fetchedAtMs).toLocaleString(),
      });
    }
  }

  if (usedLabel) {
    rows.push({
      key: 'used',
      label: t('codex_quota.tooltip_used_label'),
      value: usedLabel,
    });
  }

  if (remainingLabel) {
    rows.push({
      key: 'remaining',
      label: t('codex_quota.tooltip_remaining_label'),
      value: remainingLabel,
    });
  }

  if (window.resetLabel && window.resetLabel !== '-') {
    rows.push({
      key: 'reset',
      label: t('codex_quota.tooltip_reset_label'),
      value: window.resetLabel,
    });
  }

  return rows.length > 0
    ? rows
    : [
        {
          key: 'window',
          label: t('codex_quota.tooltip_window_label'),
          value: windowLabel,
        },
      ];
};

const renderCodexWindowInfo = (
  quota: CodexQuotaState,
  window: CodexQuotaWindow,
  windowLabel: string,
  usedPercent: number | null,
  remainingPercent: number | null,
  t: TFunction,
  styleMap: QuotaRenderHelpers['styles']
): ReactNode => {
  if (!CODEX_INFO_WINDOW_IDS.has(window.id)) return null;

  const { createElement: h } = React;
  const rows = buildCodexWindowTooltipRows(
    quota,
    window,
    windowLabel,
    usedPercent,
    remainingPercent,
    t
  );

  return h(
    'span',
    {
      className: styleMap.quotaInfoTrigger,
      tabIndex: 0,
      'aria-label': t('codex_quota.tooltip_label', { label: windowLabel }),
    },
    h(IconInfo, {
      key: 'icon',
      size: 14,
      className: styleMap.quotaInfoIcon,
      'aria-hidden': true,
      focusable: false,
    }),
    h(
      'span',
      { key: 'tooltip', className: styleMap.quotaInfoTooltip, role: 'tooltip' },
      ...rows.map((row) =>
        h(
          'span',
          { key: row.key, className: styleMap.quotaInfoTooltipRow },
          h('span', { className: styleMap.quotaInfoTooltipLabel }, row.label),
          h('span', { className: styleMap.quotaInfoTooltipValue }, row.value)
        )
      )
    )
  );
};

const renderCodexItems = (
  quota: CodexQuotaState,
  t: TFunction,
  helpers: QuotaRenderHelpers
): ReactNode => {
  const { styles: styleMap, QuotaProgressBar } = helpers;
  const { createElement: h, Fragment } = React;
  const windows = quota.windows ?? [];
  const planType = quota.planType ?? null;
  const planLabel = getCodexPlanLabel(planType, t);
  const isPremiumPlan = PREMIUM_CODEX_PLAN_TYPES.has(normalizePlanType(planType) ?? '');
  const resetCreditsAvailableCount = quota.rateLimitResetCreditsAvailableCount;
  const hasResetCreditsAvailableCount =
    typeof resetCreditsAvailableCount === 'number' && Number.isFinite(resetCreditsAvailableCount);
  const nodes: ReactNode[] = [];

  if (planLabel || hasResetCreditsAvailableCount || quota.observedResetCreditsUnknown) {
    const valueClass = isPremiumPlan ? styleMap.premiumPlanValue : styleMap.codexPlanValue;
    const planNodes: ReactNode[] = [];

    if (planLabel) {
      planNodes.push(
        h(
          'span',
          { key: 'plan-label', className: styleMap.codexPlanLabel },
          t('codex_quota.plan_label')
        ),
        h('span', { key: 'plan-value', className: valueClass }, planLabel)
      );
    }

    if (hasResetCreditsAvailableCount || quota.observedResetCreditsUnknown) {
      if (planNodes.length > 0) {
        planNodes.push(
          h('span', { key: 'reset-separator', className: styleMap.codexPlanLabel }, '|')
        );
      }
      planNodes.push(
        h(
          'span',
          { key: 'reset-label', className: styleMap.codexPlanLabel },
          t('codex_quota.reset_credits_label')
        ),
        h(
          'span',
          { key: 'reset-value', className: styleMap.codexPlanValue },
          hasResetCreditsAvailableCount
            ? String(resetCreditsAvailableCount)
            : t('codex_quota.reset_credits_unknown')
        )
      );
    }

    nodes.push(h('div', { key: 'plan', className: styleMap.codexPlan }, ...planNodes));
  }

  if (windows.length === 0) {
    nodes.push(
      h('div', { key: 'empty', className: styleMap.quotaMessage }, t('codex_quota.empty_windows'))
    );
    return h(Fragment, null, ...nodes);
  }

  nodes.push(
    ...windows.map((window) => {
      const used = window.usedPercent;
      const clampedUsed = used === null ? null : Math.max(0, Math.min(100, used));
      const remaining = clampedUsed === null ? null : Math.max(0, Math.min(100, 100 - clampedUsed));
      const percentLabel = remaining === null ? '--' : `${Math.round(remaining)}%`;
      const windowLabel = window.labelKey
        ? t(window.labelKey, window.labelParams as Record<string, string | number>)
        : window.label;
      const infoIcon = renderCodexWindowInfo(
        quota,
        window,
        windowLabel,
        clampedUsed,
        remaining,
        t,
        styleMap
      );

      return h(
        'div',
        { key: window.id, className: styleMap.quotaRow },
        h(
          'div',
          { className: styleMap.quotaRowHeader },
          h(
            'span',
            { className: styleMap.quotaWindowLabel },
            h('span', { className: styleMap.quotaModel }, windowLabel),
            infoIcon
          ),
          h(
            'div',
            { className: styleMap.quotaMeta },
            h('span', { className: styleMap.quotaPercent }, percentLabel),
            h('span', { className: styleMap.quotaReset }, window.resetLabel)
          )
        ),
        h(QuotaProgressBar, {
          percent: remaining,
          highThreshold: QUOTA_PROGRESS_HIGH_THRESHOLD,
          mediumThreshold: QUOTA_PROGRESS_MEDIUM_THRESHOLD,
        })
      );
    })
  );

  return h(Fragment, null, ...nodes);
};

const renderClaudeItems = (
  quota: ClaudeQuotaState,
  t: TFunction,
  helpers: QuotaRenderHelpers
): ReactNode => {
  const { styles: styleMap, QuotaProgressBar } = helpers;
  const { createElement: h, Fragment } = React;
  const windows = quota.windows ?? [];
  const extraUsage = quota.extraUsage ?? null;
  const planType = quota.planType ?? null;
  const nodes: ReactNode[] = [];

  if (planType) {
    nodes.push(
      h(
        'div',
        { key: 'plan', className: styleMap.codexPlan },
        h('span', { className: styleMap.codexPlanLabel }, t('claude_quota.plan_label')),
        h('span', { className: styleMap.codexPlanValue }, t(`claude_quota.${planType}`))
      )
    );
  }

  if (extraUsage && extraUsage.is_enabled) {
    const usedLabel = `$${(extraUsage.used_credits / 100).toFixed(2)} / $${(extraUsage.monthly_limit / 100).toFixed(2)}`;
    nodes.push(
      h(
        'div',
        { key: 'extra', className: styleMap.codexPlan },
        h('span', { className: styleMap.codexPlanLabel }, t('claude_quota.extra_usage_label')),
        h('span', { className: styleMap.codexPlanValue }, usedLabel)
      )
    );
  }

  if (windows.length === 0) {
    nodes.push(
      h('div', { key: 'empty', className: styleMap.quotaMessage }, t('claude_quota.empty_windows'))
    );
    return h(Fragment, null, ...nodes);
  }

  nodes.push(
    ...windows.map((window) => {
      const used = window.usedPercent;
      const clampedUsed = used === null ? null : Math.max(0, Math.min(100, used));
      const remaining = clampedUsed === null ? null : Math.max(0, Math.min(100, 100 - clampedUsed));
      const percentLabel = remaining === null ? '--' : `${Math.round(remaining)}%`;
      const windowLabel = window.labelKey ? t(window.labelKey) : window.label;

      return h(
        'div',
        { key: window.id, className: styleMap.quotaRow },
        h(
          'div',
          { className: styleMap.quotaRowHeader },
          h('span', { className: styleMap.quotaModel }, windowLabel),
          h(
            'div',
            { className: styleMap.quotaMeta },
            h('span', { className: styleMap.quotaPercent }, percentLabel),
            h('span', { className: styleMap.quotaReset }, window.resetLabel)
          )
        ),
        h(QuotaProgressBar, {
          percent: remaining,
          highThreshold: QUOTA_PROGRESS_HIGH_THRESHOLD,
          mediumThreshold: QUOTA_PROGRESS_MEDIUM_THRESHOLD,
        })
      );
    })
  );

  return h(Fragment, null, ...nodes);
};

export const CLAUDE_CONFIG: QuotaConfig<
  ClaudeQuotaState,
  { windows: ClaudeQuotaWindow[]; extraUsage?: ClaudeExtraUsage | null; planType?: string | null }
> = {
  type: 'claude',
  i18nPrefix: 'claude_quota',
  cardIdleMessageKey: 'quota_management.card_idle_hint',
  filterFn: (file) => isClaudeFile(file) && !isDisabledAuthFile(file),
  fetchQuota: fetchClaudeQuota,
  storeSelector: (state) => state.claudeQuota,
  storeSetter: 'setClaudeQuota',
  buildLoadingState: () => ({ status: 'loading', windows: [] }),
  buildSuccessState: (data) => ({
    status: 'success',
    windows: data.windows,
    extraUsage: data.extraUsage,
    planType: data.planType,
  }),
  buildErrorState: (message, status) => ({
    status: 'error',
    windows: [],
    error: message,
    errorStatus: status,
  }),
  cardClassName: styles.claudeCard,
  controlsClassName: styles.claudeControls,
  controlClassName: styles.claudeControl,
  gridClassName: styles.claudeGrid,
  renderQuotaItems: renderClaudeItems,
};

export const ANTIGRAVITY_CONFIG: QuotaConfig<AntigravityQuotaState, AntigravityQuotaData> = {
  type: 'antigravity',
  i18nPrefix: 'antigravity_quota',
  cardIdleMessageKey: 'quota_management.card_idle_hint',
  filterFn: (file) => isAntigravityFile(file) && !isDisabledAuthFile(file),
  fetchQuota: fetchAntigravityQuota,
  storeSelector: (state) => state.antigravityQuota,
  storeSetter: 'setAntigravityQuota',
  buildLoadingState: () => ({ status: 'loading', groups: [], serverTimeOffsetMs: null }),
  buildSuccessState: (data) => ({
    status: 'success',
    groups: data.groups,
    serverTimeOffsetMs: data.serverTimeOffsetMs,
  }),
  buildErrorState: (message, status) => ({
    status: 'error',
    groups: [],
    serverTimeOffsetMs: null,
    error: message,
    errorStatus: status,
  }),
  cardClassName: styles.antigravityCard,
  controlsClassName: styles.antigravityControls,
  controlClassName: styles.antigravityControl,
  gridClassName: styles.antigravityGrid,
  renderQuotaItems: renderAntigravityItems,
};

export const CODEX_CONFIG: QuotaConfig<
  CodexQuotaState,
  CodexQuotaData
> = {
  type: 'codex',
  i18nPrefix: 'codex_quota',
  cardIdleMessageKey: 'quota_management.card_idle_hint',
  filterFn: (file) => isCodexFile(file) && !isDisabledAuthFile(file),
  fetchQuota: fetchCodexQuota,
  storeSelector: (state) => state.codexQuota,
  storeSetter: 'setCodexQuota',
  getStoreKey: getCodexQuotaStoreKey,
  buildLoadingState: (file) => ({
    status: 'loading',
    windows: [],
    ...buildCodexQuotaAuthIdentity(file),
  }),
  buildSuccessState: (data, file) => ({
    status: 'success',
    windows: data.windows,
    planType: data.planType,
    subscriptionActiveUntil: data.subscriptionActiveUntil,
    rateLimitResetCreditsAvailableCount: data.rateLimitResetCreditsAvailableCount,
    rateLimitResetCredits: data.rateLimitResetCredits,
    rateLimitResetCreditsError: data.rateLimitResetCreditsError,
    ...buildCodexQuotaAuthIdentity(file),
    fetchedAtMs: Date.now(),
  }),
  buildErrorState: (message, status, file) => ({
    status: 'error',
    windows: [],
    error: message,
    errorStatus: status,
    ...buildCodexQuotaAuthIdentity(file),
  }),
  scopeState: scopeCodexQuotaStateToAuthFile,
  cardClassName: styles.codexCard,
  controlsClassName: styles.codexControls,
  controlClassName: styles.codexControl,
  gridClassName: styles.codexGrid,
  getSearchText: getCodexSearchText,
  getPlanSortRank: getCodexPlanSortRank,
  buildObservedState: buildObservedCodexQuotaState,
  resetQuota: resetCodexQuota,
  canResetQuota: (_file, quota) =>
    quota?.status === 'success' && (quota.rateLimitResetCreditsAvailableCount ?? 0) > 0,
  renderQuotaItems: renderCodexItems,
};

const renderKimiItems = (
  quota: KimiQuotaState,
  t: TFunction,
  helpers: QuotaRenderHelpers
): ReactNode => {
  const { styles: styleMap, QuotaProgressBar } = helpers;
  const { createElement: h } = React;
  const rows = quota.rows ?? [];

  if (rows.length === 0) {
    return h('div', { className: styleMap.quotaMessage }, t('kimi_quota.empty_data'));
  }

  return rows.map((row) => {
    const limit = row.limit;
    const used = row.used;
    const remaining =
      limit > 0
        ? Math.max(0, Math.min(100, Math.round(((limit - used) / limit) * 100)))
        : used > 0
          ? 0
          : null;
    const percentLabel = remaining === null ? '--' : `${remaining}%`;
    const rowLabel = row.labelKey
      ? t(row.labelKey, (row.labelParams ?? {}) as Record<string, string | number>)
      : (row.label ?? '');
    const resetLabel = formatKimiResetHint(t, row.resetHint);

    return h(
      'div',
      { key: row.id, className: styleMap.quotaRow },
      h(
        'div',
        { className: styleMap.quotaRowHeader },
        h('span', { className: styleMap.quotaModel }, rowLabel),
        h(
          'div',
          { className: styleMap.quotaMeta },
          h('span', { className: styleMap.quotaPercent }, percentLabel),
          limit > 0 ? h('span', { className: styleMap.quotaAmount }, `${used} / ${limit}`) : null,
          resetLabel ? h('span', { className: styleMap.quotaReset }, resetLabel) : null
        )
      ),
      h(QuotaProgressBar, {
        percent: remaining,
        highThreshold: QUOTA_PROGRESS_HIGH_THRESHOLD,
        mediumThreshold: QUOTA_PROGRESS_MEDIUM_THRESHOLD,
      })
    );
  });
};

export const KIMI_CONFIG: QuotaConfig<KimiQuotaState, KimiQuotaRow[]> = {
  type: 'kimi',
  i18nPrefix: 'kimi_quota',
  cardIdleMessageKey: 'quota_management.card_idle_hint',
  filterFn: (file) => isKimiFile(file) && !isDisabledAuthFile(file),
  fetchQuota: fetchKimiQuota,
  storeSelector: (state) => state.kimiQuota,
  storeSetter: 'setKimiQuota',
  buildLoadingState: () => ({ status: 'loading', rows: [] }),
  buildSuccessState: (rows) => ({ status: 'success', rows }),
  buildErrorState: (message, status) => ({
    status: 'error',
    rows: [],
    error: message,
    errorStatus: status,
  }),
  cardClassName: styles.kimiCard,
  controlsClassName: styles.kimiControls,
  controlClassName: styles.kimiControl,
  gridClassName: styles.kimiGrid,
  renderQuotaItems: renderKimiItems,
};

const formatXaiCurrency = (value: number | null): string => {
  if (value === null) return '--';
  return `$${(value / 100).toFixed(2)}`;
};

const XAI_SUPERGROK_LIMIT_CENTS = 15_000;
const XAI_SUPERGROK_HEAVY_LIMIT_CENTS = 150_000;

const resolveXaiPlan = (
  monthlyLimitCents: number | null
): { labelKey: string; premium: boolean } | null => {
  if (monthlyLimitCents === XAI_SUPERGROK_LIMIT_CENTS) {
    return { labelKey: 'plan_supergrok', premium: false };
  }
  if (monthlyLimitCents === XAI_SUPERGROK_HEAVY_LIMIT_CENTS) {
    return { labelKey: 'plan_supergrok_heavy', premium: true };
  }
  return null;
};

const renderXaiItems = (
  quota: XaiQuotaState,
  t: TFunction,
  helpers: QuotaRenderHelpers
): ReactNode => {
  const { styles: styleMap, QuotaProgressBar } = helpers;
  const { createElement: h } = React;
  const billing = quota.billing;

  if (!billing) {
    return h('div', { className: styleMap.quotaMessage }, t('xai_quota.empty_data'));
  }

  const usedPercent = billing.usedPercent;
  const clampedUsed = usedPercent === null ? null : Math.max(0, Math.min(100, usedPercent));
  const remaining = clampedUsed === null ? null : Math.max(0, Math.min(100, 100 - clampedUsed));
  const percentLabel = remaining === null ? '--' : `${Math.round(remaining)}%`;
  const remainingCents =
    billing.monthlyLimitCents !== null && billing.usedCents !== null
      ? Math.max(0, billing.monthlyLimitCents - billing.usedCents)
      : null;
  const amountLabel = t('xai_quota.usage_amount', {
    remaining: formatXaiCurrency(remainingCents),
    limit: formatXaiCurrency(billing.monthlyLimitCents),
  });
  const resetLabel = billing.billingPeriodEnd
    ? formatQuotaResetTime(billing.billingPeriodEnd)
    : t('xai_quota.reset_unknown');
  const plan = resolveXaiPlan(billing.monthlyLimitCents);

  const nodes: ReactNode[] = [
    plan
      ? h(
          'div',
          { key: 'plan', className: styleMap.codexPlan },
          h('span', { className: styleMap.codexPlanLabel }, t('xai_quota.plan_label')),
          h(
            'span',
            { className: plan.premium ? styleMap.premiumPlanValue : styleMap.codexPlanValue },
            t(`xai_quota.${plan.labelKey}`)
          )
        )
      : null,
    h(
      'div',
      { key: 'billing', className: styleMap.quotaRow },
      h(
        'div',
        { className: styleMap.quotaRowHeader },
        h('span', { className: styleMap.quotaModel }, t('xai_quota.monthly_limit')),
        h(
          'div',
          { className: styleMap.quotaMeta },
          h('span', { className: styleMap.quotaPercent }, percentLabel),
          h('span', { className: styleMap.quotaAmount }, amountLabel),
          h('span', { className: styleMap.quotaReset }, resetLabel)
        )
      ),
      h(QuotaProgressBar, {
        percent: remaining,
        highThreshold: QUOTA_PROGRESS_HIGH_THRESHOLD,
        mediumThreshold: QUOTA_PROGRESS_MEDIUM_THRESHOLD,
      })
    ),
  ];

  if (billing.onDemandCapCents !== null) {
    nodes.push(
      h(
        'div',
        { key: 'on-demand-cap', className: styleMap.codexPlan },
        h('span', { className: styleMap.codexPlanLabel }, t('xai_quota.on_demand_cap')),
        h(
          'span',
          { className: styleMap.codexPlanValue },
          formatXaiCurrency(billing.onDemandCapCents)
        )
      )
    );
  }

  return h(React.Fragment, null, ...nodes);
};

export const XAI_CONFIG: QuotaConfig<XaiQuotaState, XaiBillingSummary> = {
  type: 'xai',
  i18nPrefix: 'xai_quota',
  cardIdleMessageKey: 'quota_management.card_idle_hint',
  filterFn: (file) => isXaiFile(file) && !isDisabledAuthFile(file),
  fetchQuota: fetchXaiQuota,
  storeSelector: (state) => state.xaiQuota,
  storeSetter: 'setXaiQuota',
  buildLoadingState: () => ({ status: 'loading', billing: null }),
  buildSuccessState: (billing) => ({ status: 'success', billing }),
  buildErrorState: (message, status) => ({
    status: 'error',
    billing: null,
    error: message,
    errorStatus: status,
  }),
  cardClassName: styles.kimiCard,
  controlsClassName: styles.kimiControls,
  controlClassName: styles.kimiControl,
  gridClassName: styles.kimiGrid,
  renderQuotaItems: renderXaiItems,
};
