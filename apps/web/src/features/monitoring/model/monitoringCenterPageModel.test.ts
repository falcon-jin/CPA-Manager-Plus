import type { TFunction } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchAntigravityQuota,
  fetchClaudeQuota,
  fetchCodexQuota,
  fetchXaiQuota,
} from '@/utils/quota';
import type { MonitoringAccountQuotaTarget } from '@/features/monitoring/accountOverviewQuotaTargets';
import type {
  MonitoringAccountRow,
  MonitoringApiKeyRow,
} from '@/features/monitoring/hooks/useMonitoringData';
import {
  buildAccountOptions,
  buildApiKeyOptionsFromRows,
  buildChannelOptionsFromValues,
  buildMonitoringInitialStateFromQuery,
  buildModelOptionsFromValues,
  buildProviderOptionsFromValues,
  requestAccountQuota,
} from './monitoringCenterPageModel';
import { getDefaultMonitoringCenterUiState } from '@/features/monitoring/monitoringCenterUiState';

vi.mock('@/utils/quota', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/quota')>();
  return {
    ...actual,
    fetchAntigravityQuota: vi.fn(),
    fetchClaudeQuota: vi.fn(),
    fetchCodexQuota: vi.fn(),
    fetchKimiQuota: vi.fn(),
    fetchXaiQuota: vi.fn(),
  };
});

const t = ((key: string, options?: Record<string, unknown>) => {
  const copy: Record<string, string> = {
    'antigravity_quota.title': 'Antigravity Quota',
    'claude_quota.title': 'Claude Quota',
    'claude_quota.plan_label': 'Plan',
    'claude_quota.plan_pro': 'Pro',
    'claude_quota.extra_usage_label': 'Extra Usage',
    'claude_quota.empty_windows': 'No Claude quota data',
    'claude_quota.five_hour': '5-hour limit',
    'codex_quota.title': 'Codex Quota',
    'codex_quota.empty_windows': 'No Codex quota data',
    'codex_quota.plan_label': 'Plan',
    'codex_quota.plan_free': 'Free',
    'codex_quota.monthly_window': 'Monthly limit',
    'codex_quota.window_usage_duration': '{{used}} / {{total}} used',
    'kimi_quota.title': 'Kimi Quota',
    'kimi_quota.empty_data': 'No Kimi quota data',
    'xai_quota.title': 'xAI Quota',
    'xai_quota.empty_data': 'No xAI quota data',
    'xai_quota.monthly_limit': 'Monthly billing limit',
    'xai_quota.on_demand_cap': 'On-demand cap',
    'xai_quota.usage_amount': '{{remaining}} / {{limit}} remaining',
  };
  let value = copy[key] ?? key;
  Object.entries(options ?? {}).forEach(([name, replacement]) => {
    value = value.replace(`{{${name}}}`, String(replacement));
  });
  return value;
}) as TFunction;

const createTarget = (
  overrides: Partial<MonitoringAccountQuotaTarget>
): MonitoringAccountQuotaTarget => ({
  key: overrides.key ?? 'claude::1::auth.json',
  provider: overrides.provider ?? 'claude',
  authIndex: overrides.authIndex ?? '1',
  authLabel: overrides.authLabel ?? 'Auth',
  fileName: overrides.fileName ?? 'auth.json',
  file: overrides.file ?? {
    name: overrides.fileName ?? 'auth.json',
    type: overrides.provider ?? 'claude',
    authIndex: overrides.authIndex ?? '1',
  },
  accountId: overrides.accountId ?? null,
  planType: overrides.planType ?? null,
});

const createAccountRow = (
  account: string,
  overrides: Partial<MonitoringAccountRow> = {}
): MonitoringAccountRow => ({
  id: account,
  account,
  displayAccount: account,
  accountMasked: account,
  authLabels: [],
  authIndices: [],
  channels: [],
  totalCalls: 1,
  successCalls: 1,
  failureCalls: 0,
  successRate: 1,
  inputTokens: 1,
  outputTokens: 1,
  cachedTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 2,
  totalCost: 0,
  averageLatencyMs: null,
  lastSeenAt: 1,
  recentPattern: [],
  models: [],
  ...overrides,
});

const createApiKeyRow = (apiKeyHash: string, label: string): MonitoringApiKeyRow => ({
  id: apiKeyHash,
  apiKeyHash,
  apiKeyLabel: label,
  apiKeyMasked: label,
  isUnknown: false,
  authLabels: [],
  sourceLabels: [],
  channels: [],
  totalCalls: 1,
  successCalls: 1,
  failureCalls: 0,
  successRate: 1,
  inputTokens: 1,
  outputTokens: 1,
  cachedTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  totalTokens: 2,
  totalCost: 0,
  averageLatencyMs: null,
  lastSeenAt: 1,
  models: [],
});

describe('monitoringCenterPageModel filter options', () => {
  it('maps usage analytics drilldown query into initial realtime filters', () => {
    const initialState = {
      ...getDefaultMonitoringCenterUiState(),
      searchInput: 'retained search',
    };
    const state = buildMonitoringInitialStateFromQuery(
      '?from_ms=1780000000000&to_ms=1780003600000&model=gpt-4o&api_key_hash=abcdef1234&status=failed&provider=OpenAI&auth_file=codex-auth.json&project_id=project-1&request_type=codex&search=req-42&min_latency_ms=10000&cache_status=hit',
      initialState
    );

    expect(state).toMatchObject({
      activeDataTab: 'realtime',
      timeRange: 'custom',
      selectedModel: 'gpt-4o',
      selectedApiKeyHash: 'abcdef1234',
      selectedStatus: 'failed',
      selectedProvider: 'OpenAI',
      searchInput: 'req-42',
    });
    expect(state.customStartInput).toBeTruthy();
    expect(state.customEndInput).toBeTruthy();
  });

  it('keeps alternate candidates when a dynamic filter already has a selected value', () => {
    expect(
      buildProviderOptionsFromValues(['codex', 'gemini'], 'codex', t).map((item) => item.value)
    ).toEqual(['all', 'codex', 'gemini']);
    expect(
      buildAccountOptions(
        [createAccountRow('alice@example.com'), createAccountRow('bob@example.com')],
        'alice@example.com',
        t
      ).map((item) => item.value)
    ).toEqual(['all', 'alice@example.com', 'bob@example.com']);
    expect(
      buildModelOptionsFromValues(['gpt-a', 'gpt-b'], 'gpt-a', t).map((item) => item.value)
    ).toEqual(['all', 'gpt-a', 'gpt-b']);
    expect(
      buildChannelOptionsFromValues(['Primary', 'Backup'], 'Primary', t).map((item) => item.value)
    ).toEqual(['all', 'Backup', 'Primary']);
    expect(
      buildApiKeyOptionsFromRows(
        [createApiKeyRow('key-a', 'Key A'), createApiKeyRow('key-b', 'Key B')],
        'key-a',
        t
      ).map((item) => item.value)
    ).toEqual(['all', 'key-a', 'key-b']);
  });

  it('uses account row filter values for account options', () => {
    expect(
      buildAccountOptions(
        [
          createAccountRow('OpenAI Compatible', {
            filterValue: 'auth:openai-auth',
          }),
        ],
        'auth:openai-auth',
        t
      ).map((item) => item.value)
    ).toEqual(['all', 'auth:openai-auth']);
  });
});

describe('monitoringCenterPageModel account quota', () => {
  beforeEach(() => {
    vi.mocked(fetchAntigravityQuota).mockReset();
    vi.mocked(fetchClaudeQuota).mockReset();
    vi.mocked(fetchCodexQuota).mockReset();
    vi.mocked(fetchXaiQuota).mockReset();
  });

  it('maps Claude usage windows into account quota entries', async () => {
    vi.mocked(fetchClaudeQuota).mockResolvedValue({
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          labelKey: 'claude_quota.five_hour',
          usedPercent: 40,
          resetLabel: '05/20 12:00',
        },
      ],
      planType: 'plan_pro',
      extraUsage: {
        is_enabled: true,
        used_credits: 150,
        monthly_limit: 500,
        utilization: null,
      },
    });

    const entry = await requestAccountQuota(createTarget({ provider: 'claude' }), t);

    expect(entry).toMatchObject({
      provider: 'claude',
      providerLabel: 'Claude Quota',
      metaLabels: ['Claude Quota', 'Plan: Pro', 'Extra Usage: $1.50 / $5.00'],
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          remainingPercent: 60,
          resetLabel: '05/20 12:00',
        },
      ],
    });
  });

  it('maps Codex monthly quota windows into account quota entries', async () => {
    vi.mocked(fetchCodexQuota).mockResolvedValue({
      planType: 'free',
      subscriptionActiveUntil: null,
      rateLimitResetCreditsAvailableCount: null,
      rateLimitResetCredits: [],
      rateLimitResetCreditsError: null,
      windows: [
        {
          id: 'monthly',
          label: 'Monthly limit',
          labelKey: 'codex_quota.monthly_window',
          usedPercent: 5,
          resetLabel: '06/30 12:00',
          limitWindowSeconds: 2_592_000,
        },
      ],
    });

    const entry = await requestAccountQuota(
      createTarget({
        provider: 'codex',
        authIndex: '2',
        fileName: 'codex.json',
      }),
      t
    );

    expect(entry).toMatchObject({
      provider: 'codex',
      providerLabel: 'Codex Quota',
      metaLabels: ['Codex Quota', 'Plan: Free'],
      planType: 'free',
      windows: [
        {
          id: 'monthly',
          label: 'Monthly limit',
          remainingPercent: 95,
          resetLabel: '06/30 12:00',
          usageLabel: '1.5d / 30d used',
        },
      ],
    });
  });

  it('maps Antigravity grouped buckets into account quota entries', async () => {
    vi.mocked(fetchAntigravityQuota).mockResolvedValue({
      serverTimeOffsetMs: null,
      groups: [
        {
          id: 'agent',
          label: 'Agent',
          buckets: [
            {
              id: 'daily',
              label: 'Daily',
              window: '24h',
              remainingFraction: 0.25,
              resetTime: undefined,
            },
            {
              id: 'weekly',
              label: 'Weekly',
              window: '7d',
              remainingFraction: 0.5,
              resetTime: undefined,
            },
          ],
        },
      ],
    });

    const entry = await requestAccountQuota(
      createTarget({
        provider: 'antigravity',
        authIndex: '2',
        fileName: 'antigravity.json',
      }),
      t
    );

    expect(entry.metaLabels).toEqual(['Antigravity Quota']);
    expect(entry.windows).toMatchObject([
      {
        id: 'agent',
        label: 'Agent',
        remainingPercent: 25,
        resetLabel: '-',
        usageLabel: null,
      },
    ]);
  });

  it('maps xAI billing into account quota entries', async () => {
    vi.mocked(fetchXaiQuota).mockResolvedValue({
      monthlyLimitCents: 10000,
      usedCents: 2500,
      onDemandCapCents: 5000,
      billingPeriodStart: '2026-05-01T00:00:00Z',
      billingPeriodEnd: '2026-06-01T00:00:00Z',
      usedPercent: 25,
    });

    const entry = await requestAccountQuota(
      createTarget({
        provider: 'xai',
        authIndex: '3',
        fileName: 'xai.json',
      }),
      t
    );

    expect(entry).toMatchObject({
      provider: 'xai',
      providerLabel: 'xAI Quota',
      metaLabels: ['xAI Quota', 'On-demand cap: $50.00'],
      windows: [
        {
          id: 'monthly-limit',
          label: 'Monthly billing limit',
          remainingPercent: 75,
          usageLabel: '$75.00 / $100.00 remaining',
        },
      ],
    });
  });
});
