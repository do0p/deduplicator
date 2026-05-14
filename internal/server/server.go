package server

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"

	"github.com/dominik/duplicates/internal/matcher"
	"github.com/dominik/duplicates/internal/scanner"
	"github.com/gorilla/websocket"
)

type Server struct {
	mountRoot string
	state     scanState
	subs      subscribers
	fs        http.Handler
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
	CheckOrigin: func(r *http.Request) bool { return true },
}

func New(mountRoot string, webFS http.Handler) *Server {
	return &Server{mountRoot: mountRoot, fs: webFS}
}

func (s *Server) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/browse", s.handleBrowse)
	mux.HandleFunc("POST /api/scan", s.handleScan)
	mux.HandleFunc("GET /api/status", s.handleStatus)
	mux.HandleFunc("GET /api/results", s.handleResults)
	mux.HandleFunc("GET /api/image", s.handleImage)
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

func (s *Server) handleScan(w http.ResponseWriter, r *http.Request) {
	s.state.mu.RLock()
	busy := s.state.phase == "scanning" || s.state.phase == "matching"
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

	// Validate all dirs are within mountRoot
	for _, d := range req.Dirs {
		if _, ok := s.safePath(d); !ok {
			http.Error(w, "forbidden path: "+d, http.StatusForbidden)
			return
		}
	}

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

	w.WriteHeader(http.StatusAccepted)

	go s.runScan(req.Dirs, patterns, threshold)
}

func (s *Server) runScan(dirs []string, patterns []*regexp.Regexp, threshold int) {
	progress := make(chan scanner.Progress, 128)

	// Fan out progress to WebSocket subscribers and update shared state
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

	records, err := scanner.Scan(dirs, patterns, progress)
	if err != nil {
		errProgress := scanner.Progress{Phase: "error", Error: err.Error()}
		progress <- errProgress
		close(progress)
		return
	}

	progress <- scanner.Progress{Phase: "matching", Scanned: len(records), Total: len(records)}

	groups := matcher.FindDuplicates(records, threshold)

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
		http.Error(w, "scan not complete", http.StatusNoContent)
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
	// Serve with cache headers for thumbnails
	w.Header().Set("Cache-Control", "public, max-age=3600")
	http.ServeFile(w, r, safe)
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

	// Send current state immediately on connect
	s.state.mu.RLock()
	initial := scanner.Progress{
		Phase:   s.state.phase,
		Scanned: s.state.scanned,
		Total:   s.state.total,
		Error:   s.state.errMsg,
	}
	s.state.mu.RUnlock()
	if err := conn.WriteJSON(initial); err != nil {
		return
	}

	workers := runtime.NumCPU()
	_ = workers

	for p := range ch {
		if err := conn.WriteJSON(p); err != nil {
			return
		}
		if p.Phase == "done" || p.Phase == "error" {
			return
		}
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
