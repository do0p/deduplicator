package server

import (
	"context"
	"encoding/json"
	"image"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"

	"github.com/dominik/duplicates/internal/matcher"
	"github.com/dominik/duplicates/internal/scanner"
	"github.com/gorilla/websocket"
	"github.com/rwcarlsen/goexif/exif"
	"github.com/rwcarlsen/goexif/tiff"
	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
)

type Server struct {
	mountRoot  string
	state      scanState
	subs       subscribers
	fs         http.Handler
	cancelScan context.CancelFunc
	cancelMu   sync.Mutex
}

type scanState struct {
	mu      sync.RWMutex
	phase   string
	scanned int
	total   int
	results []matcher.DuplicateGroup
	errMsg  string
}

type subscribers struct {
	mu   sync.Mutex
	list []chan scanner.Progress
}

func (s *subscribers) subscribe() chan scanner.Progress {
	ch := make(chan scanner.Progress, 64)
	s.mu.Lock()
	s.list = append(s.list, ch)
	s.mu.Unlock()
	return ch
}

func (s *subscribers) unsubscribe(ch chan scanner.Progress) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, c := range s.list {
		if c == ch {
			s.list = append(s.list[:i], s.list[i+1:]...)
			close(ch)
			return
		}
	}
}

func (s *subscribers) broadcast(p scanner.Progress) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, ch := range s.list {
		select {
		case ch <- p:
		default:
		}
	}
}

var upgrader = websocket.Upgrader{
	// Allow only same-host origins to prevent cross-site WebSocket hijacking.
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // non-browser clients (curl, tests)
		}
		u, err := url.Parse(origin)
		if err != nil {
			return false
		}
		return u.Host == r.Host
	},
}

func New(mountRoot string, webFS http.Handler) *Server {
	return &Server{mountRoot: mountRoot, fs: webFS}
}

func (s *Server) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/browse", s.handleBrowse)
	mux.HandleFunc("POST /api/scan", s.handleScan)
	mux.HandleFunc("POST /api/cancel", s.handleCancel)
	mux.HandleFunc("GET /api/status", s.handleStatus)
	mux.HandleFunc("GET /api/results", s.handleResults)
	mux.HandleFunc("GET /api/image", s.handleImage)
	mux.HandleFunc("GET /api/fileinfo", s.handleFileInfo)
	mux.HandleFunc("GET /ws", s.handleWS)
	mux.Handle("/", s.fs)
}

// safePath validates that the requested path is within mountRoot.
// Relative paths are joined with mountRoot; absolute paths are used as-is.
// Both are then checked to be equal to or under mountRoot.
func (s *Server) safePath(requested string) (string, bool) {
	var full string
	if filepath.IsAbs(requested) {
		full = requested
	} else {
		full = filepath.Join(s.mountRoot, requested)
	}
	clean := filepath.Clean(full)
	root := s.mountRoot + string(filepath.Separator)
	if clean != s.mountRoot && !strings.HasPrefix(clean, root) {
		return "", false
	}
	return clean, true
}

func (s *Server) handleBrowse(w http.ResponseWriter, r *http.Request) {
	reqPath := r.URL.Query().Get("path")
	if reqPath == "" {
		reqPath = s.mountRoot
	}
	safe, ok := s.safePath(reqPath)
	if !ok {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	entries, err := os.ReadDir(safe)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	type entry struct {
		Name  string `json:"name"`
		Path  string `json:"path"`
		IsDir bool   `json:"isDir"`
	}
	var result []entry
	for _, e := range entries {
		result = append(result, entry{
			Name:  e.Name(),
			Path:  filepath.Join(safe, e.Name()),
			IsDir: e.IsDir(),
		})
	}
	writeJSON(w, result)
}

type scanRequest struct {
	Dirs          []string `json:"dirs"`
	IgnoreRegexes []string `json:"ignoreRegexes"`
	Threshold     int      `json:"threshold"`
}

func (s *Server) handleCancel(w http.ResponseWriter, r *http.Request) {
	s.cancelMu.Lock()
	cancel := s.cancelScan
	s.cancelMu.Unlock()
	if cancel != nil {
		cancel()
	}
	w.WriteHeader(http.StatusNoContent)
}

func isBusyPhase(phase string) bool {
	return phase == "walking" || phase == "scanning" || phase == "matching"
}

func (s *Server) handleScan(w http.ResponseWriter, r *http.Request) {
	// Fast pre-check (read lock, avoids parse work when obviously busy).
	s.state.mu.RLock()
	busy := isBusyPhase(s.state.phase)
	s.state.mu.RUnlock()
	if busy {
		http.Error(w, "scan already running", http.StatusConflict)
		return
	}

	var req scanRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	if len(req.Dirs) == 0 {
		http.Error(w, "no directories selected", http.StatusBadRequest)
		return
	}

	// Validate all dirs are within mountRoot.
	var safeDirs []string
	for _, d := range req.Dirs {
		safe, ok := s.safePath(d)
		if !ok {
			http.Error(w, "forbidden path: "+d, http.StatusForbidden)
			return
		}
		safeDirs = append(safeDirs, safe)
	}

	// Deduplicate: remove any dir that is a subdirectory of another selected dir.
	safeDirs = deduplicateDirs(safeDirs)
	log.Printf("scan starting: dirs=%v threshold=%d", safeDirs, req.Threshold)

	var patterns []*regexp.Regexp
	for _, raw := range req.IgnoreRegexes {
		if raw == "" {
			continue
		}
		re, err := regexp.Compile(raw)
		if err != nil {
			http.Error(w, "invalid regex: "+raw, http.StatusBadRequest)
			return
		}
		patterns = append(patterns, re)
	}

	threshold := req.Threshold
	if threshold < 0 {
		threshold = 0
	}

	// Atomically claim the "walking" slot to prevent a TOCTOU race where two
	// concurrent requests both pass the fast pre-check above.
	s.state.mu.Lock()
	if isBusyPhase(s.state.phase) {
		s.state.mu.Unlock()
		http.Error(w, "scan already running", http.StatusConflict)
		return
	}
	s.state.phase = "walking"
	s.state.mu.Unlock()

	w.WriteHeader(http.StatusAccepted)

	go s.runScan(safeDirs, patterns, threshold)
}

func (s *Server) runScan(dirs []string, patterns []*regexp.Regexp, threshold int) {
	ctx, cancel := context.WithCancel(context.Background())

	s.cancelMu.Lock()
	s.cancelScan = cancel
	s.cancelMu.Unlock()

	defer func() {
		cancel()
		s.cancelMu.Lock()
		s.cancelScan = nil
		s.cancelMu.Unlock()
	}()

	progress := make(chan scanner.Progress, 128)

	// Fan out progress to WebSocket subscribers and update shared state.
	go func() {
		for p := range progress {
			s.state.mu.Lock()
			s.state.phase = p.Phase
			s.state.scanned = p.Scanned
			s.state.total = p.Total
			if p.Error != "" {
				s.state.errMsg = p.Error
			}
			s.state.mu.Unlock()
			s.subs.broadcast(p)
		}
	}()

	records, err := scanner.Scan(ctx, dirs, patterns, progress)
	if err != nil {
		if ctx.Err() != nil {
			log.Printf("scan cancelled")
			progress <- scanner.Progress{Phase: "cancelled"}
		} else {
			progress <- scanner.Progress{Phase: "error", Error: err.Error()}
		}
		close(progress)
		return
	}

	log.Printf("matching started: %d records", len(records))
	progress <- scanner.Progress{Phase: "matching", Scanned: len(records), Total: len(records)}

	groups := matcher.FindDuplicates(records, threshold)
	log.Printf("matching complete: %d duplicate groups found", len(groups))

	s.state.mu.Lock()
	s.state.results = groups
	s.state.mu.Unlock()

	doneProgress := scanner.Progress{Phase: "done", Scanned: len(records), Total: len(records)}
	progress <- doneProgress
	close(progress)
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	s.state.mu.RLock()
	defer s.state.mu.RUnlock()
	writeJSON(w, map[string]any{
		"phase":   s.state.phase,
		"scanned": s.state.scanned,
		"total":   s.state.total,
		"error":   s.state.errMsg,
	})
}

func (s *Server) handleResults(w http.ResponseWriter, r *http.Request) {
	s.state.mu.RLock()
	defer s.state.mu.RUnlock()
	if s.state.phase != "done" {
		http.Error(w, "scan not complete", http.StatusConflict)
		return
	}
	writeJSON(w, s.state.results)
}

func (s *Server) handleImage(w http.ResponseWriter, r *http.Request) {
	reqPath := r.URL.Query().Get("path")
	safe, ok := s.safePath(reqPath)
	if !ok {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	// Resolve symlinks before serving: http.ServeFile follows OS-level symlinks,
	// so a symlink inside mountRoot pointing outside would bypass the string
	// prefix check above. Re-validate the real path after resolution.
	real, err := filepath.EvalSymlinks(safe)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if _, ok := s.safePath(real); !ok {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=3600")
	http.ServeFile(w, r, real)
}

// exifCollector implements exif.Walker to gather all EXIF tags into a map.
type exifCollector map[string]string

func (c exifCollector) Walk(name exif.FieldName, tag *tiff.Tag) error {
	s := tag.String()
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		s = s[1 : len(s)-1]
	}
	c[string(name)] = s
	return nil
}

func (s *Server) handleFileInfo(w http.ResponseWriter, r *http.Request) {
	reqPath := r.URL.Query().Get("path")
	safe, ok := s.safePath(reqPath)
	if !ok {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	real, err := filepath.EvalSymlinks(safe)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if _, ok2 := s.safePath(real); !ok2 {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	f, err := os.Open(real)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	cfg, _, _ := image.DecodeConfig(f)
	if _, err := f.Seek(0, 0); err != nil {
		http.Error(w, "seek error", http.StatusInternalServerError)
		return
	}

	var exifData exifCollector
	var lat, lon float64
	hasGPS := false
	if x, err := exif.Decode(f); err == nil {
		exifData = exifCollector{}
		x.Walk(exifData) //nolint:errcheck
		if la, lo, err := x.LatLong(); err == nil {
			lat, lon, hasGPS = la, lo, true
		}
	}

	type response struct {
		Name    string        `json:"name"`
		Folder  string        `json:"folder"`
		Size    int64         `json:"size"`
		ModTime time.Time     `json:"modTime"`
		Width   int           `json:"width,omitempty"`
		Height  int           `json:"height,omitempty"`
		EXIF    exifCollector `json:"exif,omitempty"`
		HasGPS  bool          `json:"hasGPS"`
		Lat     float64       `json:"lat"`
		Lon     float64       `json:"lon"`
	}
	writeJSON(w, response{
		Name:    filepath.Base(real),
		Folder:  filepath.Dir(real),
		Size:    stat.Size(),
		ModTime: stat.ModTime(),
		Width:   cfg.Width,
		Height:  cfg.Height,
		EXIF:    exifData,
		HasGPS:  hasGPS,
		Lat:     lat,
		Lon:     lon,
	})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("ws upgrade:", err)
		return
	}
	defer conn.Close()

	ch := s.subs.subscribe()
	defer s.subs.unsubscribe(ch)

	// Send current state immediately on connect.
	s.state.mu.RLock()
	initial := scanner.Progress{
		Phase:   s.state.phase,
		Scanned: s.state.scanned,
		Total:   s.state.total,
		Error:   s.state.errMsg,
	}
	s.state.mu.RUnlock()
	const wsWriteTimeout = 10 * time.Second

	conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
	if err := conn.WriteJSON(initial); err != nil {
		return
	}

	// Read pump: detects browser disconnect via a failed read so the write
	// loop below exits immediately rather than waiting for the next event.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	for {
		select {
		case <-done:
			return
		case p, ok := <-ch:
			if !ok {
				return
			}
			conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
			if err := conn.WriteJSON(p); err != nil {
				return
			}
			if p.Phase == "done" || p.Phase == "error" || p.Phase == "cancelled" {
				return
			}
		}
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

// deduplicateDirs removes any dir that is a subdirectory of another dir in the list,
// preventing the same files from being scanned twice.
func deduplicateDirs(dirs []string) []string {
	// Sort by path length so parents come before children.
	sort.Slice(dirs, func(i, j int) bool { return len(dirs[i]) < len(dirs[j]) })

	var result []string
	for _, d := range dirs {
		covered := false
		for _, kept := range result {
			if strings.HasPrefix(d, kept+string(filepath.Separator)) || d == kept {
				covered = true
				break
			}
		}
		if !covered {
			result = append(result, d)
		}
	}
	return result
}
