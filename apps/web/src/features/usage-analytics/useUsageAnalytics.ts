import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMonitoringAnalytics } from '@/features/monitoring/hooks/useMonitoringAnalytics';
import {
  adaptUsageAnalyticsData,
  analyzeUsageBucket,
  buildSelectedApiKeyTrendSeries,
  buildSelectedCredentialTrendSeries,
  buildCredentialQuotaRows,
  buildEntityTrendSeries,
  buildKeyAnomalies,
  buildUsageInsights,
  buildUsageHeatmap,
  buildUsageHeatmapCellDetail,
  buildUsageHeatmapCellDateOptions,
  buildUsageHeatmapHighlights,
  buildUsageHeatmapRangeContext,
  buildUsageMatrix,
  buildUsageSummaryDelta,
  buildUsageAnalyticsFilters,
  buildUsageAnalyticsInclude,
  buildUsageTimeline,
  getUsageRangeBounds,
  resolveUsageGranularity,
  USAGE_ANALYTICS_DEFAULT_FILTERS,
  type UsageMatrixDimension,
  type UsageMatrixMetricKey,
  type UsageTrendMetricKey,
  type UsageAnalyticsFiltersState,
  type UsageAnalyticsTab,
  type UsageSelectedFilterKey,
  type UsageAnomalyAnalysis,
  type UsageHeatmapCellSelection,
  type UsageHeatmapDateOption,
  type UsageHeatmapMetricKey,
  type UsageHeatmapScaleMode,
  type UsageTimelinePoint,
} from './usageAnalyticsModel';
import {
  buildUsageAnalyticsSearchParams,
  buildUsageAnalyticsUiStateFromSearchParams,
  readUsageAnalyticsUiState,
  writeUsageAnalyticsUiState,
  type UsageAnalyticsUiState,
} from './usageAnalyticsUiState';

const USAGE_SEARCH_DEBOUNCE_MS = 350;
const USAGE_HEATMAP_ALL_DATES_KEY = 'all';

const getBrowserTimeZone = () => {
  if (typeof Intl === 'undefined') return 'UTC';
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
};

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, value]);

  return debouncedValue;
}

export function useUsageAnalytics() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [initialUiState] = useState<UsageAnalyticsUiState>(() =>
    buildUsageAnalyticsUiStateFromSearchParams(
      searchParams,
      readUsageAnalyticsUiState()
    )
  );
  const [filters, setFiltersState] = useState<UsageAnalyticsFiltersState>(
    () => initialUiState.filters
  );
  const [activeTabState, setActiveTabState] = useState<UsageAnalyticsTab>(
    () => initialUiState.activeTab
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [selectedBucketMs, setSelectedBucketMs] = useState<number | null>(null);
  const [selectedModelId, setSelectedModelId] = useState('');
  const [selectedApiKeyHash, setSelectedApiKeyHash] = useState('');
  const [selectedCredentialId, setSelectedCredentialId] = useState('');
  const [trendMetric, setTrendMetric] = useState<UsageTrendMetricKey>('requestCount');
  const [matrixDimension, setMatrixDimension] = useState<UsageMatrixDimension>('apiKeyModel');
  const [matrixMetric, setMatrixMetric] = useState<UsageMatrixMetricKey>('requestCount');
  const [heatmapMetric, setHeatmapMetric] = useState<UsageHeatmapMetricKey>('requestCount');
  const [heatmapScaleMode, setHeatmapScaleMode] = useState<UsageHeatmapScaleMode>('absolute');
  const [selectedHeatmapDateKey, setSelectedHeatmapDateKey] = useState(USAGE_HEATMAP_ALL_DATES_KEY);
  const [selectedHeatmapCell, setSelectedHeatmapCell] = useState<UsageHeatmapCellSelection | null>(
    null
  );
  const browserTimeZone = useMemo(() => getBrowserTimeZone(), []);
  const setActiveTab = useCallback((tab: UsageAnalyticsTab) => {
    setActiveTabState(tab);
    writeUsageAnalyticsUiState({ activeTab: tab });
  }, []);
  const debouncedSearchQuery = useDebouncedValue(
    filters.searchQuery.trim(),
    USAGE_SEARCH_DEBOUNCE_MS
  );

  const bounds = useMemo(() => getUsageRangeBounds(filters, nowMs), [filters, nowMs]);
  const heatmapRangeContext = useMemo(
    () => buildUsageHeatmapRangeContext(bounds, 'en-US', browserTimeZone),
    [bounds, browserTimeZone]
  );
  const heatmapDateOptions = useMemo(
    () => buildUsageHeatmapCellDateOptions(heatmapRangeContext, selectedHeatmapCell),
    [heatmapRangeContext, selectedHeatmapCell]
  );
  const selectedHeatmapDate = useMemo<UsageHeatmapDateOption | null>(
    () =>
      selectedHeatmapDateKey === USAGE_HEATMAP_ALL_DATES_KEY
        ? null
        : (heatmapDateOptions.find((option) => option.key === selectedHeatmapDateKey) ?? null),
    [heatmapDateOptions, selectedHeatmapDateKey]
  );
  const activeHeatmapDateKey = selectedHeatmapDate
    ? selectedHeatmapDateKey
    : USAGE_HEATMAP_ALL_DATES_KEY;
  const resolvedGranularity = useMemo(
    () => resolveUsageGranularity(filters, nowMs),
    [filters, nowMs]
  );
  const analyticsFilters = useMemo(() => buildUsageAnalyticsFilters(filters), [filters]);

  useEffect(() => {
    const nextState = { activeTab: activeTabState, filters };
    writeUsageAnalyticsUiState(nextState);
    const nextParams = buildUsageAnalyticsSearchParams(nextState);
    if (nextParams.toString() !== searchParams.toString()) {
      setSearchParams(nextParams, { replace: true });
    }
  }, [activeTabState, filters, searchParams, setSearchParams]);
  const drilldownPreview = useMemo(() => {
    if (selectedBucketMs === null) return null;
    return {
      fromMs: selectedBucketMs,
      toMs:
        selectedBucketMs + (resolvedGranularity === 'day' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000),
      limit: 12,
    };
  }, [resolvedGranularity, selectedBucketMs]);
  const include = useMemo(
    () => buildUsageAnalyticsInclude(resolvedGranularity, drilldownPreview),
    [drilldownPreview, resolvedGranularity]
  );
  const dataScopeKey = useMemo(
    () =>
      JSON.stringify({
        bounds,
        drilldownPreview,
        filters: analyticsFilters,
        granularity: resolvedGranularity,
        searchQuery: debouncedSearchQuery,
      }),
    [analyticsFilters, bounds, debouncedSearchQuery, drilldownPreview, resolvedGranularity]
  );

  const analytics = useMonitoringAnalytics({
    fromMs: bounds?.fromMs,
    toMs: bounds?.toMs,
    nowMs,
    dataScopeKey,
    searchQuery: debouncedSearchQuery,
    filters: analyticsFilters,
    include,
    throttleMs: 0,
  });

  const heatmapDateInclude = useMemo(
    () => ({
      granularity: 'hour' as const,
      heatmap: true,
    }),
    []
  );
  const heatmapDateDataScopeKey = useMemo(
    () =>
      JSON.stringify({
        date: selectedHeatmapDate
          ? {
              fromMs: selectedHeatmapDate.fromMs,
              key: selectedHeatmapDate.key,
              toMs: selectedHeatmapDate.toMs,
            }
          : null,
        filters: analyticsFilters,
        searchQuery: debouncedSearchQuery,
      }),
    [analyticsFilters, debouncedSearchQuery, selectedHeatmapDate]
  );
  const heatmapDateAnalytics = useMonitoringAnalytics({
    fromMs: selectedHeatmapDate?.fromMs,
    toMs: selectedHeatmapDate?.toMs,
    nowMs,
    dataScopeKey: heatmapDateDataScopeKey,
    searchQuery: debouncedSearchQuery,
    filters: analyticsFilters,
    include: heatmapDateInclude,
    throttleMs: 0,
  });

  const analyticsData = analytics.dataStale ? null : analytics.data;
  const adapted = useMemo(
    () => adaptUsageAnalyticsData(analyticsData, resolvedGranularity, filters.apiKeyKeyword),
    [analyticsData, filters.apiKeyKeyword, resolvedGranularity]
  );
  const heatmapDateData = heatmapDateAnalytics.dataStale ? null : heatmapDateAnalytics.data;
  const heatmapDateRows = useMemo(
    () => buildUsageHeatmap(heatmapDateData?.heatmap ?? []),
    [heatmapDateData]
  );
  const heatmapDetailSource = selectedHeatmapDate ? heatmapDateRows : adapted.heatmap;
  const heatmapDateRefreshing = Boolean(
    selectedHeatmapDate &&
    (heatmapDateAnalytics.loading ||
      heatmapDateAnalytics.dataStale ||
      (!heatmapDateAnalytics.data && !heatmapDateAnalytics.error))
  );
  const summaryDelta = useMemo(
    () => buildUsageSummaryDelta(adapted.summary, adapted.summaryComparison),
    [adapted.summary, adapted.summaryComparison]
  );

  const selectedBucket = useMemo(
    () =>
      selectedBucketMs === null
        ? null
        : (adapted.timeline.find((point) => point.bucketMs === selectedBucketMs) ?? null),
    [adapted.timeline, selectedBucketMs]
  );

  const anomalyAnalysis = useMemo<UsageAnomalyAnalysis | null>(
    () =>
      selectedBucketMs === null ? null : analyzeUsageBucket(adapted.timeline, selectedBucketMs),
    [adapted.timeline, selectedBucketMs]
  );

  const selectedModel =
    adapted.modelRows.find((row) => row.id === selectedModelId) ?? adapted.modelRows[0] ?? null;
  const selectedApiKey =
    adapted.apiKeyRows.find((row) => row.apiKeyHash === selectedApiKeyHash) ??
    adapted.apiKeyRows[0] ??
    null;
  const selectedCredential =
    adapted.credentialRows.find((row) => row.id === selectedCredentialId) ??
    adapted.credentialRows[0] ??
    null;

  const modelTrendSeries = useMemo(
    () => buildEntityTrendSeries(adapted.modelRows, adapted.timeline, trendMetric, 4),
    [adapted.modelRows, adapted.timeline, trendMetric]
  );
  const apiKeyTrendSeries = useMemo(
    () => buildEntityTrendSeries(adapted.apiKeyRows, adapted.timeline, trendMetric, 4),
    [adapted.apiKeyRows, adapted.timeline, trendMetric]
  );
  const selectedApiKeyFilterHash = selectedApiKey?.apiKeyHash || selectedApiKey?.id || '';
  const selectedApiKeyTimelineFilters = useMemo(
    () =>
      selectedApiKeyFilterHash
        ? buildUsageAnalyticsFilters({ ...filters, apiKeyHash: selectedApiKeyFilterHash })
        : {},
    [filters, selectedApiKeyFilterHash]
  );
  const selectedApiKeyTimelineInclude = useMemo(
    () => ({
      granularity: resolvedGranularity,
      timeline: true,
    }),
    [resolvedGranularity]
  );
  const selectedApiKeyTimelineDataScopeKey = useMemo(
    () =>
      JSON.stringify({
        activeTab: activeTabState,
        bounds,
        filters: selectedApiKeyTimelineFilters,
        granularity: resolvedGranularity,
        searchQuery: debouncedSearchQuery,
        selectedApiKeyHash: selectedApiKeyFilterHash,
      }),
    [
      activeTabState,
      bounds,
      debouncedSearchQuery,
      resolvedGranularity,
      selectedApiKeyFilterHash,
      selectedApiKeyTimelineFilters,
    ]
  );
  const selectedApiKeyTimelineAnalytics = useMonitoringAnalytics({
    fromMs: activeTabState === 'apiKeys' && selectedApiKeyFilterHash ? bounds?.fromMs : undefined,
    toMs: activeTabState === 'apiKeys' && selectedApiKeyFilterHash ? bounds?.toMs : undefined,
    nowMs,
    dataScopeKey: selectedApiKeyTimelineDataScopeKey,
    searchQuery: debouncedSearchQuery,
    filters: selectedApiKeyTimelineFilters,
    include: selectedApiKeyTimelineInclude,
    throttleMs: 0,
  });
  const selectedApiKeyTimelineData = selectedApiKeyTimelineAnalytics.dataStale
    ? null
    : selectedApiKeyTimelineAnalytics.data;
  const selectedApiKeyTimeline = useMemo(
    () => buildUsageTimeline(selectedApiKeyTimelineData?.timeline ?? [], resolvedGranularity),
    [resolvedGranularity, selectedApiKeyTimelineData]
  );
  const selectedApiKeyTrendSeries = useMemo(
    () => buildSelectedApiKeyTrendSeries(selectedApiKey, selectedApiKeyTimeline, trendMetric),
    [selectedApiKey, selectedApiKeyTimeline, trendMetric]
  );
  const credentialTrendSeries = useMemo(
    () =>
      buildSelectedCredentialTrendSeries(
        selectedCredential,
        adapted.credentialTimeline,
        trendMetric
      ),
    [adapted.credentialTimeline, selectedCredential, trendMetric]
  );
  const heatmapDetail = useMemo(
    () => buildUsageHeatmapCellDetail(heatmapDetailSource, selectedHeatmapCell, heatmapMetric),
    [heatmapDetailSource, heatmapMetric, selectedHeatmapCell]
  );
  const heatmapHighlights = useMemo(
    () => buildUsageHeatmapHighlights(adapted.heatmap),
    [adapted.heatmap]
  );
  const matrix = useMemo(
    () =>
      buildUsageMatrix({
        apiKeyRows: adapted.apiKeyRows,
        credentialRows: adapted.credentialRows,
        dimension: matrixDimension,
        metric: matrixMetric,
      }),
    [adapted.apiKeyRows, adapted.credentialRows, matrixDimension, matrixMetric]
  );
  const keyAnomalies = useMemo(() => buildKeyAnomalies(adapted.apiKeyRows), [adapted.apiKeyRows]);
  const credentialAnomalies = useMemo(
    () => buildKeyAnomalies(adapted.credentialRows),
    [adapted.credentialRows]
  );
  const credentialQuotaRows = useMemo(
    () => buildCredentialQuotaRows(adapted.credentialRows, nowMs),
    [adapted.credentialRows, nowMs]
  );
  const insights = useMemo(
    () =>
      buildUsageInsights({
        apiKeyRows: adapted.apiKeyRows,
        credentialRows: adapted.credentialRows,
        modelRows: adapted.modelRows,
        providerRows: adapted.providerRows,
        summary: adapted.summary,
      }),
    [
      adapted.apiKeyRows,
      adapted.credentialRows,
      adapted.modelRows,
      adapted.providerRows,
      adapted.summary,
    ]
  );
  const setFilters = useCallback((patch: Partial<UsageAnalyticsFiltersState>) => {
    setFiltersState((current) => {
      const next = { ...current, ...patch };
      writeUsageAnalyticsUiState({ filters: next });
      return next;
    });
    setSelectedBucketMs(null);
    setSelectedHeatmapDateKey(USAGE_HEATMAP_ALL_DATES_KEY);
    setSelectedHeatmapCell(null);
  }, []);

  const resetFilters = useCallback(() => {
    setFiltersState(USAGE_ANALYTICS_DEFAULT_FILTERS);
    writeUsageAnalyticsUiState({ filters: USAGE_ANALYTICS_DEFAULT_FILTERS });
    setSelectedBucketMs(null);
    setSelectedHeatmapDateKey(USAGE_HEATMAP_ALL_DATES_KEY);
    setSelectedHeatmapCell(null);
  }, []);

  const clearFilter = useCallback((key: UsageSelectedFilterKey) => {
    setFiltersState((current) => {
      const next = {
        ...current,
        [key]: 'all',
      };
      writeUsageAnalyticsUiState({ filters: next });
      return next;
    });
    setSelectedBucketMs(null);
    setSelectedHeatmapDateKey(USAGE_HEATMAP_ALL_DATES_KEY);
    setSelectedHeatmapCell(null);
  }, []);

  const selectBucket = useCallback((point: UsageTimelinePoint | null) => {
    setSelectedBucketMs(point?.bucketMs ?? null);
  }, []);

  const selectHeatmapCell = useCallback((cell: UsageHeatmapCellSelection | null) => {
    setSelectedHeatmapCell(cell);
    setSelectedHeatmapDateKey(USAGE_HEATMAP_ALL_DATES_KEY);
  }, []);

  const selectHeatmapDate = useCallback((key: string) => {
    setSelectedHeatmapDateKey(key || USAGE_HEATMAP_ALL_DATES_KEY);
  }, []);

  const refresh = useCallback(() => {
    setNowMs(Date.now());
    void analytics.refresh({ force: true });
    if (selectedApiKeyTimelineAnalytics.enabled) {
      void selectedApiKeyTimelineAnalytics.refresh({ force: true });
    }
    if (selectedHeatmapDate) {
      void heatmapDateAnalytics.refresh({ force: true });
    }
  }, [analytics, heatmapDateAnalytics, selectedApiKeyTimelineAnalytics, selectedHeatmapDate]);

  return {
    filters,
    setFilters,
    resetFilters,
    clearFilter,
    activeTab: activeTabState,
    setActiveTab,
    bounds,
    resolvedGranularity,
    loading: analytics.loading,
    error: analytics.error,
    enabled: analytics.enabled,
    unavailableReason: analytics.unavailableReason,
    lastRefreshedAt: analytics.lastRefreshedAt,
    refresh,
    summary: adapted.summary,
    summaryDelta,
    timeline: adapted.timeline,
    modelRows: adapted.modelRows,
    apiKeyRows: adapted.apiKeyRows,
    credentialRows: adapted.credentialRows,
    allCredentialRows: adapted.credentialRows,
    providerRows: adapted.providerRows,
    heatmap: adapted.heatmap,
    heatmapMetric,
    setHeatmapMetric,
    heatmapScaleMode,
    setHeatmapScaleMode,
    heatmapDateOptions,
    selectedHeatmapDateKey: activeHeatmapDateKey,
    selectHeatmapDate,
    heatmapDateLoading: heatmapDateRefreshing,
    heatmapDateError: selectedHeatmapDate ? heatmapDateAnalytics.error : '',
    selectedHeatmapCell,
    selectHeatmapCell,
    heatmapDetail,
    heatmapHighlights,
    browserTimeZone,
    matrix,
    matrixDimension,
    setMatrixDimension,
    matrixMetric,
    setMatrixMetric,
    trendMetric,
    setTrendMetric,
    modelTrendSeries,
    apiKeyTrendSeries,
    selectedApiKeyTrendSeries,
    credentialTrendSeries,
    keyAnomalies,
    credentialAnomalies,
    credentialQuotaRows,
    insights,
    anomalyPoints: adapted.anomalyPoints,
    drilldownPreview: adapted.drilldownPreview,
    filterOptions: adapted.filterOptions,
    selectedBucket,
    selectBucket,
    anomalyAnalysis,
    selectedModel,
    setSelectedModelId,
    selectedApiKey,
    setSelectedApiKeyHash,
    selectedCredential,
    setSelectedCredentialId,
  };
}
