package phashcache

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
)

type Cache struct {
	mu      sync.RWMutex
	entries map[string]uint64 // sha256 hex → pHash
	path    string
}

func Load(dataDir string) (*Cache, error) {
	c := &Cache{
		entries: make(map[string]uint64),
		path:    filepath.Join(dataDir, "phash_cache.json"),
	}
	data, err := os.ReadFile(c.path)
	if os.IsNotExist(err) {
		return c, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &c.entries); err != nil {
		return nil, err
	}
	log.Printf("phash cache loaded: %d entries", len(c.entries))
	return c, nil
}

func (c *Cache) Get(sha256 string) (uint64, bool) {
	c.mu.RLock()
	v, ok := c.entries[sha256]
	c.mu.RUnlock()
	return v, ok
}

func (c *Cache) Set(sha256 string, hash uint64) {
	c.mu.Lock()
	c.entries[sha256] = hash
	c.mu.Unlock()
}

func (c *Cache) Save() error {
	c.mu.RLock()
	data, err := json.Marshal(c.entries)
	n := len(c.entries)
	c.mu.RUnlock()
	if err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	if err := os.Rename(tmp, c.path); err != nil {
		return err
	}
	log.Printf("phash cache saved: %d entries", n)
	return nil
}
