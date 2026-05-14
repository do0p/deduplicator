package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestServer(mountRoot string) *Server {
	return New(mountRoot, http.NotFoundHandler())
}

// ---- safePath ----

func TestSafePath_ValidSubdir(t *testing.T) {
	s := newTestServer("/mnt")
	got, ok := s.safePath("/mnt/photos")
	if !ok {
		t.Fatal("expected ok for valid subdir")
	}
	if got != "/mnt/photos" {
		t.Fatalf("unexpected path: %s", got)
	}
}

func TestSafePath_ExactRoot(t *testing.T) {
	s := newTestServer("/mnt")
	_, ok := s.safePath("/mnt")
	if !ok {
		t.Fatal("expected ok for exact mount root")
	}
}

func TestSafePath_TraversalDotDot(t *testing.T) {
	s := newTestServer("/mnt")
	_, ok := s.safePath("../../etc/passwd")
	if ok {
		t.Fatal("expected rejection for path traversal with ..")
	}
}

func TestSafePath_TraversalAbsolute(t *testing.T) {
	s := newTestServer("/mnt")
	_, ok := s.safePath("/etc/passwd")
	if ok {
		t.Fatal("expected rejection for absolute path outside mount root")
	}
}

func TestSafePath_TraversalMidPath(t *testing.T) {
	s := newTestServer("/mnt")
	_, ok := s.safePath("/mnt/../etc/passwd")
	if ok {
		t.Fatal("expected rejection for /mnt/../etc/passwd")
	}
}

func TestSafePath_PrefixCollision(t *testing.T) {
	// /mntother must not be accepted when mountRoot is /mnt.
	s := newTestServer("/mnt")
	_, ok := s.safePath("/mntother/secret")
	if ok {
		t.Fatal("expected rejection for sibling dir /mntother — prefix collision bug")
	}
}

func TestSafePath_DeepNested(t *testing.T) {
	s := newTestServer("/mnt")
	_, ok := s.safePath("/mnt/a/b/c/d/image.jpg")
	if !ok {
		t.Fatal("expected ok for deeply nested path")
	}
}

// ---- HTTP handler security ----

func TestHandleImage_PathTraversal(t *testing.T) {
	s := newTestServer("/mnt")
	mux := http.NewServeMux()
	s.RegisterRoutes(mux)

	req := httptest.NewRequest("GET", "/api/image?path=../../etc/passwd", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for path traversal, got %d", w.Code)
	}
}

func TestHandleImage_PrefixCollision(t *testing.T) {
	s := newTestServer("/mnt")
	mux := http.NewServeMux()
	s.RegisterRoutes(mux)

	req := httptest.NewRequest("GET", "/api/image?path=/mntother/secret.jpg", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for sibling mount path, got %d", w.Code)
	}
}

func TestHandleBrowse_PathTraversal(t *testing.T) {
	s := newTestServer("/mnt")
	mux := http.NewServeMux()
	s.RegisterRoutes(mux)

	req := httptest.NewRequest("GET", "/api/browse?path=../../etc", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for browse path traversal, got %d", w.Code)
	}
}

func TestHandleScan_InvalidRegex(t *testing.T) {
	s := newTestServer("/tmp")
	mux := http.NewServeMux()
	s.RegisterRoutes(mux)

	body := `{"dirs":["/tmp"],"ignoreRegexes":["[invalid"],"threshold":10}`
	req := httptest.NewRequest("POST", "/api/scan", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid regex, got %d", w.Code)
	}
}

func TestHandleScan_ForbiddenDir(t *testing.T) {
	s := newTestServer("/mnt")
	mux := http.NewServeMux()
	s.RegisterRoutes(mux)

	body := `{"dirs":["/etc"],"ignoreRegexes":[],"threshold":10}`
	req := httptest.NewRequest("POST", "/api/scan", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for dir outside mount root, got %d", w.Code)
	}
}
