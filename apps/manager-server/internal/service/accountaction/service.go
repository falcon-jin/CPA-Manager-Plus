package accountaction

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/model"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/cpa"
	managerconfigsvc "github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

var ErrCandidateNotFound = errors.New("account action candidate not found")
var ErrCandidateConflict = errors.New("account action candidate no longer matches current CPA auth file")
var ErrCandidateNotPending = errors.New("account action candidate is not pending")

type Service struct {
	store                *store.Store
	managerConfigService *managerconfigsvc.Service
	client               *http.Client
}

type ListResponse struct {
	Items        []model.AccountActionCandidate `json:"items"`
	PendingCount int64                          `json:"pendingCount"`
}

type authFile struct {
	Name            string
	AuthIndex       string
	Provider        string
	AccountSnapshot string
	AccountID       string
	Disabled        bool
	Raw             map[string]any
}

func New(st *store.Store, managerConfigService *managerconfigsvc.Service, clients ...*http.Client) *Service {
	client := &http.Client{Timeout: 15 * time.Second}
	if len(clients) > 0 && clients[0] != nil {
		client = clients[0]
	}
	return &Service{store: st, managerConfigService: managerConfigService, client: client}
}

func (s *Service) List(ctx context.Context, status string, limit int) (ListResponse, error) {
	items, err := s.store.ListAccountActionCandidates(ctx, strings.TrimSpace(status), limit)
	if err != nil {
		return ListResponse{}, err
	}
	pendingCount, err := s.store.CountAccountActionCandidates(ctx, model.AccountActionStatusPending)
	if err != nil {
		return ListResponse{}, err
	}
	return ListResponse{Items: items, PendingCount: pendingCount}, nil
}

func (s *Service) Ignore(ctx context.Context, id int64) (model.AccountActionCandidate, error) {
	return s.updatePendingStatus(ctx, id, model.AccountActionStatusIgnored)
}

func (s *Service) Resolve(ctx context.Context, id int64) (model.AccountActionCandidate, error) {
	return s.updatePendingStatus(ctx, id, model.AccountActionStatusResolved)
}

func (s *Service) Enable(ctx context.Context, id int64) (model.AccountActionCandidate, error) {
	item, setup, err := s.resolvePendingCandidateAndSetup(ctx, id)
	if err != nil {
		return model.AccountActionCandidate{}, err
	}
	if _, err := s.verifyCurrentAuthFile(ctx, setup, item); err != nil {
		return model.AccountActionCandidate{}, err
	}
	if err := s.patchAuthFile(ctx, setup, item.AuthFileName, false); err != nil {
		_ = s.store.RecordAccountActionCandidateFailure(ctx, id, err.Error())
		return model.AccountActionCandidate{}, err
	}
	return s.updatePendingStatus(ctx, id, model.AccountActionStatusResolved)
}

func (s *Service) DeleteAuthFile(ctx context.Context, id int64) (model.AccountActionCandidate, error) {
	item, setup, err := s.resolvePendingCandidateAndSetup(ctx, id)
	if err != nil {
		return model.AccountActionCandidate{}, err
	}
	if _, err := s.verifyCurrentAuthFile(ctx, setup, item); err != nil {
		return model.AccountActionCandidate{}, err
	}
	if err := s.deleteAuthFile(ctx, setup, item.AuthFileName); err != nil {
		_ = s.store.RecordAccountActionCandidateFailure(ctx, id, err.Error())
		return model.AccountActionCandidate{}, err
	}
	return s.updatePendingStatus(ctx, id, model.AccountActionStatusDeleted)
}

func (s *Service) updatePendingStatus(ctx context.Context, id int64, status string) (model.AccountActionCandidate, error) {
	item, err := s.store.UpdatePendingAccountActionCandidateStatus(ctx, id, status)
	if errors.Is(err, sql.ErrNoRows) {
		if _, ok, getErr := s.store.GetAccountActionCandidate(ctx, id); getErr != nil {
			return model.AccountActionCandidate{}, getErr
		} else if ok {
			return model.AccountActionCandidate{}, ErrCandidateNotPending
		}
		return model.AccountActionCandidate{}, ErrCandidateNotFound
	}
	if err != nil {
		return model.AccountActionCandidate{}, err
	}
	return item, nil
}

func (s *Service) resolvePendingCandidateAndSetup(ctx context.Context, id int64) (model.AccountActionCandidate, store.Setup, error) {
	item, setup, err := s.resolveCandidateAndSetup(ctx, id)
	if err != nil {
		return model.AccountActionCandidate{}, store.Setup{}, err
	}
	if item.Status != model.AccountActionStatusPending {
		return model.AccountActionCandidate{}, store.Setup{}, ErrCandidateNotPending
	}
	return item, setup, nil
}

func (s *Service) resolveCandidateAndSetup(ctx context.Context, id int64) (model.AccountActionCandidate, store.Setup, error) {
	item, ok, err := s.store.GetAccountActionCandidate(ctx, id)
	if err != nil {
		return model.AccountActionCandidate{}, store.Setup{}, err
	}
	if !ok {
		return model.AccountActionCandidate{}, store.Setup{}, ErrCandidateNotFound
	}
	setup, ok, err := s.managerConfigService.ResolveSetup(ctx)
	if err != nil {
		return model.AccountActionCandidate{}, store.Setup{}, err
	}
	if !ok || strings.TrimSpace(setup.CPAUpstreamURL) == "" || strings.TrimSpace(setup.ManagementKey) == "" {
		return model.AccountActionCandidate{}, store.Setup{}, errors.New("usage service is not configured")
	}
	return item, setup, nil
}

func (s *Service) verifyCurrentAuthFile(ctx context.Context, setup store.Setup, item model.AccountActionCandidate) (authFile, error) {
	files, err := s.fetchAuthFiles(ctx, setup)
	if err != nil {
		_ = s.store.RecordAccountActionCandidateFailure(ctx, item.ID, err.Error())
		return authFile{}, err
	}
	for _, file := range files {
		if file.Name != item.AuthFileName {
			continue
		}
		if item.AuthIndex != "" && file.AuthIndex != item.AuthIndex {
			continue
		}
		if item.AccountIDSnapshot != "" && file.AccountID != item.AccountIDSnapshot {
			return authFile{}, ErrCandidateConflict
		}
		if item.Provider != "" && !strings.EqualFold(file.Provider, item.Provider) {
			return authFile{}, ErrCandidateConflict
		}
		if item.AccountSnapshot != "" && file.AccountSnapshot != item.AccountSnapshot {
			return authFile{}, ErrCandidateConflict
		}
		return file, nil
	}
	return authFile{}, ErrCandidateConflict
}

func (s *Service) fetchAuthFiles(ctx context.Context, setup store.Setup) ([]authFile, error) {
	base := cpa.NormalizeBaseURL(setup.CPAUpstreamURL)
	paths := []string{"/auth-files", "/v0/management/auth-files"}
	var errs []error
	for _, path := range paths {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+setup.ManagementKey)
		res, err := s.client.Do(req)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(res.Body, 1024*1024))
		res.Body.Close()
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			errs = append(errs, fmt.Errorf("GET %s: %s %s", path, res.Status, strings.TrimSpace(string(body))))
			if shouldFallbackManagement(res.StatusCode) {
				continue
			}
			break
		}
		var decoded any
		decoder := json.NewDecoder(bytes.NewReader(body))
		decoder.UseNumber()
		if err := decoder.Decode(&decoded); err != nil {
			return nil, err
		}
		return authFilesFromJSON(decoded), nil
	}
	return nil, combineEndpointErrors(errs...)
}

func authFilesFromJSON(value any) []authFile {
	switch typed := value.(type) {
	case []any:
		files := make([]authFile, 0, len(typed))
		for _, item := range typed {
			if m, ok := item.(map[string]any); ok {
				files = append(files, authFileFromMap(m))
			}
		}
		return files
	case map[string]any:
		for _, key := range []string{"auth_files", "authFiles", "files", "items", "data"} {
			if child, ok := typed[key]; ok {
				if files := authFilesFromJSON(child); len(files) > 0 {
					return files
				}
			}
		}
		if name := stringField(typed, "name", "file_name", "fileName", "id"); name != "" {
			return []authFile{authFileFromMap(typed)}
		}
	}
	return nil
}

func authFileFromMap(file map[string]any) authFile {
	return authFile{
		Name:            stringField(file, "name", "file_name", "fileName", "id"),
		AuthIndex:       stringField(file, "auth_index", "authIndex", "auth-index"),
		Provider:        strings.ToLower(stringField(file, "provider", "type")),
		AccountSnapshot: stringField(file, "account", "email", "label", "display_account", "displayAccount"),
		AccountID: stringField(
			file,
			"account_id", "accountId", "chatgpt_account_id", "chatgptAccountId",
			"project_id", "projectId", "gemini_virtual_project", "geminiVirtualProject",
			"sub", "id",
		),
		Disabled: boolField(file, "disabled"),
		Raw:      file,
	}
}

func stringField(file map[string]any, keys ...string) string {
	for _, key := range keys {
		if raw, ok := file[key]; ok {
			value := strings.TrimSpace(fmt.Sprint(raw))
			if value != "" && value != "<nil>" {
				return value
			}
		}
	}
	return ""
}

func boolField(file map[string]any, keys ...string) bool {
	for _, key := range keys {
		if raw, ok := file[key]; ok {
			switch value := raw.(type) {
			case bool:
				return value
			case json.Number:
				parsed, _ := strconv.ParseInt(value.String(), 10, 64)
				return parsed != 0
			case float64:
				return value != 0
			case string:
				return strings.EqualFold(value, "true") || value == "1" || strings.EqualFold(value, "disabled") || strings.EqualFold(value, "inactive")
			}
		}
	}
	return false
}

func (s *Service) patchAuthFile(ctx context.Context, setup store.Setup, fileName string, disabled bool) error {
	payload := map[string]any{"name": fileName, "disabled": disabled}
	primaryErr, primaryStatus := s.patchAuthFileAt(ctx, setup, "/auth-files", payload)
	if primaryErr == nil {
		return nil
	}
	statusErr, statusCode := s.patchAuthFileAt(ctx, setup, "/auth-files/status", payload)
	if statusErr == nil {
		return nil
	}
	if shouldFallbackManagement(primaryStatus) && shouldFallbackManagement(statusCode) {
		managementErr, _ := s.patchAuthFileAt(ctx, setup, "/v0/management/auth-files", payload)
		if managementErr == nil {
			return nil
		}
		managementStatusErr, _ := s.patchAuthFileAt(ctx, setup, "/v0/management/auth-files/status", payload)
		if managementStatusErr == nil {
			return nil
		}
		return combineEndpointErrors(primaryErr, statusErr, managementErr, managementStatusErr)
	}
	return combineEndpointErrors(primaryErr, statusErr)
}

func (s *Service) patchAuthFileAt(ctx context.Context, setup store.Setup, path string, payload map[string]any) (error, int) {
	data, err := json.Marshal(payload)
	if err != nil {
		return err, 0
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, cpa.NormalizeBaseURL(setup.CPAUpstreamURL)+path, bytes.NewReader(data))
	if err != nil {
		return err, 0
	}
	req.Header.Set("Content-Type", "application/json")
	return s.doCPAAction(req, setup.ManagementKey)
}

func (s *Service) deleteAuthFile(ctx context.Context, setup store.Setup, fileName string) error {
	primaryErr, primaryStatus := s.deleteAuthFileAt(ctx, setup, "/auth-files", fileName)
	if primaryErr == nil {
		return nil
	}
	if shouldFallbackManagement(primaryStatus) {
		managementErr, _ := s.deleteAuthFileAt(ctx, setup, "/v0/management/auth-files", fileName)
		if managementErr == nil {
			return nil
		}
		return combineEndpointErrors(primaryErr, managementErr)
	}
	return primaryErr
}

func (s *Service) deleteAuthFileAt(ctx context.Context, setup store.Setup, path string, fileName string) (error, int) {
	endpoint := cpa.NormalizeBaseURL(setup.CPAUpstreamURL) + path + "?name=" + url.QueryEscape(fileName)
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
	if err != nil {
		return err, 0
	}
	return s.doCPAAction(req, setup.ManagementKey)
}

func (s *Service) doCPAAction(req *http.Request, managementKey string) (error, int) {
	req.Header.Set("Authorization", "Bearer "+managementKey)
	client := s.client
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return err, 0
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1024*1024))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("%s %s", res.Status, strings.TrimSpace(string(body))), res.StatusCode
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err == nil {
		if failed, ok := payload["failed"].([]any); ok && len(failed) > 0 {
			return fmt.Errorf("CPA action failed: %s", fmt.Sprint(failed[0])), res.StatusCode
		}
	}
	return nil, res.StatusCode
}

func shouldFallbackManagement(status int) bool {
	return status == http.StatusNotFound || status == http.StatusMethodNotAllowed
}

func combineEndpointErrors(errs ...error) error {
	parts := make([]string, 0, len(errs))
	for _, err := range errs {
		if err != nil {
			parts = append(parts, err.Error())
		}
	}
	if len(parts) == 0 {
		return nil
	}
	return errors.New(strings.Join(parts, "; "))
}
