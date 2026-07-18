package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/store"
)

const authFilesListCacheTTL = 10 * time.Second
const maxCachedAuthFilesListBytes = 64 << 20

type Service struct {
	managerConfigService *managerconfig.Service
	authFilesCache       *authFilesProxyCache
	store                *store.Store
}

type authFileOwnershipMutation struct {
	fileNames []string
	clearAll  bool
}

const cpaPluginResourcePrefix = "/v0/resource/plugins"
const cpaManagementPrefix = "/v0/management"
const codexInviteOriginHeader = "X-Codex-Invite-Origin"
const managementOriginJSONField = "management_origin"

const maxAuthFileMutationRequestBytes int64 = 10*1024*1024 + 64*1024
const maxAuthFileMutationResponseBytes int64 = 1024 * 1024

var errAuthFileMutationBodyTooLarge = errors.New("auth file mutation body is too large")

var cpaBuiltinManagementPathHeads = map[string]struct{}{
	"account-action-candidates": {},
	"accounts":                  {},
	"api-call":                  {},
	"api-key-aliases":           {},
	"api-key-usage":             {},
	"auth-files":                {},
	"codex-inspection":          {},
	"config":                    {},
	"dashboard":                 {},
	"model-prices":              {},
	"monitoring":                {},
	"plugin-store":              {},
	"plugins":                   {},
	"reload":                    {},
	"usage":                     {},
	"usage-statistics-enabled":  {},
}

func New(managerConfigService *managerconfig.Service, stores ...*store.Store) *Service {
	service := &Service{
		managerConfigService: managerConfigService,
		authFilesCache:       newAuthFilesProxyCache(authFilesListCacheTTL),
	}
	if len(stores) > 0 {
		service.store = stores[0]
	}
	return service
}

func (s *Service) ProxyManagement(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error)) {
	s.proxyWithSavedManagementKey(w, r, writeError)
}

func (s *Service) ProxyPluginManagement(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error)) {
	if !IsCPAPluginManagementPath(r.URL.Path) {
		writeError(w, http.StatusNotFound, errors.New("proxy path must be a CPA plugin management path"))
		return
	}
	s.proxyToSavedSetup(w, r, writeError, true, true)
}

func (s *Service) ProxyPluginManagementWithCallerAuth(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error)) {
	if !IsCPAPluginManagementPath(r.URL.Path) {
		writeError(w, http.StatusNotFound, errors.New("proxy path must be a CPA plugin management path"))
		return
	}
	s.proxyToSavedSetup(w, r, writeError, false, true)
}

func (s *Service) ProxyPluginResource(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error)) {
	if !IsCPAPluginResourcePath(r.URL.Path) {
		writeError(w, http.StatusNotFound, errors.New("proxy path must be under /v0/resource/plugins/"))
		return
	}
	s.proxyToSavedSetup(w, r, writeError, true, true)
}

func (s *Service) ProxyPluginResourceWithCallerAuth(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error)) {
	if !IsCPAPluginResourcePath(r.URL.Path) {
		writeError(w, http.StatusNotFound, errors.New("proxy path must be under /v0/resource/plugins/"))
		return
	}
	s.proxyToSavedSetup(w, r, writeError, false, true)
}

func (s *Service) proxyWithSavedManagementKey(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error)) {
	if !isManagementPath(r.URL.Path) {
		writeError(w, http.StatusNotFound, errors.New("proxy path must be under /v0/management/"))
		return
	}
	s.proxyToSavedSetup(w, r, writeError, true, false)
}

func (s *Service) proxyToSavedSetup(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error), useSavedManagementKey bool, rewritePluginOrigin bool) {
	setup, ok, err := s.resolveSetup(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if !ok {
		writeError(w, http.StatusPreconditionRequired, errors.New("usage service is not configured"))
		return
	}
	if isAuthFilesListRequest(r) {
		s.proxyAuthFilesListWithCache(w, r, setup, writeError)
		return
	}
	if isAuthFilesMutationRequest(r) {
		s.authFilesCache.clear()
	}
	target, err := url.Parse(setup.CPAUpstreamURL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if rewritePluginOrigin {
		if err := rewritePluginManagementOriginBody(r, target); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
	}
	ownershipMutation, err := inspectAuthFileOwnershipMutation(r)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, errAuthFileMutationBodyTooLarge) {
			status = http.StatusRequestEntityTooLarge
		}
		writeError(w, status, err)
		return
	}
	persistCtx := context.WithoutCancel(r.Context())
	revokedOwnership, err := s.revokeInspectionOwnership(persistCtx, ownershipMutation)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if ownershipMutation.clearAll {
		ownershipMutation.fileNames = ownershipFileNames(revokedOwnership)
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Scheme = target.Scheme
		req.URL.Host = target.Host
		req.Host = target.Host
		if useSavedManagementKey {
			req.Header.Set("Authorization", "Bearer "+setup.ManagementKey)
		}
		if rewritePluginOrigin {
			rewriteCodexInviteOrigin(req.Header, target)
		}
		if ownershipMutation.clearAll || len(ownershipMutation.fileNames) > 0 {
			req.Header.Set("Accept-Encoding", "identity")
		}
	}
	responseProcessed := false
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
		if !responseProcessed {
			if restoreErr := s.restoreInspectionOwnership(persistCtx, revokedOwnership); restoreErr != nil {
				proxyErr = fmt.Errorf("%w; restore inspection ownership: %v", proxyErr, restoreErr)
			}
		}
		writeError(w, http.StatusBadGateway, proxyErr)
	}
	proxy.ModifyResponse = func(response *http.Response) error {
		responseProcessed = true
		if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
			return s.restoreInspectionOwnership(persistCtx, revokedOwnership)
		}
		mutation, err := successfulAuthFileOwnershipMutation(response, ownershipMutation)
		if err != nil {
			if restoreErr := s.restoreInspectionOwnership(persistCtx, revokedOwnership); restoreErr != nil {
				return fmt.Errorf("%w; restore inspection ownership: %v", err, restoreErr)
			}
			return err
		}
		return s.restoreInspectionOwnership(persistCtx, ownershipItemsNotMutated(revokedOwnership, mutation))
	}
	proxy.ServeHTTP(w, r)
}

func (s *Service) revokeInspectionOwnership(ctx context.Context, mutation authFileOwnershipMutation) ([]store.CodexInspectionDisableOwnership, error) {
	if s.store == nil || (!mutation.clearAll && len(mutation.fileNames) == 0) {
		return nil, nil
	}
	return s.store.RevokeCodexInspectionDisableOwnership(ctx, mutation.fileNames, mutation.clearAll)
}

func (s *Service) restoreInspectionOwnership(ctx context.Context, items []store.CodexInspectionDisableOwnership) error {
	if s.store == nil || len(items) == 0 {
		return nil
	}
	return s.store.RestoreCodexInspectionDisableOwnership(ctx, items)
}

func inspectAuthFileOwnershipMutation(r *http.Request) (authFileOwnershipMutation, error) {
	if r == nil {
		return authFileOwnershipMutation{}, nil
	}
	path := strings.TrimRight(r.URL.Path, "/")
	if path != "/v0/management/auth-files" && path != "/v0/management/auth-files/status" {
		return authFileOwnershipMutation{}, nil
	}

	switch r.Method {
	case http.MethodPatch:
		fileNames, err := readJSONAuthFileNames(r)
		return authFileOwnershipMutation{fileNames: fileNames}, err
	case http.MethodDelete:
		if strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("all")), "true") {
			return authFileOwnershipMutation{clearAll: true}, nil
		}
		fileNames := normalizeFileNames([]string{r.URL.Query().Get("name")})
		if len(fileNames) > 0 {
			return authFileOwnershipMutation{fileNames: fileNames}, nil
		}
		fileNames, err := readJSONAuthFileNames(r)
		return authFileOwnershipMutation{fileNames: fileNames}, err
	case http.MethodPost:
		fileNames, err := readMultipartAuthFileNames(r)
		return authFileOwnershipMutation{fileNames: fileNames}, err
	default:
		return authFileOwnershipMutation{}, nil
	}
}

func readJSONAuthFileNames(r *http.Request) ([]string, error) {
	if r.Body == nil {
		return nil, nil
	}
	raw, err := readAndRestoreRequestBody(r, maxAuthFileMutationRequestBytes)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Name  string   `json:"name"`
		Names []string `json:"names"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, nil
	}
	return normalizeFileNames(append(payload.Names, payload.Name)), nil
}

func readMultipartAuthFileNames(r *http.Request) ([]string, error) {
	if r.Body == nil {
		return nil, nil
	}
	_, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || params["boundary"] == "" {
		return nil, nil
	}
	raw, err := readAndRestoreRequestBody(r, maxAuthFileMutationRequestBytes)
	if err != nil {
		return nil, err
	}
	reader := multipart.NewReader(bytes.NewReader(raw), params["boundary"])
	fileNames := make([]string, 0)
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		fileNames = append(fileNames, part.FileName())
		_ = part.Close()
	}
	return normalizeFileNames(fileNames), nil
}

func successfulAuthFileOwnershipMutation(response *http.Response, mutation authFileOwnershipMutation) (authFileOwnershipMutation, error) {
	if response == nil || response.Body == nil || (!mutation.clearAll && len(mutation.fileNames) == 0) {
		return mutation, nil
	}
	contentEncoding := strings.ToLower(strings.TrimSpace(response.Header.Get("Content-Encoding")))
	if contentEncoding != "" && contentEncoding != "identity" {
		return authFileOwnershipMutation{}, fmt.Errorf("unsupported auth file mutation response encoding %q", contentEncoding)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxAuthFileMutationResponseBytes+1))
	if err != nil {
		return authFileOwnershipMutation{}, err
	}
	if int64(len(raw)) > maxAuthFileMutationResponseBytes {
		return authFileOwnershipMutation{}, errAuthFileMutationBodyTooLarge
	}
	response.Body.Close()
	response.Body = io.NopCloser(bytes.NewReader(raw))
	response.ContentLength = int64(len(raw))

	var payload struct {
		Status   string   `json:"status"`
		Deleted  *int     `json:"deleted"`
		Uploaded *int     `json:"uploaded"`
		Files    []string `json:"files"`
		Failed   []struct {
			Name string `json:"name"`
		} `json:"failed"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return mutation, nil
	}
	status := strings.ToLower(strings.TrimSpace(payload.Status))
	if status == "error" || status == "failed" ||
		(payload.Deleted != nil && *payload.Deleted <= 0) ||
		(payload.Uploaded != nil && *payload.Uploaded <= 0) {
		return authFileOwnershipMutation{}, nil
	}
	if fileNames := normalizeFileNames(payload.Files); len(fileNames) > 0 {
		return authFileOwnershipMutation{fileNames: fileNames}, nil
	}
	failed := make(map[string]struct{}, len(payload.Failed))
	for _, item := range payload.Failed {
		if fileName := strings.TrimSpace(item.Name); fileName != "" {
			failed[fileName] = struct{}{}
		}
	}
	if len(failed) == 0 {
		return mutation, nil
	}
	succeeded := make([]string, 0, len(mutation.fileNames))
	for _, fileName := range mutation.fileNames {
		if _, ok := failed[fileName]; !ok {
			succeeded = append(succeeded, fileName)
		}
	}
	return authFileOwnershipMutation{fileNames: succeeded}, nil
}

func ownershipFileNames(items []store.CodexInspectionDisableOwnership) []string {
	fileNames := make([]string, 0, len(items))
	for _, item := range items {
		fileNames = append(fileNames, item.FileName)
	}
	return normalizeFileNames(fileNames)
}

func ownershipItemsNotMutated(items []store.CodexInspectionDisableOwnership, mutation authFileOwnershipMutation) []store.CodexInspectionDisableOwnership {
	if mutation.clearAll {
		return nil
	}
	succeeded := make(map[string]struct{}, len(mutation.fileNames))
	for _, fileName := range mutation.fileNames {
		succeeded[fileName] = struct{}{}
	}
	result := make([]store.CodexInspectionDisableOwnership, 0, len(items))
	for _, item := range items {
		if _, ok := succeeded[item.FileName]; !ok {
			result = append(result, item)
		}
	}
	return result
}

func readAndRestoreRequestBody(r *http.Request, limit int64) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if errClose := r.Body.Close(); errClose != nil {
		return nil, errClose
	}
	if int64(len(raw)) > limit {
		return nil, errAuthFileMutationBodyTooLarge
	}
	restoreRequestBody(r, raw)
	return raw, nil
}

func normalizeFileNames(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		fileName := strings.TrimSpace(value)
		if fileName == "" {
			continue
		}
		if _, ok := seen[fileName]; ok {
			continue
		}
		seen[fileName] = struct{}{}
		result = append(result, fileName)
	}
	return result
}

func restoreRequestBody(r *http.Request, body []byte) {
	r.Body = io.NopCloser(bytes.NewReader(body))
	r.ContentLength = int64(len(body))
	bodyCopy := append([]byte(nil), body...)
	r.GetBody = func() (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(bodyCopy)), nil
	}
}

func rewriteCodexInviteOrigin(header http.Header, target *url.URL) {
	if header == nil || target == nil || header.Get(codexInviteOriginHeader) == "" {
		return
	}
	origin := target.Scheme + "://" + target.Host
	if origin == "://" {
		return
	}
	header.Set(codexInviteOriginHeader, origin)
}

func rewritePluginManagementOriginBody(r *http.Request, target *url.URL) error {
	if r == nil || r.Body == nil || target == nil || !isJSONContentType(r.Header.Get("Content-Type")) {
		return nil
	}
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	if errClose := r.Body.Close(); errClose != nil {
		return errClose
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		restoreRequestBody(r, raw)
		return nil
	}

	var payload map[string]json.RawMessage
	if errUnmarshal := json.Unmarshal(raw, &payload); errUnmarshal != nil {
		restoreRequestBody(r, raw)
		return nil
	}
	if _, ok := payload[managementOriginJSONField]; !ok {
		restoreRequestBody(r, raw)
		return nil
	}
	origin := target.Scheme + "://" + target.Host
	if origin == "://" {
		restoreRequestBody(r, raw)
		return nil
	}
	encodedOrigin, errMarshal := json.Marshal(origin)
	if errMarshal != nil {
		restoreRequestBody(r, raw)
		return errMarshal
	}
	payload[managementOriginJSONField] = encodedOrigin
	next, errMarshal := json.Marshal(payload)
	if errMarshal != nil {
		restoreRequestBody(r, raw)
		return errMarshal
	}
	restoreRequestBody(r, next)
	return nil
}

func isJSONContentType(value string) bool {
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(value, ";")[0]))
	return contentType == "application/json" || strings.HasSuffix(contentType, "+json")
}

func (s *Service) ProxyModelList(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error), methodNotAllowed func(http.ResponseWriter)) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	if !isModelListPath(r.URL.Path) {
		writeError(w, http.StatusNotFound, errors.New("model list proxy path must be /v1/models"))
		return
	}
	setup, ok, err := s.resolveSetup(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if !ok {
		writeError(w, http.StatusPreconditionRequired, errors.New("usage service is not configured"))
		return
	}
	target, err := url.Parse(setup.CPAUpstreamURL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Scheme = target.Scheme
		req.URL.Host = target.Host
		req.Host = target.Host
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		writeError(w, http.StatusBadGateway, err)
	}
	proxy.ServeHTTP(w, r)
}

func isModelListPath(path string) bool {
	cleaned := strings.TrimRight(path, "/")
	return cleaned == "/v1/models" || cleaned == "/models"
}

func isManagementPath(path string) bool {
	if isStrictManagementPath(path) {
		return true
	}
	return IsCPAPluginResourcePath(path)
}

type authFilesProxyCache struct {
	ttl      time.Duration
	mu       sync.Mutex
	entries  map[string]authFilesProxyCacheEntry
	inFlight map[string]*authFilesProxyCacheCall
	version  uint64
}

type authFilesProxyCacheEntry struct {
	statusCode int
	header     http.Header
	body       []byte
	expiresAt  time.Time
}

type authFilesProxyCacheCall struct {
	done  chan struct{}
	entry authFilesProxyCacheEntry
	err   error
}

func newAuthFilesProxyCache(ttl time.Duration) *authFilesProxyCache {
	return &authFilesProxyCache{
		ttl:      ttl,
		entries:  make(map[string]authFilesProxyCacheEntry),
		inFlight: make(map[string]*authFilesProxyCacheCall),
	}
}

func (c *authFilesProxyCache) getOrFetch(
	key string,
	fetch func() (authFilesProxyCacheEntry, error),
) (authFilesProxyCacheEntry, error) {
	now := time.Now()
	c.mu.Lock()
	if entry, ok := c.entries[key]; ok && now.Before(entry.expiresAt) {
		c.mu.Unlock()
		return cloneAuthFilesProxyCacheEntry(entry), nil
	}
	if call := c.inFlight[key]; call != nil {
		c.mu.Unlock()
		<-call.done
		if call.err != nil {
			return authFilesProxyCacheEntry{}, call.err
		}
		return cloneAuthFilesProxyCacheEntry(call.entry), nil
	}

	call := &authFilesProxyCacheCall{done: make(chan struct{})}
	c.inFlight[key] = call
	version := c.version
	c.mu.Unlock()

	entry, err := fetch()

	c.mu.Lock()
	if err == nil &&
		version == c.version &&
		entry.statusCode >= http.StatusOK &&
		entry.statusCode < http.StatusMultipleChoices {
		entry.expiresAt = time.Now().Add(c.ttl)
		c.entries[key] = cloneAuthFilesProxyCacheEntry(entry)
	}
	call.entry = entry
	call.err = err
	delete(c.inFlight, key)
	close(call.done)
	c.mu.Unlock()

	if err != nil {
		return authFilesProxyCacheEntry{}, err
	}
	return cloneAuthFilesProxyCacheEntry(entry), nil
}

func (c *authFilesProxyCache) clear() {
	c.mu.Lock()
	c.entries = make(map[string]authFilesProxyCacheEntry)
	c.inFlight = make(map[string]*authFilesProxyCacheCall)
	c.version++
	c.mu.Unlock()
}

func cloneAuthFilesProxyCacheEntry(entry authFilesProxyCacheEntry) authFilesProxyCacheEntry {
	return authFilesProxyCacheEntry{
		statusCode: entry.statusCode,
		header:     entry.header.Clone(),
		body:       append([]byte(nil), entry.body...),
		expiresAt:  entry.expiresAt,
	}
}

func (s *Service) proxyAuthFilesListWithCache(
	w http.ResponseWriter,
	r *http.Request,
	setup store.Setup,
	writeError func(http.ResponseWriter, int, error),
) {
	key := authFilesListCacheKey(setup, r)
	entry, err := s.authFilesCache.getOrFetch(key, func() (authFilesProxyCacheEntry, error) {
		return fetchAuthFilesList(r, setup)
	})
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeAuthFilesCachedResponse(w, entry)
}

func fetchAuthFilesList(r *http.Request, setup store.Setup) (authFilesProxyCacheEntry, error) {
	upstream, err := url.Parse(setup.CPAUpstreamURL)
	if err != nil {
		return authFilesProxyCacheEntry{}, err
	}
	targetURL := *upstream
	targetURL.Path = singleJoiningSlash(upstream.Path, r.URL.Path)
	targetURL.RawPath = ""
	targetURL.RawQuery = r.URL.RawQuery

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, targetURL.String(), nil)
	if err != nil {
		return authFilesProxyCacheEntry{}, err
	}
	copyProxyRequestHeaders(req.Header, r.Header)
	req.Header.Set("Authorization", "Bearer "+setup.ManagementKey)
	req.Host = upstream.Host

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return authFilesProxyCacheEntry{}, err
	}
	defer res.Body.Close()

	body, err := io.ReadAll(io.LimitReader(res.Body, maxCachedAuthFilesListBytes+1))
	if err != nil {
		return authFilesProxyCacheEntry{}, err
	}
	if len(body) > maxCachedAuthFilesListBytes {
		return authFilesProxyCacheEntry{}, errors.New("auth files response is too large to cache")
	}

	header := cloneProxyResponseHeader(res.Header)
	header.Set("Content-Length", strconv.Itoa(len(body)))

	return authFilesProxyCacheEntry{
		statusCode: res.StatusCode,
		header:     header,
		body:       body,
	}, nil
}

func writeAuthFilesCachedResponse(w http.ResponseWriter, entry authFilesProxyCacheEntry) {
	for key, values := range entry.header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(entry.statusCode)
	_, _ = w.Write(entry.body)
}

func authFilesListCacheKey(setup store.Setup, r *http.Request) string {
	return setup.CPAUpstreamURL + "\x00" + setup.ManagementKey + "\x00" + r.URL.Path + "?" + r.URL.RawQuery
}

func isAuthFilesListRequest(r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}
	cleaned := strings.TrimRight(r.URL.Path, "/")
	return cleaned == "/v0/management/auth-files"
}

func isAuthFilesMutationRequest(r *http.Request) bool {
	if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
		return false
	}
	cleaned := strings.TrimRight(r.URL.Path, "/")
	return cleaned == "/v0/management/auth-files" ||
		strings.HasPrefix(cleaned, "/v0/management/auth-files/")
}

func singleJoiningSlash(left, right string) string {
	leftSlash := strings.HasSuffix(left, "/")
	rightSlash := strings.HasPrefix(right, "/")
	switch {
	case leftSlash && rightSlash:
		return left + right[1:]
	case !leftSlash && !rightSlash:
		return left + "/" + right
	default:
		return left + right
	}
}

func copyProxyRequestHeaders(dst, src http.Header) {
	for key, values := range src {
		if isHopByHopHeader(key) || strings.EqualFold(key, "Authorization") {
			continue
		}
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}

func cloneProxyResponseHeader(src http.Header) http.Header {
	header := make(http.Header, len(src))
	for key, values := range src {
		if isHopByHopHeader(key) {
			continue
		}
		for _, value := range values {
			header.Add(key, value)
		}
	}
	return header
}

func isHopByHopHeader(key string) bool {
	switch strings.ToLower(key) {
	case "connection",
		"keep-alive",
		"proxy-authenticate",
		"proxy-authorization",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade":
		return true
	default:
		return false
	}
}

func isStrictManagementPath(path string) bool {
	return path == "/v0/management" || strings.HasPrefix(path, "/v0/management/")
}

func IsCPAPluginManagementPath(path string) bool {
	cleaned := strings.TrimRight(path, "/")
	if !strings.HasPrefix(cleaned, cpaManagementPrefix+"/") {
		return false
	}
	rest := strings.TrimPrefix(cleaned, cpaManagementPrefix+"/")
	head, _, _ := strings.Cut(rest, "/")
	if head == "" {
		return false
	}
	_, reserved := cpaBuiltinManagementPathHeads[head]
	return !reserved
}

func IsCPAPluginResourcePath(path string) bool {
	cleaned := strings.TrimRight(path, "/")
	return cleaned == cpaPluginResourcePrefix || strings.HasPrefix(cleaned, cpaPluginResourcePrefix+"/")
}

func (s *Service) resolveSetup(ctx context.Context) (store.Setup, bool, error) {
	return s.managerConfigService.ResolveSetup(ctx)
}
