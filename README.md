# Duplicate Image Finder

A self-contained Docker application that scans large image collections (100k+ files) for visual duplicates using perceptual hashing (pHash), regardless of filename or resolution. Interact via a browser-based UI served by the container.

## Quick start

```bash
docker run -d \
  --name duplicates \
  -p 8080:8080 \
  -v /path/to/your/photos:/mnt:ro \
  192.168.0.84:5050/duplicates:latest

# Open http://localhost:8080
```

Or with docker compose (edit `docker-compose.yml` to set your volume path first):

```bash
docker compose up -d
```

## Build and push

```bash
docker buildx build \
  --platform linux/amd64 \
  --output "type=image,name=192.168.0.84:5050/duplicates:latest,push=true,registry.insecure=true" \
  .
```

## Features

- Folder browser with checkbox selection
- Regex ignore patterns (one per line)
- Adjustable Hamming distance threshold (0 = exact only, 20 = very similar)
- Real-time progress via WebSocket: walking → hashing → matching phases
- Sortable/filterable results table with inline thumbnails and full-size modal
- Supports JPEG, PNG, GIF, WEBP, TIFF, BMP

## Supported image formats

| Format | Extension |
|--------|-----------|
| JPEG   | `.jpg` `.jpeg` |
| PNG    | `.png` |
| GIF    | `.gif` |
| WebP   | `.webp` |
| TIFF   | `.tiff` `.tif` |
| BMP    | `.bmp` |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MOUNT_ROOT` | `/mnt` | Root directory exposed to the UI |
| `PORT` | `8080` | HTTP listen port |

## Performance

| Phase | ~100k files | Notes |
|-------|-------------|-------|
| Directory walk | seconds | Single-threaded `WalkDir` |
| pHash hashing | minutes | Disk-I/O bound; uses `NumCPU×2` workers |
| Exact grouping | <1 s | O(n) hash map |
| Near-dup matching | 1–5 s | O(n²) parallel uint64 Hamming ops |
