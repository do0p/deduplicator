package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"

	"github.com/dominik/duplicates/internal/server"
)

//go:embed web
var webFiles embed.FS

func main() {
	mountRoot := os.Getenv("MOUNT_ROOT")
	if mountRoot == "" {
		mountRoot = "/mnt"
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	subFS, err := fs.Sub(webFiles, "web")
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	srv := server.New(mountRoot, http.FileServer(http.FS(subFS)))
	srv.RegisterRoutes(mux)

	log.Printf("listening on :%s  mount=%s", port, mountRoot)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatal(err)
	}
}
