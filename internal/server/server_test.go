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

func TestHandleScan_EmptyDirs(t *testing.T) {
	s := newTestServer("/tmp")
	mux := http.NewServeMux()
	s.RegisterRoutes(mux)

	body := `{"dirs":[],"ignoreRegexes":[],"threshold":10}`
	req := httptest.NewRequest("POST", "/api/scan", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty dirs, got %d", w.Code)
	}
}

// ---- deduplicateDirs ----

func TestDeduplicateDirs_ParentAndChild(t *testing.T) {
	// Child is a subdir of parent — only parent should be kept.
	result := deduplicateDirs([]string{"/mnt/photos", "/mnt/photos/2023"})
	if len(result) != 1 || result[0] != "/mnt/photos" {
		t.Fatalf("expected [/mnt/photos], got %v", result)
	}
}

func TestDeduplicateDirs_ChildBeforeParent(t *testing.T) {
	// Input order is child first — dedup should still keep only the parent.
	result := deduplicateDirs([]string{"/mnt/photos/2023", "/mnt/photos"})
	if len(result) != 1 || result[0] != "/mnt/photos" {
		t.Fatalf("expected [/mnt/photos], got %v", result)
	}
}

func TestDeduplicateDirs_MultipleChildrenSameParent(t *testing.T) {
	result := deduplicateDirs([]string{
		"/mnt/photos",
		"/mnt/photos/2021",
		"/mnt/photos/2022",
		"/mnt/photos/2023",
	})
	if len(result) != 1 || result[0] != "/mnt/photos" {
		t.Fatalf("expected only parent, got %v", result)
	}
}

func TestDeduplicateDirs_IndependentDirs(t *testing.T) {
	// Sibling dirs — neither is a subdir of the other; both must be kept.
	result := deduplicateDirs([]string{"/mnt/photos", "/mnt/videos"})
	if len(result) != 2 {
		t.Fatalf("expected 2 independent dirs, got %v", result)
	}
}

func TestDeduplicateDirs_ExactDuplicate(t *testing.T) {
	// Same path listed twice — deduplicated to one.
	result := deduplicateDirs([]string{"/mnt/photos", "/mnt/photos"})
	if len(result) != 1 {
		t.Fatalf("expected 1 after exact dedup, got %v", result)
	}
}

func TestDeduplicateDirs_PrefixCollision(t *testing.T) {
	// /mnt/photos2 must NOT be treated as a child of /mnt/photos.
	result := deduplicateDirs([]string{"/mnt/photos", "/mnt/photos2"})
	if len(result) != 2 {
		t.Fatalf("/mnt/photos2 must not be deduped as child of /mnt/photos, got %v", result)
	}
}

func TestDeduplicateDirs_Empty(t *testing.T) {
	result := deduplicateDirs(nil)
	if len(result) != 0 {
		t.Fatalf("expected empty result, got %v", result)
	}
}

func TestDeduplicateDirs_MixedDepths(t *testing.T) {
	// Two independent trees plus one child of the first.
	result := deduplicateDirs([]string{
		"/mnt/photos/2023",
		"/mnt/videos",
		"/mnt/photos",
	})
	// Expected: /mnt/photos (covers 2023) + /mnt/videos
	if len(result) != 2 {
		t.Fatalf("expected 2 dirs, got %v", result)
	}
	for _, d := range result {
		if d == "/mnt/photos/2023" {
			t.Fatalf("/mnt/photos/2023 should have been deduped by /mnt/photos, got %v", result)
		}
	}
}
