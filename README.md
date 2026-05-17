# Deduplicator

A self-hosted Docker application that finds duplicate images and videos in large collections (100k+ files). It uses perceptual hashing (pHash) for images — so it catches resized, re-compressed, or renamed duplicates — and SHA-256 content hashing for videos. The entire UI runs in your browser; no account, no cloud, no data leaves your machine.

---

## Features

- **Perceptual image deduplication** — pHash detects visually identical images regardless of filename, resolution, or minor re-encoding
- **Video deduplication** — byte-identical video files matched by SHA-256 content hash
- **Adjustable similarity threshold** — slider from 0 (exact hash match) to 20 (loosely similar); tune to your taste
- **Byte-identical filter** — one click to show only files that are bit-for-bit identical across formats
- **Folder tree with checkboxes** — pick exactly which directories to scan
- **Regex ignore patterns** — skip thumbnails, caches, or any path pattern
- **Real-time progress** — three-phase WebSocket feed: directory walk → hashing → matching
- **Sortable, filterable results** — sort by filename, file count, or total size; filter by name
- **Full-size media modal** — view images and videos at full resolution with file metadata
- **Touch gestures** — swipe left/right to navigate files within a group, swipe up/down to jump between groups, pinch to zoom, drag to pan
- **Desktop gestures** — same gestures via mouse drag, trackpad two-finger swipe, double-click to zoom, Ctrl+scroll wheel to pinch-zoom
- **Accepted review** — mark duplicates as reviewed; see them later and revert if needed
- **Recycle Bin** — soft-delete duplicates to a configurable bin directory; restore at any time
- **Persistent state** — accepted and bin records survive container restarts via a mounted data volume
- **Single static binary** — Go backend with the UI embedded; no external runtime dependencies

---

## Quick start

### With Docker

```bash
docker build -t deduplicator .

docker run -d \
  --name deduplicator \
  -p 8080:8080 \
  -v /path/to/your/photos:/mnt:ro \
  -v /path/to/data:/data \
  -e DATA_DIR=/data \
  deduplicator

# Open http://localhost:8080
```

### With Docker Compose

Copy `docker-compose.yml`, edit the volume paths, then:

```bash
docker compose up -d
```

### Build from source

Requires Go 1.25+.

```bash
go build -o deduplicator .
MOUNT_ROOT=/path/to/photos ./deduplicator
```

---

## Configuration

All settings are passed as environment variables.

| Variable | Default | Description |
|----------|---------|-------------|
| `MOUNT_ROOT` | `/mnt` | Root directory exposed to the folder browser |
| `PORT` | `8080` | HTTP listen port inside the container |
| `DATA_DIR` | `/data` | Directory for persistent state (accepted list, recycle bin records) |
| `RECYCLE_BIN` | *(unset)* | Absolute path to move trashed files into. When unset, the Recycle Bin feature is hidden. |

> **Tip:** Set `RECYCLE_BIN` to a path inside your `MOUNT_ROOT` volume so the move is atomic. On Synology NAS this is typically the `#recycle` folder inside your photo share.

---

## Supported formats

### Images (perceptual hash)

| Format | Extensions |
|--------|------------|
| JPEG   | `.jpg` `.jpeg` |
| PNG    | `.png` |
| GIF    | `.gif` |
| WebP   | `.webp` |
| TIFF   | `.tiff` `.tif` |
| BMP    | `.bmp` |

### Videos (content hash)

Any file with a video extension is matched by SHA-256 — only byte-identical files are grouped.

| Format | Extensions |
|--------|------------|
| MP4    | `.mp4` |
| MOV    | `.mov` |
| AVI    | `.avi` |
| MKV    | `.mkv` |
| WebM   | `.webm` |
| M4V    | `.m4v` |
| 3GP    | `.3gp` |

---

## How it works

1. **Walk** — recursively lists all files under the selected folders, applying ignore patterns
2. **Hash** — computes pHash (images) or SHA-256 (videos) using `NumCPU × 2` parallel workers
3. **Match** — groups files by exact hash first, then finds near-duplicates within the Hamming distance threshold using a parallel O(n²) comparison

Accepted and bin records are stored as JSON in `DATA_DIR` and loaded on startup.

---

## Performance

Tested on a collection of ~100k mixed files on a Synology NAS (spinning disks):

| Phase | ~100k files | Notes |
|-------|-------------|-------|
| Directory walk | seconds | Single-threaded `WalkDir` |
| pHash hashing | minutes | Disk-I/O bound; uses `NumCPU×2` workers |
| Exact grouping | < 1 s | O(n) hash map |
| Near-duplicate matching | 1–5 s | O(n²) parallel Hamming comparisons |

---

## Tech stack

| Layer | Technology |
|-------|------------|
| Backend | Go, `github.com/corona10/goimagehash`, `github.com/gorilla/websocket` |
| Frontend | Vanilla JS + CSS, no build step |
| Container | Docker multi-stage build (Alpine) |

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
