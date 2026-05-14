package scanner

import (
	"context"
	"fmt"
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
	records, err := Scan(context.Background(), []string{dir}, nil, progress)
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
	records, err := Scan(context.Background(), []string{dir}, nil, progress)
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
	records, err := Scan(context.Background(), []string{dir}, nil, progress)
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
	records, err := Scan(context.Background(), []string{dir}, []*regexp.Regexp{re}, progress)
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

func TestScan_IgnorePatternSkipsDirectory(t *testing.T) {
	// The ignore pattern must cause WalkDir to skip the entire matching
	// directory, not just filter its files after entering it.
	dir := t.TempDir()
	createTestPNG(t, dir, "keep.png", color.White)

	// Create a subdirectory whose name matches the ignore pattern.
	skipDir := filepath.Join(dir, "@eaDir")
	if err := os.Mkdir(skipDir, 0755); err != nil {
		t.Fatal(err)
	}
	createTestPNG(t, skipDir, "thumb.png", color.White)

	re := regexp.MustCompile(`@eaDir`)
	progress := make(chan Progress, 100)
	records, err := Scan(context.Background(), []string{dir}, []*regexp.Regexp{re}, progress)
	if err != nil {
		t.Fatal(err)
	}
	if len(records) != 1 {
		t.Fatalf("expected 1 record (directory skipped entirely), got %d", len(records))
	}
	if filepath.Base(records[0].Path) != "keep.png" {
		t.Fatalf("expected keep.png, got %s", records[0].Path)
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
	records, err := Scan(context.Background(), []string{dir}, patterns, progress)
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
	records, err := Scan(context.Background(), []string{dir}, nil, progress)
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
	_, err := Scan(context.Background(), []string{dir}, nil, progress)
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
	if phases[0] != "walking" {
		t.Fatalf("first phase should be 'walking', got %q", phases[0])
	}
	hasScanningPhase := false
	for _, ph := range phases {
		if ph == "scanning" {
			hasScanningPhase = true
			break
		}
	}
	if !hasScanningPhase {
		t.Fatal("expected at least one 'scanning' phase event")
	}
	if maxScanned != 2 {
		t.Fatalf("expected max scanned count of 2, got %d", maxScanned)
	}
}

// TestAncestorInodes_ContainsAllLevels verifies that ancestorInodes includes the
// directory itself and each ancestor up to the filesystem root.
func TestAncestorInodes_ContainsAllLevels(t *testing.T) {
	// t.TempDir() returns something like /tmp/TestXxx123/001; its parent (/tmp/TestXxx123)
	// and grandparent (/tmp) must also appear in the set.
	dir := t.TempDir()

	visited, err := ancestorInodes(dir)
	if err != nil {
		t.Fatal(err)
	}

	// dir itself
	selfKey, err := dirInode(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !visited[selfKey] {
		t.Fatalf("ancestorInodes: dir %s not in set", dir)
	}

	// parent
	parentKey, err := dirInode(filepath.Dir(dir))
	if err != nil {
		t.Fatal(err)
	}
	if !visited[parentKey] {
		t.Fatalf("ancestorInodes: parent of %s not in set", dir)
	}

	// grandparent
	grandparentKey, err := dirInode(filepath.Dir(filepath.Dir(dir)))
	if err != nil {
		t.Fatal(err)
	}
	if !visited[grandparentKey] {
		t.Fatalf("ancestorInodes: grandparent of %s not in set", dir)
	}
}

// TestAncestorInodes_ParentInodeBlocksDirectorySibling verifies that a
// subdirectory whose inode matches an ancestor causes the scanner to skip it.
// We approximate the NTFS-junction-to-parent scenario by scanning a temp dir
// that contains a nested subdirectory; the ancestor set is pre-loaded from an
// outer parent dir, so any inner dir that (hypothetically) shares its inode
// with that parent would be skipped by the walk.
//
// We cannot create real NTFS junctions on Linux, but this test validates that
// ancestorInodes correctly covers the path ancestry chain.
func TestAncestorInodes_DepthGrowsWithNesting(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "a", "b", "c")
	if err := os.MkdirAll(sub, 0755); err != nil {
		t.Fatal(err)
	}

	visitedFromRoot, err := ancestorInodes(root)
	if err != nil {
		t.Fatal(err)
	}
	visitedFromSub, err := ancestorInodes(sub)
	if err != nil {
		t.Fatal(err)
	}

	// Scanning from sub must cover strictly more ancestors than scanning from root.
	if len(visitedFromSub) <= len(visitedFromRoot) {
		t.Fatalf("expected deeper path to yield more ancestors: root=%d sub=%d",
			len(visitedFromRoot), len(visitedFromSub))
	}

	// root's inode must appear in the sub's ancestor set (used to block escapes).
	rootKey, err := dirInode(root)
	if err != nil {
		t.Fatal(err)
	}
	if !visitedFromSub[rootKey] {
		t.Fatalf("ancestorInodes for sub must include root's inode (junction-to-parent guard)")
	}
}

// TestDirInode verifies that dirInode returns a stable, unique identifier.
func TestDirInode_SamePathSameInode(t *testing.T) {
	dir := t.TempDir()
	a, err := dirInode(dir)
	if err != nil {
		t.Fatal(err)
	}
	b, err := dirInode(dir)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatalf("same path returned different inodes: %+v vs %+v", a, b)
	}
}

func TestDirInode_DifferentPathsDifferentInodes(t *testing.T) {
	a := t.TempDir()
	b := t.TempDir()
	ia, err := dirInode(a)
	if err != nil {
		t.Fatal(err)
	}
	ib, err := dirInode(b)
	if err != nil {
		t.Fatal(err)
	}
	if ia == ib {
		t.Fatalf("different directories returned the same inode: %+v", ia)
	}
}

// TestScan_DoesNotEscapeViaSymlink verifies that the scanner does not follow a
// symlink inside the selected directory that points to an ancestor, which would
// cause it to scan files outside the selected folder.
//
// Note: filepath.WalkDir does not follow non-root symlinks, so this test
// validates the existing behaviour. The inode-based cycle detection additionally
// guards against NTFS directory junctions (which appear as real directories in
// Linux Docker containers) and any future case where a directory entry is
// followed into an ancestor.
func TestScan_DoesNotEscapeViaSymlink(t *testing.T) {
	// Layout:
	//   root/
	//     outside.png          ← must NOT be scanned
	//     sub/
	//       inside.png         ← must be scanned
	//       link -> ../../root ← symlink pointing to root (ancestor)
	root := t.TempDir()
	sub := filepath.Join(root, "sub")
	if err := os.Mkdir(sub, 0755); err != nil {
		t.Fatal(err)
	}

	createTestPNG(t, root, "outside.png", color.RGBA{200, 0, 0, 255})
	createTestPNG(t, sub, "inside.png", color.RGBA{0, 200, 0, 255})

	// Symlink inside sub/ pointing to root (ancestor).
	if err := os.Symlink(root, filepath.Join(sub, "link")); err != nil {
		t.Fatal(err)
	}

	// Scan only sub/ — must find exactly 1 file (inside.png).
	progress := make(chan Progress, 200)
	records, err := Scan(context.Background(), []string{sub}, nil, progress)
	if err != nil {
		t.Fatal(err)
	}

	if len(records) != 1 {
		t.Fatalf("expected 1 record (only inside sub/), got %d — scanner escaped the selected directory", len(records))
	}
	if filepath.Base(records[0].Path) != "inside.png" {
		t.Fatalf("unexpected file scanned: %s", records[0].Path)
	}
}

// TestScan_Cancellation verifies that cancelling the context aborts the scan
// and returns a non-nil error.
func TestScan_Cancellation(t *testing.T) {
	dir := t.TempDir()
	for i := 0; i < 5; i++ {
		createTestPNG(t, dir, fmt.Sprintf("img%d.png", i), color.White)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately before the scan even starts

	progress := make(chan Progress, 200)
	_, err := Scan(ctx, []string{dir}, nil, progress)
	close(progress)

	if err == nil {
		t.Fatal("expected non-nil error when context is cancelled, got nil")
	}
}
