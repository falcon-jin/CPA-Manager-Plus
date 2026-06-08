package proxy

import (
	"context"
	"errors"
	"io"
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
}

func New(managerConfigService *managerconfig.Service) *Service {
	return &Service{
		managerConfigService: managerConfigService,
		authFilesCache:       newAuthFilesProxyCache(authFilesListCacheTTL),
	}
}

func (s *Service) ProxyManagement(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error)) {
	s.proxyWithSavedManagementKey(w, r, writeError)
}

func (s *Service) ProxyCPA(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error)) {
	s.proxyWithSavedManagementKey(w, r, writeError)
}

func (s *Service) proxyWithSavedManagementKey(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error)) {
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
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Scheme = target.Scheme
		req.URL.Host = target.Host
		req.Host = target.Host
		req.Header.Set("Authorization", "Bearer "+setup.ManagementKey)
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		writeError(w, http.StatusBadGateway, err)
	}
	proxy.ServeHTTP(w, r)
}

func (s *Service) ProxyModelList(w http.ResponseWriter, r *http.Request, writeError func(http.ResponseWriter, int, error), methodNotAllowed func(http.ResponseWriter)) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
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

func IsModelListPath(path string) bool {
	cleaned := strings.TrimRight(path, "/")
	return cleaned == "/v1/models" || cleaned == "/models"
}

func IsCPAProxyPath(path string) bool {
	cleaned := strings.TrimRight(path, "/")
	if cleaned == "" {
		return false
	}
	if _, ok := exactCPAProxyPaths[cleaned]; ok {
		return true
	}
	for _, prefix := range cpaProxyPathPrefixes {
		if cleaned == prefix || strings.HasPrefix(cleaned, prefix+"/") {
			return true
		}
	}
	return false
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
	return cleaned == "/auth-files" || cleaned == "/v0/management/auth-files"
}

func isAuthFilesMutationRequest(r *http.Request) bool {
	if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
		return false
	}
	cleaned := strings.TrimRight(r.URL.Path, "/")
	return cleaned == "/auth-files" ||
		strings.HasPrefix(cleaned, "/auth-files/") ||
		cleaned == "/v0/management/auth-files" ||
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

var exactCPAProxyPaths = map[string]struct{}{
	"/ampcode":                             {},
	"/api-call":                            {},
	"/api-key-usage":                       {},
	"/api-keys":                            {},
	"/anthropic-auth-url":                  {},
	"/antigravity-auth-url":                {},
	"/claude-api-key":                      {},
	"/codex-api-key":                       {},
	"/codex-auth-url":                      {},
	"/config":                              {},
	"/config.yaml":                         {},
	"/debug":                               {},
	"/force-model-prefix":                  {},
	"/gemini-api-key":                      {},
	"/gemini-cli-auth-url":                 {},
	"/get-auth-status":                     {},
	"/latest-version":                      {},
	"/logging-to-file":                     {},
	"/logs":                                {},
	"/logs-max-total-size-mb":              {},
	"/oauth-callback":                      {},
	"/oauth-excluded-models":               {},
	"/oauth-model-alias":                   {},
	"/openai-compatibility":                {},
	"/proxy-url":                           {},
	"/quota-exceeded/switch-preview-model": {},
	"/quota-exceeded/switch-project":       {},
	"/request-error-logs":                  {},
	"/request-log":                         {},
	"/request-retry":                       {},
	"/routing/strategy":                    {},
	"/vertex-api-key":                      {},
	"/vertex/import":                       {},
	"/ws-auth":                             {},
	"/xai-auth-url":                        {},
}

var cpaProxyPathPrefixes = []string{
	"/ampcode/",
	"/auth-files",
	"/oauth-excluded-models/",
	"/oauth-model-alias/",
	"/request-error-logs",
	"/request-log-by-id",
}

func (s *Service) resolveSetup(ctx context.Context) (store.Setup, bool, error) {
	return s.managerConfigService.ResolveSetup(ctx)
}
