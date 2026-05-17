package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"

	"github.com/do0p/deduplicator/internal/phashcache"
	"github.com/do0p/deduplicator/internal/server"
	"github.com/do0p/deduplicator/internal/store"
)

//go:embed web
var webFiles embed.FS

// version is set at build time via -ldflags "-X main.version=x.y.z".
var version = "dev"

func main() {
	mountRoot := os.Getenv("MOUNT_ROOT")
	if mountRoot == "" {
		mountRoot = "/mnt"
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "/data"
	}
	recycleBin := os.Getenv("RECYCLE_BIN")

	accepted, err := store.Load(dataDir)
	if err != nil {
		log.Fatalf("failed to load accepted store: %v", err)
	}

	pHashCache, err := phashcache.Load(dataDir)
	if err != nil {
		log.Fatalf("failed to load phash cache: %v", err)
	}

	subFS, err := fs.Sub(webFiles, "web")
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	srv := server.New(mountRoot, version, accepted, recycleBin, pHashCache, dataDir, http.FileServer(http.FS(subFS)))
	srv.RegisterRoutes(mux)

	log.Printf("listening on :%s  mount=%s", port, mountRoot)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}
