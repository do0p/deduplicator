package scanner

import (
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// createTestPNG writes a 200×200 gradient PNG to dir/name and returns the path.
// The gradient varies per-pixel so PNG compression leaves the file well above 1 KB.
func createTestPNG(t *testing.T, dir, name string, c color.Color) string {
	t.Helper()
	r0, g0, b0, _ := c.RGBA()
	img := image.NewRGBA(image.Rect(0, 0, 200, 200))
	for y := 0; y < 200; y++ {
		for x := 0; x < 200; x++ {
			img.Set(x, y, color.RGBA{
				R: uint8(r0>>8) ^ uint8(x*y&0xff),
				G: uint8(g0>>8) ^ uint8((x+y)&0xff),
				B: uint8(b0>>8) ^ uint8((x^y)&0xff),
				A: 255,
			})
		}
	}
	path := filepath.Join(dir, name)
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestScan_BasicImages(t *testing.T) {
	dir := t.TempDir()
	createTestPNG(t, dir, "a.png", color.RGBA{255, 0, 0, 255})
	createTestPNG(t, dir, "b.png", color.RGBA{0, 255, 0, 255})

	progress := make(chan Progress, 100)
	records, err := Scan([]string{dir}, nil, progress)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 {
		t.Fatalf("expected 2 records, got %d", len(records))
	}
}

func TestScan_SkipsNonImageFiles(t *testing.T) {
	dir := t.TempDir()
	createTestPNG(t, dir, "real.png", color.White)

	// Non-image files that must be skipped.
	for _, name := range []string{"doc.txt", "archive.zip", "data.json"} {
		os.WriteFile(filepath.Join(dir, name), []byte("not an image"), 0644)
	}

	progress := make(chan Progress, 100)
	records, err := Scan([]string{dir}, nil, progress)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("expected 1 record (only the PNG), got %d", len(records))
	}
}

func TestScan_SkipsTinyFiles(t *testing.T) {
	dir := t.TempDir()
	// Write a file with .jpg extension but fewer than 1024 bytes — must be skipped.
	tiny := filepath.Join(dir, "tiny.jpg")
	os.WriteFile(tiny, []byte("tooshort"), 0644)

	createTestPNG(t, dir, "normal.png", color.Black)

	progress := make(chan Progress, 100)
	records, err := Scan([]string{dir}, nil, progress)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("expected 1 record (tiny file skipped), got %d", len(records))
	}
}

func TestScan_IgnorePattern(t *testing.T) {
	dir := t.TempDir()
	createTestPNG(t, dir, "photo.png", color.White)
	createTestPNG(t, dir, "photo_thumb.png", color.Gray{128})

	re := regexp.MustCompile(`_thumb`)
	progress := make(chan Progress, 100)
	records, err := Scan([]string{dir}, []*regexp.Regexp{re}, progress)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("expected 1 record after ignore filter, got %d", len(records))
	}
	if filepath.Base(records[0].Path) != "photo.png" {
		t.Fatalf("expected photo.png, got %s", records[0].Path)
	}
}

func TestScan_MultipleIgnorePatterns(t *testing.T) {
	dir := t.TempDir()
	createTestPNG(t, dir, "keep.png", color.White)
	createTestPNG(t, dir, "skip_thumb.png", color.White)
	createTestPNG(t, dir, "skip_preview.png", color.White)

	patterns := []*regexp.Regexp{
		regexp.MustCompile(`_thumb`),
		regexp.MustCompile(`_preview`),
	}
	progress := make(chan Progress, 100)
	records, err := Scan([]string{dir}, patterns, progress)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("expected 1 record, got %d", len(records))
	}
}

func TestScan_IdenticalImagesHaveSameHash(t *testing.T) {
	dir := t.TempDir()
	// Two files with the exact same pixel content must produce the same pHash.
	createTestPNG(t, dir, "img1.png", color.RGBA{100, 150, 200, 255})
	createTestPNG(t, dir, "img2.png", color.RGBA{100, 150, 200, 255})

	progress := make(chan Progress, 100)
	records, err := Scan([]string{dir}, nil, progress)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 2 {
		t.Fatalf("expected 2 records, got %d", len(records))
	}
	if records[0].Hash != records[1].Hash {
		t.Fatalf("identical images must share a pHash: %016x vs %016x",
			records[0].Hash, records[1].Hash)
	}
}

func TestScan_ProgressPhaseAndCounts(t *testing.T) {
	dir := t.TempDir()
	createTestPNG(t, dir, "a.png", color.White)
	createTestPNG(t, dir, "b.png", color.Black)

	progress := make(chan Progress, 200)
	_, err := Scan([]string{dir}, nil, progress)
	if err != nil {
		t.Fatal(err)
	}
	close(progress)

	var phases []string
	maxScanned := 0
	for p := range progress {
		phases = append(phases, p.Phase)
		if p.Scanned > maxScanned {
			maxScanned = p.Scanned
		}
	}

	if len(phases) == 0 {
		t.Fatal("expected at least one progress event")
	}
	if phases[0] != "scanning" {
		t.Fatalf("first phase should be 'scanning', got %q", phases[0])
	}
	if maxScanned != 2 {
		t.Fatalf("expected max scanned count of 2, got %d", maxScanned)
	}
}
