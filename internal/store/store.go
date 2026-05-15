package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// AcceptedStore holds a persistent set of file paths the user has accepted
// (i.e. should no longer appear in duplicate results).
type AcceptedStore struct {
	mu   sync.RWMutex
	set  map[string]struct{}
	file string
}

// Load reads the accepted list from <dataDir>/accepted.json.
// If the file does not exist an empty store is returned without error.
// The dataDir is created if it does not exist.
func Load(dataDir string) (*AcceptedStore, error) {
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, err
	}
	file := filepath.Join(dataDir, "accepted.json")
	s := &AcceptedStore{set: map[string]struct{}{}, file: file}

	data, err := os.ReadFile(file)
	if os.IsNotExist(err) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	var paths []string
	if err := json.Unmarshal(data, &paths); err != nil {
		return nil, err
	}
	for _, p := range paths {
		s.set[p] = struct{}{}
	}
	return s, nil
}

// IsAccepted reports whether path has been accepted.
func (s *AcceptedStore) IsAccepted(path string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.set[path]
	return ok
}

// Add adds paths to the store and persists the updated set atomically.
func (s *AcceptedStore) Add(paths []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range paths {
		s.set[p] = struct{}{}
	}
	return s.save()
}

// save writes the set to disk atomically (temp file + rename).
// Must be called with mu held.
func (s *AcceptedStore) save() error {
	all := make([]string, 0, len(s.set))
	for p := range s.set {
		all = append(all, p)
	}
	data, err := json.Marshal(all)
	if err != nil {
		return err
	}
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}
