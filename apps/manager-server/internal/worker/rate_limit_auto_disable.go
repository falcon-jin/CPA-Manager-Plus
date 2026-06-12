package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	collectorpkg "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/collector"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cpa"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/usage"
)

const (
	quotaAutoDisableQueueSize     = 256
	quotaAutoDisableDefaultTick   = 15 * time.Second
	quotaAutoDisableActionTimeout = 15 * time.Second
	quotaCooldownDueLimit         = 100
)

// RateLimitAutoDisableWorker reacts to request-monitoring events in near real time.
// It only handles Codex 429 usage_limit_reached responses that include an explicit
// reset time. Disables are persisted with CPAMP ownership, so recovery never relies
// solely on in-memory timers and never re-enables pre-existing/manual disables.
type RateLimitAutoDisableWorker struct {
	store  *store.Store
	client *http.Client

	jobs chan quotaAutoDisableCandidate

	mu                  sync.RWMutex
	baseURL             string
	managementKey       string
	enableCheckInterval time.Duration
}

type quotaAutoDisableCandidate struct {
	BaseURL        string
	ManagementKey  string
	FileName       string
	AuthIndex      string
	DisplayAccount string
	Provider       string
	ResetAt        time.Time
	EventHash      string
	Reason         string
}

type authFile map[string]any

func NewRateLimitAutoDisableWorker(st *store.Store, initial ...collectorpkg.RuntimeConfig) *RateLimitAutoDisableWorker {
	w := &RateLimitAutoDisableWorker{
		store:               st,
		client:              &http.Client{Timeout: quotaAutoDisableActionTimeout},
		jobs:                make(chan quotaAutoDisableCandidate, quotaAutoDisableQueueSize),
		enableCheckInterval: quotaAutoDisableDefaultTick,
	}
	if len(initial) > 0 {
		w.setRuntimeConfig(initial[0].CPAUpstreamURL, initial[0].ManagementKey)
	}
	return w
}

func (w *RateLimitAutoDisableWorker) Start(ctx context.Context) {
	go w.run(ctx)
}

func (w *RateLimitAutoDisableWorker) UpdateRuntimeConfig(ctx context.Context, cfg collectorpkg.RuntimeConfig) {
	if w == nil {
		return
	}
	baseURL := strings.TrimSpace(cfg.CPAUpstreamURL)
	managementKey := strings.TrimSpace(cfg.ManagementKey)
	if baseURL == "" || managementKey == "" {
		return
	}
	w.setRuntimeConfig(baseURL, managementKey)
	w.enableDue(ctx, time.Now())
}

// HandleUsageEvents is called by the request-monitoring collector after raw CPA
// usage events are normalized and enriched with auth-file snapshots. It does not
// poll historical events; it only reacts to newly observed request failures.
func (w *RateLimitAutoDisableWorker) HandleUsageEvents(ctx context.Context, cfg collectorpkg.RuntimeConfig, events []usage.Event) {
	if w == nil {
		return
	}
	baseURL := strings.TrimSpace(cfg.CPAUpstreamURL)
	managementKey := strings.TrimSpace(cfg.ManagementKey)
	if baseURL == "" || managementKey == "" {
		return
	}
	w.setRuntimeConfig(baseURL, managementKey)
	if len(events) == 0 {
		return
	}
	now := time.Now()
	for _, event := range events {
		candidate, ok := quotaAutoDisableCandidateFromEvent(event, baseURL, managementKey, now)
		if !ok {
			continue
		}
		select {
		case w.jobs <- candidate:
		case <-ctx.Done():
			return
		default:
			log.Printf("[quota-auto-disable] job queue full, dropped auth file %q event=%q", candidate.FileName, candidate.EventHash)
		}
	}
}

func (w *RateLimitAutoDisableWorker) run(ctx context.Context) {
	interval := w.enableCheckInterval
	if interval <= 0 {
		interval = quotaAutoDisableDefaultTick
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	w.enableDue(ctx, time.Now())
	for {
		select {
		case <-ctx.Done():
			return
		case candidate := <-w.jobs:
			w.handleCandidate(ctx, candidate)
		case <-ticker.C:
			w.enableDue(ctx, time.Now())
		}
	}
}

func (w *RateLimitAutoDisableWorker) setRuntimeConfig(baseURL string, managementKey string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.baseURL = strings.TrimSpace(baseURL)
	w.managementKey = strings.TrimSpace(managementKey)
}

func (w *RateLimitAutoDisableWorker) runtimeConfig() (string, string) {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.baseURL, w.managementKey
}

func (w *RateLimitAutoDisableWorker) handleCandidate(ctx context.Context, candidate quotaAutoDisableCandidate) {
	if w == nil || w.store == nil || w.store.QuotaCooldowns == nil {
		log.Printf("[quota-auto-disable] store unavailable, skip auth file %q", candidate.FileName)
		return
	}
	if candidate.FileName == "" || candidate.BaseURL == "" || candidate.ManagementKey == "" {
		return
	}
	now := time.Now()
	if !candidate.ResetAt.After(now) {
		log.Printf("[quota-auto-disable] quota event for auth file %q has non-future reset time %s, skip auto disable", candidate.FileName, candidate.ResetAt.Format(time.RFC3339))
		return
	}

	current, ok, err := w.currentAuthFile(ctx, candidate.BaseURL, candidate.ManagementKey, candidate.FileName, candidate.AuthIndex)
	if err != nil {
		log.Printf("[quota-auto-disable] failed to verify auth file %q before disable: %v", candidate.FileName, err)
		return
	}
	if !ok {
		log.Printf("[quota-auto-disable] auth file %q authIndex=%q not found/currently mismatched, skip auto disable", candidate.FileName, candidate.AuthIndex)
		return
	}
	preDisabled := authFileDisabled(current)
	if preDisabled {
		if w.extendExistingCooldown(ctx, candidate, current) {
			return
		}
		log.Printf("[quota-auto-disable] auth file %q was already disabled without CPAMP ownership; skip auto disable/recovery", candidate.FileName)
		return
	}

	log.Printf("[quota-auto-disable] Codex usage limit reached for auth file %q account=%q provider=%q resetAt=%s, disabling", candidate.FileName, candidate.DisplayAccount, candidate.Provider, candidate.ResetAt.Format(time.RFC3339))
	if err := w.patchAuthFile(ctx, candidate.BaseURL, candidate.ManagementKey, candidate.FileName, true); err != nil {
		log.Printf("[quota-auto-disable] failed to disable auth file %q: %v", candidate.FileName, err)
		return
	}

	_, err = w.store.UpsertQuotaCooldown(ctx, store.QuotaCooldownUpsert{
		AuthFileName:     candidate.FileName,
		AuthIndex:        firstNonEmpty(candidate.AuthIndex, authFileAuthIndex(current)),
		AccountSnapshot:  candidate.DisplayAccount,
		Provider:         strings.ToLower(strings.TrimSpace(candidate.Provider)),
		RecoverAtMS:      candidate.ResetAt.UnixMilli(),
		Owner:            model.QuotaCooldownOwnerUsage429,
		EventHash:        candidate.EventHash,
		PreDisabledState: preDisabled,
		DisabledAtMS:     now.UnixMilli(),
	})
	if err != nil {
		log.Printf("[quota-auto-disable] disabled auth file %q but failed to persist cooldown ownership: %v", candidate.FileName, err)
		if rollbackErr := w.patchAuthFile(ctx, candidate.BaseURL, candidate.ManagementKey, candidate.FileName, false); rollbackErr != nil {
			log.Printf("[quota-auto-disable] failed to roll back auth file %q after cooldown persistence error: %v", candidate.FileName, rollbackErr)
		}
		return
	}
	log.Printf("[quota-auto-disable] disabled auth file %q; persisted CPAMP-owned auto-enable at %s", candidate.FileName, candidate.ResetAt.Format(time.RFC3339))
}

func (w *RateLimitAutoDisableWorker) extendExistingCooldown(ctx context.Context, candidate quotaAutoDisableCandidate, current authFile) bool {
	active, err := w.store.QuotaCooldowns.ListActive(ctx)
	if err != nil {
		log.Printf("[quota-auto-disable] failed to check active cooldowns for auth file %q: %v", candidate.FileName, err)
		return false
	}
	var existing store.QuotaCooldown
	for _, item := range active {
		if item.AuthFileName == candidate.FileName && item.Owner == model.QuotaCooldownOwnerUsage429 {
			existing = item
			break
		}
	}
	if existing.ID == 0 {
		return false
	}
	currentIndex := authFileAuthIndex(current)
	if existing.AuthIndex != "" && currentIndex != existing.AuthIndex {
		log.Printf("[quota-auto-disable] active cooldown auth index mismatch for auth file %q: stored=%q current=%q", candidate.FileName, existing.AuthIndex, currentIndex)
		return false
	}
	_, err = w.store.UpsertQuotaCooldown(ctx, store.QuotaCooldownUpsert{
		AuthFileName:     candidate.FileName,
		AuthIndex:        firstNonEmpty(candidate.AuthIndex, existing.AuthIndex, authFileAuthIndex(current)),
		AccountSnapshot:  firstNonEmpty(candidate.DisplayAccount, existing.AccountSnapshot),
		Provider:         strings.ToLower(strings.TrimSpace(firstNonEmpty(candidate.Provider, existing.Provider))),
		RecoverAtMS:      candidate.ResetAt.UnixMilli(),
		Owner:            model.QuotaCooldownOwnerUsage429,
		EventHash:        candidate.EventHash,
		PreDisabledState: false,
		DisabledAtMS:     existing.DisabledAtMS,
	})
	if err != nil {
		log.Printf("[quota-auto-disable] failed to extend active cooldown for auth file %q: %v", candidate.FileName, err)
		return false
	}
	log.Printf("[quota-auto-disable] extended CPAMP-owned auth file %q auto-enable time to %s", candidate.FileName, candidate.ResetAt.Format(time.RFC3339))
	return true
}

func (w *RateLimitAutoDisableWorker) enableDue(ctx context.Context, now time.Time) {
	if w == nil || w.store == nil || w.store.QuotaCooldowns == nil {
		return
	}
	baseURL, managementKey := w.runtimeConfig()
	if baseURL == "" || managementKey == "" {
		return
	}
	due, err := w.store.ListDueQuotaCooldowns(ctx, now.UnixMilli(), quotaCooldownDueLimit)
	if err != nil {
		log.Printf("[quota-auto-disable] failed to list due quota cooldowns: %v", err)
		return
	}
	for _, item := range due {
		w.recoverCooldown(ctx, baseURL, managementKey, item, now)
	}
}

func (w *RateLimitAutoDisableWorker) recoverCooldown(ctx context.Context, baseURL string, managementKey string, item store.QuotaCooldown, now time.Time) {
	if item.Owner != model.QuotaCooldownOwnerUsage429 {
		_ = w.store.MarkQuotaCooldownSkipped(ctx, item.ID, "unknown owner")
		return
	}
	if item.PreDisabledState {
		_ = w.store.MarkQuotaCooldownSkipped(ctx, item.ID, "pre-disabled before CPAMP action")
		return
	}
	current, ok, err := w.currentAuthFile(ctx, baseURL, managementKey, item.AuthFileName, item.AuthIndex)
	if err != nil {
		_ = w.store.RecordQuotaCooldownFailure(ctx, item.ID, err.Error())
		log.Printf("[quota-auto-disable] failed to verify auth file %q before recovery: %v", item.AuthFileName, err)
		return
	}
	if !ok {
		_ = w.store.MarkQuotaCooldownSkipped(ctx, item.ID, "auth file missing or auth index mismatch")
		log.Printf("[quota-auto-disable] auth file %q authIndex=%q missing/mismatched, skip auto-enable", item.AuthFileName, item.AuthIndex)
		return
	}
	if !authFileDisabled(current) {
		_ = w.store.MarkQuotaCooldownRecovered(ctx, item.ID, now.UnixMilli())
		log.Printf("[quota-auto-disable] auth file %q already enabled; marked cooldown recovered", item.AuthFileName)
		return
	}

	log.Printf("[quota-auto-disable] reset time reached for auth file %q account=%q, enabling", item.AuthFileName, item.AccountSnapshot)
	if err := w.patchAuthFile(ctx, baseURL, managementKey, item.AuthFileName, false); err != nil {
		_ = w.store.RecordQuotaCooldownFailure(ctx, item.ID, err.Error())
		log.Printf("[quota-auto-disable] failed to enable auth file %q: %v", item.AuthFileName, err)
		return
	}
	if err := w.store.MarkQuotaCooldownRecovered(ctx, item.ID, now.UnixMilli()); err != nil {
		log.Printf("[quota-auto-disable] enabled auth file %q but failed to mark cooldown recovered: %v", item.AuthFileName, err)
		return
	}
	log.Printf("[quota-auto-disable] enabled auth file %q after Codex usage-limit reset", item.AuthFileName)
}

func quotaAutoDisableCandidateFromEvent(event usage.Event, baseURL string, managementKey string, now time.Time) (quotaAutoDisableCandidate, bool) {
	resetAt, ok := codexUsageLimitResetTimeFromEvent(event, now)
	if !ok {
		return quotaAutoDisableCandidate{}, false
	}
	fileName := strings.TrimSpace(event.AuthFileSnapshot)
	if fileName == "" {
		log.Printf("[quota-auto-disable] Codex usage-limit event %q has no auth file snapshot, skip auto disable", event.EventHash)
		return quotaAutoDisableCandidate{}, false
	}
	return quotaAutoDisableCandidate{
		BaseURL:        baseURL,
		ManagementKey:  managementKey,
		FileName:       fileName,
		AuthIndex:      strings.TrimSpace(event.AuthIndex),
		DisplayAccount: firstNonEmpty(event.AccountSnapshot, event.AuthLabelSnapshot, event.Source, fileName),
		Provider:       "codex",
		ResetAt:        resetAt,
		EventHash:      event.EventHash,
		Reason:         event.FailSummary,
	}, true
}

func codexUsageLimitResetTimeFromEvent(event usage.Event, now time.Time) (time.Time, bool) {
	if !event.Failed || event.FailStatusCode != http.StatusTooManyRequests {
		return time.Time{}, false
	}
	provider := strings.ToLower(strings.TrimSpace(firstNonEmpty(event.Provider, event.AuthProviderSnapshot)))
	if provider != "codex" {
		return time.Time{}, false
	}
	for _, text := range []string{event.FailBody, event.RawJSON, event.FailSummary} {
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		var decoded any
		decoder := json.NewDecoder(strings.NewReader(text))
		decoder.UseNumber()
		if err := decoder.Decode(&decoded); err != nil {
			continue
		}
		if resetAt, ok := usageLimitResetFromJSON(decoded, now); ok {
			return resetAt, true
		}
	}
	return time.Time{}, false
}

func usageLimitResetFromJSON(value any, now time.Time) (time.Time, bool) {
	switch typed := value.(type) {
	case map[string]any:
		if isUsageLimitMap(typed) {
			if resetAt, ok := explicitCodexResetTime(typed, now); ok {
				return resetAt, true
			}
		}
		if rawError, ok := typed["error"]; ok {
			if errorMap, ok := rawError.(map[string]any); ok && isUsageLimitMap(errorMap) {
				if resetAt, ok := explicitCodexResetTime(errorMap, now); ok {
					return resetAt, true
				}
				if resetAt, ok := explicitCodexResetTime(typed, now); ok {
					return resetAt, true
				}
			}
		}
		for _, child := range typed {
			if resetAt, ok := usageLimitResetFromJSON(child, now); ok {
				return resetAt, true
			}
		}
	case []any:
		for _, child := range typed {
			if resetAt, ok := usageLimitResetFromJSON(child, now); ok {
				return resetAt, true
			}
		}
	}
	return time.Time{}, false
}

func isUsageLimitMap(value map[string]any) bool {
	return strings.EqualFold(strings.TrimSpace(fmt.Sprint(value["type"])), "usage_limit_reached")
}

func explicitCodexResetTime(value map[string]any, now time.Time) (time.Time, bool) {
	for _, key := range []string{"resets_at", "resetsAt"} {
		if raw, ok := value[key]; ok {
			return parseResetValue(raw, now, false)
		}
	}
	for _, key := range []string{"resets_in_seconds", "resetsInSeconds"} {
		if raw, ok := value[key]; ok {
			return parseResetValue(raw, now, true)
		}
	}
	return time.Time{}, false
}

func parseResetValue(value any, now time.Time, relative bool) (time.Time, bool) {
	if value == nil {
		return time.Time{}, false
	}
	switch typed := value.(type) {
	case json.Number:
		return parseResetNumberString(typed.String(), now, relative)
	case float64:
		return resetTimeFromNumber(typed, now, relative)
	case int:
		return resetTimeFromNumber(float64(typed), now, relative)
	case int64:
		return resetTimeFromNumber(float64(typed), now, relative)
	case string:
		return parseResetNumberString(strings.TrimSpace(typed), now, relative)
	default:
		return parseResetNumberString(strings.TrimSpace(fmt.Sprint(typed)), now, relative)
	}
}

func parseResetNumberString(text string, now time.Time, relative bool) (time.Time, bool) {
	if text == "" || strings.EqualFold(text, "null") {
		return time.Time{}, false
	}
	if !relative {
		if parsed, ok := parseCommonTime(text); ok {
			return parsed, true
		}
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil || value <= 0 {
		return time.Time{}, false
	}
	return resetTimeFromNumber(value, now, relative)
}

func resetTimeFromNumber(value float64, now time.Time, relative bool) (time.Time, bool) {
	if value <= 0 {
		return time.Time{}, false
	}
	if relative {
		return now.Add(time.Duration(value * float64(time.Second))), true
	}
	// Unix milliseconds, e.g. JavaScript timestamps.
	if value > 1_000_000_000_000 {
		return time.UnixMilli(int64(value)), true
	}
	// Unix seconds.
	if value > 1_000_000_000 {
		return time.Unix(int64(value), 0), true
	}
	return time.Time{}, false
}

func parseCommonTime(text string) (time.Time, bool) {
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		time.RFC1123,
		time.RFC1123Z,
		"2006-01-02T15:04:05.000Z07:00",
		"2006-01-02 15:04:05 MST",
		"2006-01-02 15:04:05",
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, text); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func (w *RateLimitAutoDisableWorker) currentAuthFile(ctx context.Context, baseURL string, managementKey string, fileName string, authIndex string) (authFile, bool, error) {
	files, err := w.fetchAuthFiles(ctx, baseURL, managementKey)
	if err != nil {
		return nil, false, err
	}
	fileName = strings.TrimSpace(fileName)
	authIndex = strings.TrimSpace(authIndex)
	for _, file := range files {
		if authFileName(file) != fileName {
			continue
		}
		if authIndex != "" && authFileAuthIndex(file) != authIndex {
			continue
		}
		return file, true, nil
	}
	return nil, false, nil
}

func (w *RateLimitAutoDisableWorker) fetchAuthFiles(ctx context.Context, baseURL string, managementKey string) ([]authFile, error) {
	base := cpa.NormalizeBaseURL(baseURL)
	paths := []string{
		base + "/auth-files",
		base + "/v0/management/auth-files",
	}
	client := w.client
	if client == nil {
		client = http.DefaultClient
	}
	var endpointErrors []string
	for _, endpoint := range paths {
		reqCtx, cancel := context.WithTimeout(ctx, quotaAutoDisableActionTimeout)
		req, reqErr := http.NewRequestWithContext(reqCtx, http.MethodGet, endpoint, nil)
		if reqErr != nil {
			cancel()
			endpointErrors = append(endpointErrors, fmt.Sprintf("%s: %v", endpoint, reqErr))
			continue
		}
		req.Header.Set("Authorization", "Bearer "+managementKey)
		res, doErr := client.Do(req)
		cancel()
		if doErr != nil {
			endpointErrors = append(endpointErrors, fmt.Sprintf("%s: %v", endpoint, doErr))
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
		_ = res.Body.Close()
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			endpointErrors = append(endpointErrors, fmt.Sprintf("%s: HTTP %d %s", endpoint, res.StatusCode, strings.TrimSpace(string(body))))
			continue
		}
		files, err := parseAuthFiles(body)
		if err != nil {
			endpointErrors = append(endpointErrors, fmt.Sprintf("%s: %v", endpoint, err))
			continue
		}
		return files, nil
	}
	if len(endpointErrors) == 0 {
		return nil, errors.New("no auth-file endpoint attempted")
	}
	return nil, fmt.Errorf("all auth-file endpoints failed: %s", strings.Join(endpointErrors, "; "))
}

func parseAuthFiles(body []byte) ([]authFile, error) {
	var decoded any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&decoded); err != nil {
		return nil, err
	}
	files := authFilesFromJSON(decoded)
	if files == nil {
		return []authFile{}, nil
	}
	return files, nil
}

func authFilesFromJSON(value any) []authFile {
	switch typed := value.(type) {
	case []any:
		files := make([]authFile, 0, len(typed))
		for _, item := range typed {
			if m, ok := item.(map[string]any); ok {
				files = append(files, authFile(m))
			}
		}
		return files
	case map[string]any:
		for _, key := range []string{"auth_files", "authFiles", "files", "items", "data"} {
			if child, ok := typed[key]; ok {
				if files := authFilesFromJSON(child); files != nil {
					return files
				}
			}
		}
	}
	return nil
}

func authFileName(file authFile) string {
	return firstNonEmpty(stringField(file, "name"), stringField(file, "file_name"), stringField(file, "fileName"), stringField(file, "id"))
}

func authFileAuthIndex(file authFile) string {
	return firstNonEmpty(stringField(file, "auth_index"), stringField(file, "authIndex"), stringField(file, "auth-index"))
}

func authFileDisabled(file authFile) bool {
	if raw, ok := file["disabled"]; ok {
		switch value := raw.(type) {
		case bool:
			return value
		case json.Number:
			parsed, _ := strconv.ParseFloat(value.String(), 64)
			return parsed != 0
		case float64:
			return value != 0
		case string:
			return strings.EqualFold(strings.TrimSpace(value), "true") || strings.TrimSpace(value) == "1"
		}
	}
	status := strings.ToLower(firstNonEmpty(stringField(file, "status"), stringField(file, "state")))
	return status == "disabled" || status == "inactive"
}

func stringField(file authFile, key string) string {
	if file == nil {
		return ""
	}
	if value, ok := file[key]; ok && value != nil {
		return strings.TrimSpace(fmt.Sprint(value))
	}
	return ""
}

func (w *RateLimitAutoDisableWorker) disableAuthFile(ctx context.Context, baseURL string, managementKey string, fileName string) error {
	return w.patchAuthFile(ctx, baseURL, managementKey, fileName, true)
}

func (w *RateLimitAutoDisableWorker) enableAuthFile(ctx context.Context, baseURL string, managementKey string, fileName string) error {
	return w.patchAuthFile(ctx, baseURL, managementKey, fileName, false)
}

func (w *RateLimitAutoDisableWorker) patchAuthFile(ctx context.Context, baseURL string, managementKey string, fileName string, disabled bool) error {
	payload := map[string]any{"name": fileName, "disabled": disabled}
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal payload: %w", err)
	}

	base := cpa.NormalizeBaseURL(baseURL)
	paths := []string{
		base + "/auth-files",
		base + "/auth-files/status",
		base + "/v0/management/auth-files",
		base + "/v0/management/auth-files/status",
	}

	client := w.client
	if client == nil {
		client = http.DefaultClient
	}

	var endpointErrors []string
	for _, endpoint := range paths {
		reqCtx, cancel := context.WithTimeout(ctx, quotaAutoDisableActionTimeout)
		req, reqErr := http.NewRequestWithContext(reqCtx, http.MethodPatch, endpoint, bytes.NewReader(data))
		if reqErr != nil {
			cancel()
			endpointErrors = append(endpointErrors, fmt.Sprintf("%s: %v", endpoint, reqErr))
			continue
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+managementKey)

		res, doErr := client.Do(req)
		cancel()
		if doErr != nil {
			endpointErrors = append(endpointErrors, fmt.Sprintf("%s: %v", endpoint, doErr))
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		_ = res.Body.Close()

		if res.StatusCode >= 200 && res.StatusCode < 300 {
			return nil
		}
		endpointErrors = append(endpointErrors, fmt.Sprintf("%s: HTTP %d %s", endpoint, res.StatusCode, strings.TrimSpace(string(body))))
	}
	if len(endpointErrors) == 0 {
		return errors.New("no auth-file status endpoint attempted")
	}
	return fmt.Errorf("all auth-file status endpoints failed: %s", strings.Join(endpointErrors, "; "))
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// NormalizeBaseURL is exported for legacy tests.
var NormalizeBaseURL = cpa.NormalizeBaseURL
