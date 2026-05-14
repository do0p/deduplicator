package scanner

import (
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/corona10/goimagehash"
	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
)

var imageExts = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true,
	".gif": true, ".webp": true, ".tiff": true,
	".tif": true, ".bmp": true,
}

type FileRecord struct {
	Path    string
	Hash    uint64
	Size    int64
	ModTime time.Time
}

type Progress struct {
	Phase   string `json:"phase"`
	Scanned int    `json:"scanned"`
	Total   int    `json:"total"`
	Error   string `json:"error,omitempty"`
}

func Scan(dirs []string, ignorePatterns []*regexp.Regexp, progress chan<- Progress) ([]FileRecord, error) {
	var paths []string
	for _, dir := range dirs {
		err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				return nil
			}
			ext := strings.ToLower(filepath.Ext(path))
			if !imageExts[ext] {
				return nil
			}
			for _, re := range ignorePatterns {
				if re.MatchString(path) {
					return nil
				}
			}
			info, err := d.Info()
			if err != nil || info.Size() < 1024 {
				return nil
			}
			paths = append(paths, path)
			return nil
		})
		if err != nil {
			log.Printf("walk error in %s: %v", dir, err)
		}
	}

	total := len(paths)
	progress <- Progress{Phase: "scanning", Scanned: 0, Total: total}

	workers := runtime.NumCPU() * 2
	work := make(chan string, workers*4)
	var mu sync.Mutex
	var records []FileRecord
	var scanned atomic.Int64

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for path := range work {
				rec, ok := hashFile(path)
				if !ok {
					scanned.Add(1)
					progress <- Progress{Phase: "scanning", Scanned: int(scanned.Load()), Total: total}
					continue
				}
				mu.Lock()
				records = append(records, rec)
				mu.Unlock()
				n := int(scanned.Add(1))
				progress <- Progress{Phase: "scanning", Scanned: n, Total: total}
			}
		}()
	}

	for _, p := range paths {
		work <- p
	}
	close(work)
	wg.Wait()

	return records, nil
}

func hashFile(path string) (FileRecord, bool) {
	f, err := os.Open(path)
	if err != nil {
		return FileRecord{}, false
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return FileRecord{}, false
	}

	img, _, err := image.Decode(f)
	if err != nil {
		log.Printf("decode error %s: %v", path, err)
		return FileRecord{}, false
	}

	h, err := goimagehash.PerceptionHash(img)
	if err != nil {
		return FileRecord{}, false
	}

	return FileRecord{
		Path:    path,
		Hash:    h.GetHash(),
		Size:    info.Size(),
		ModTime: info.ModTime(),
	}, true
}
