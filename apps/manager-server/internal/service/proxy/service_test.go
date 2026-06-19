package proxy

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/config"
	"github.com/seakee/cpa-manager-plus/apps/manager-server/internal/service/managerconfig"
)

func testProxyErrorWriter(t *testing.T) func(http.ResponseWriter, int, error) {
	t.Helper()
	return func(w http.ResponseWriter, status int, err error) {
		t.Helper()
		if err == nil {
			err = errors.New("proxy error")
		}
		http.Error(w, err.Error(), status)
	}
}

func newTestProxyService(upstreamURL string) *Service {
	manager := managerconfig.New(config.Config{
		CPAUpstreamURL: upstreamURL,
		ManagementKey:  "management-key",
	}, nil, nil)
	return New(manager)
}

func TestProxyManagementCachesAuthFilesList(t *testing.T) {
	authFilesCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v0/management/auth-files" || r.Method != http.MethodGet {
			t.Fatalf("unexpected upstream request %s %s", r.Method, r.URL.String())
		}
		if got := r.Header.Get("Authorization"); got != "Bearer management-key" {
			t.Fatalf("Authorization = %q", got)
		}
		authFilesCalls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"files":[{"name":"codex-a.json","type":"codex"}]}`))
	}))
	t.Cleanup(upstream.Close)

	svc := newTestProxyService(upstream.URL)

	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodGet, "/v0/management/auth-files", nil)
		rr := httptest.NewRecorder()
		svc.ProxyManagement(rr, req, testProxyErrorWriter(t))

		if rr.Code != http.StatusOK {
			t.Fatalf("GET %d status = %d body = %s", i+1, rr.Code, rr.Body.String())
		}
		if !strings.Contains(rr.Body.String(), "codex-a.json") {
			t.Fatalf("GET %d body = %s", i+1, rr.Body.String())
		}
	}

	if authFilesCalls != 1 {
		t.Fatalf("auth files upstream calls = %d, want 1", authFilesCalls)
	}
}

func TestProxyManagementInvalidatesAuthFilesListCacheAfterMutation(t *testing.T) {
	authFilesCalls := 0
	patchCalls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v0/management/auth-files" && r.Method == http.MethodGet:
			authFilesCalls++
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"files":[{"name":"codex-a.json","type":"codex"}]}`))
		case r.URL.Path == "/v0/management/auth-files/fields" && r.Method == http.MethodPatch:
			patchCalls++
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		default:
			t.Fatalf("unexpected upstream request %s %s", r.Method, r.URL.String())
		}
	}))
	t.Cleanup(upstream.Close)

	svc := newTestProxyService(upstream.URL)

	firstGet := httptest.NewRecorder()
	svc.ProxyManagement(firstGet, httptest.NewRequest(http.MethodGet, "/v0/management/auth-files", nil), testProxyErrorWriter(t))
	if firstGet.Code != http.StatusOK {
		t.Fatalf("first GET status = %d body = %s", firstGet.Code, firstGet.Body.String())
	}

	patch := httptest.NewRecorder()
	svc.ProxyManagement(
		patch,
		httptest.NewRequest(http.MethodPatch, "/v0/management/auth-files/fields", strings.NewReader(`{"name":"codex-a.json","priority":5}`)),
		testProxyErrorWriter(t),
	)
	if patch.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d body = %s", patch.Code, patch.Body.String())
	}

	secondGet := httptest.NewRecorder()
	svc.ProxyManagement(secondGet, httptest.NewRequest(http.MethodGet, "/v0/management/auth-files", nil), testProxyErrorWriter(t))
	if secondGet.Code != http.StatusOK {
		t.Fatalf("second GET status = %d body = %s", secondGet.Code, secondGet.Body.String())
	}

	if patchCalls != 1 {
		t.Fatalf("patch calls = %d, want 1", patchCalls)
	}
	if authFilesCalls != 2 {
		t.Fatalf("auth files upstream calls = %d, want 2", authFilesCalls)
	}
}

func TestProxyManagementInvalidationPreventsInflightListFromRefillingCache(t *testing.T) {
	var authFilesCalls int32
	firstListStarted := make(chan struct{})
	releaseFirstList := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/v0/management/auth-files" && r.Method == http.MethodGet:
			call := atomic.AddInt32(&authFilesCalls, 1)
			if call == 1 {
				close(firstListStarted)
				<-releaseFirstList
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprintf(w, `{"files":[{"name":"codex-%d.json","type":"codex"}]}`, call)
		case r.URL.Path == "/v0/management/auth-files/fields" && r.Method == http.MethodPatch:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		default:
			t.Fatalf("unexpected upstream request %s %s", r.Method, r.URL.String())
		}
	}))
	t.Cleanup(upstream.Close)

	svc := newTestProxyService(upstream.URL)

	firstDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		rr := httptest.NewRecorder()
		svc.ProxyManagement(rr, httptest.NewRequest(http.MethodGet, "/v0/management/auth-files", nil), testProxyErrorWriter(t))
		firstDone <- rr
	}()

	select {
	case <-firstListStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("first auth-files request did not reach upstream")
	}

	patch := httptest.NewRecorder()
	svc.ProxyManagement(
		patch,
		httptest.NewRequest(http.MethodPatch, "/v0/management/auth-files/fields", strings.NewReader(`{"name":"codex-a.json","priority":5}`)),
		testProxyErrorWriter(t),
	)
	if patch.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d body = %s", patch.Code, patch.Body.String())
	}

	close(releaseFirstList)
	firstGet := <-firstDone
	if firstGet.Code != http.StatusOK {
		t.Fatalf("first GET status = %d body = %s", firstGet.Code, firstGet.Body.String())
	}

	secondGet := httptest.NewRecorder()
	svc.ProxyManagement(secondGet, httptest.NewRequest(http.MethodGet, "/v0/management/auth-files", nil), testProxyErrorWriter(t))
	if secondGet.Code != http.StatusOK {
		t.Fatalf("second GET status = %d body = %s", secondGet.Code, secondGet.Body.String())
	}
	if !strings.Contains(secondGet.Body.String(), "codex-2.json") {
		t.Fatalf("second GET body = %s, want refreshed auth file list", secondGet.Body.String())
	}
	if got := atomic.LoadInt32(&authFilesCalls); got != 2 {
		t.Fatalf("auth files upstream calls = %d, want 2", got)
	}
}

func TestIsManagementPath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{path: "/v0/management", want: true},
		{path: "/v0/management/", want: true},
		{path: "/v0/management/auth-files", want: true},
		{path: "/v0/management/auth-files/status", want: true},
		{path: "/v0/management/api-call", want: true},
		{path: "/v0/management/api-key-usage", want: true},
		{path: "/v0/resource/plugins", want: true},
		{path: "/v0/resource/plugins/codex-invite/invite", want: true},
		{path: "/v0/resource/plugin", want: false},
		{path: "/v0/resource/plugin-store", want: false},
		{path: "/v1/models", want: false},
		{path: "/models", want: false},
		{path: "/auth-files", want: false},
		{path: "/api-call", want: false},
		{path: "/", want: false},
		{path: "", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := isManagementPath(tt.path); got != tt.want {
				t.Fatalf("isManagementPath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestIsModelListPath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{path: "/v1/models", want: true},
		{path: "/v1/models/", want: true},
		{path: "/models", want: true},
		{path: "/models/", want: true},
		{path: "/v1/chat/completions", want: false},
		{path: "", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := isModelListPath(tt.path); got != tt.want {
				t.Fatalf("isModelListPath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestIsCPAPluginManagementPath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{path: "/v0/management/codex-invite/accounts", want: true},
		{path: "/v0/management/sample-plugin/custom/action", want: true},
		{path: "/v0/management/accounts", want: false},
		{path: "/v0/management/accounts/", want: false},
		{path: "/v0/management/config", want: false},
		{path: "/v0/management/reload", want: false},
		{path: "/v0/management/plugins/demo/custom", want: false},
		{path: "/v0/management/plugin-store/demo/install", want: false},
		{path: "/v0/management/usage", want: false},
		{path: "/v0/resource/plugins/codex-invite/invite", want: false},
		{path: "/v0/management", want: false},
		{path: "/v0/management/", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := IsCPAPluginManagementPath(tt.path); got != tt.want {
				t.Fatalf("IsCPAPluginManagementPath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestIsCPAPluginResourcePath(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		{path: "/v0/resource/plugins", want: true},
		{path: "/v0/resource/plugins/", want: true},
		{path: "/v0/resource/plugins/codex-invite/invite", want: true},
		{path: "/v0/resource/plugins/codex-invite/assets/app.js", want: true},
		{path: "/v0/resource/plugin", want: false},
		{path: "/v0/resource/plugin-store", want: false},
		{path: "/plugins/codex-invite/invite", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := IsCPAPluginResourcePath(tt.path); got != tt.want {
				t.Fatalf("IsCPAPluginResourcePath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestRewriteCodexInviteOrigin(t *testing.T) {
	target, err := url.Parse("http://cpa.local:8317/base")
	if err != nil {
		t.Fatalf("parse target: %v", err)
	}

	header := http.Header{}
	header.Set(codexInviteOriginHeader, "http://manager.local:18317")
	header.Set("Origin", "http://manager.local:18317")

	rewriteCodexInviteOrigin(header, target)

	if got := header.Get(codexInviteOriginHeader); got != "http://cpa.local:8317" {
		t.Fatalf("%s = %q", codexInviteOriginHeader, got)
	}
	if got := header.Get("Origin"); got != "http://manager.local:18317" {
		t.Fatalf("Origin = %q", got)
	}

	emptyHeader := http.Header{}
	rewriteCodexInviteOrigin(emptyHeader, target)
	if got := emptyHeader.Get(codexInviteOriginHeader); got != "" {
		t.Fatalf("empty %s = %q", codexInviteOriginHeader, got)
	}
}

func TestRewritePluginManagementOriginBody(t *testing.T) {
	target, err := url.Parse("http://cpa.local:8317")
	if err != nil {
		t.Fatalf("parse target: %v", err)
	}

	req, err := http.NewRequest(
		http.MethodPost,
		"/v0/management/codex-invite/invite",
		strings.NewReader(`{"management_origin":"http://manager.local:18317","refresh":true}`),
	)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := rewritePluginManagementOriginBody(req, target); err != nil {
		t.Fatalf("rewritePluginManagementOriginBody() error = %v", err)
	}
	raw, err := io.ReadAll(req.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	want := `{"management_origin":"http://cpa.local:8317","refresh":true}`
	if string(raw) != want {
		t.Fatalf("body = %q, want %q", raw, want)
	}
	if req.ContentLength != int64(len(want)) {
		t.Fatalf("content length = %d, want %d", req.ContentLength, len(want))
	}
}

func TestRewritePluginManagementOriginBodyLeavesOtherBodies(t *testing.T) {
	target, err := url.Parse("http://cpa.local:8317")
	if err != nil {
		t.Fatalf("parse target: %v", err)
	}

	req, err := http.NewRequest(http.MethodPost, "/v0/resource/plugins/demo", strings.NewReader(`{"refresh":true}`))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := rewritePluginManagementOriginBody(req, target); err != nil {
		t.Fatalf("rewritePluginManagementOriginBody() error = %v", err)
	}
	raw, err := io.ReadAll(req.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	if string(raw) != `{"refresh":true}` {
		t.Fatalf("body = %q", raw)
	}
}
