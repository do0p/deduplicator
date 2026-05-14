package matcher

import (
	"fmt"
	"testing"

	"github.com/dominik/duplicates/internal/scanner"
)

func rec(hash uint64) scanner.FileRecord {
	return scanner.FileRecord{
		Path: fmt.Sprintf("/img/%016x.jpg", hash),
		Hash: hash,
		Size: 10_000,
	}
}

// bitsSet returns a uint64 with the lowest n bits set (Hamming distance n from 0).
func bitsSet(n int) uint64 {
	if n == 0 {
		return 0
	}
	return (1 << n) - 1
}

func totalFiles(groups []DuplicateGroup) int {
	n := 0
	for _, g := range groups {
		n += len(g.Files)
	}
	return n
}

func TestFindDuplicates_Empty(t *testing.T) {
	groups := FindDuplicates(nil, 10)
	if len(groups) != 0 {
		t.Fatalf("expected 0 groups, got %d", len(groups))
	}
}

func TestFindDuplicates_NoMatch(t *testing.T) {
	// All hashes differ by more than threshold from each other.
	records := []scanner.FileRecord{
		rec(0x0000000000000000),
		rec(0xFFFFFFFFFFFFFFFF), // hamming distance 64 from above
		rec(0x00000000FFFFFFFF), // hamming distance 32 from first
	}
	groups := FindDuplicates(records, 10)
	if len(groups) != 0 {
		t.Fatalf("expected 0 groups, got %d", len(groups))
	}
}

func TestFindDuplicates_ExactMatch(t *testing.T) {
	hash := uint64(0xABCD1234ABCD1234)
	records := []scanner.FileRecord{rec(hash), rec(hash), rec(hash)}

	groups := FindDuplicates(records, 0) // threshold 0 = exact only
	if len(groups) != 1 {
		t.Fatalf("expected 1 group, got %d", len(groups))
	}
	if len(groups[0].Files) != 3 {
		t.Fatalf("expected 3 files in group, got %d", len(groups[0].Files))
	}
}

func TestFindDuplicates_MultipleExactGroups(t *testing.T) {
	hashA := uint64(0x1111111111111111)
	hashB := uint64(0x2222222222222222)
	records := []scanner.FileRecord{
		rec(hashA), rec(hashA),
		rec(hashB), rec(hashB), rec(hashB),
	}
	groups := FindDuplicates(records, 0)
	if len(groups) != 2 {
		t.Fatalf("expected 2 groups, got %d", len(groups))
	}
	if totalFiles(groups) != 5 {
		t.Fatalf("expected 5 total files, got %d", totalFiles(groups))
	}
}

func TestFindDuplicates_NearDup_WithinThreshold(t *testing.T) {
	// Distance 9 from 0 — should be grouped at threshold 10.
	records := []scanner.FileRecord{
		rec(0),
		rec(bitsSet(9)),
	}
	groups := FindDuplicates(records, 10)
	if len(groups) != 1 {
		t.Fatalf("expected 1 near-dup group, got %d", len(groups))
	}
}

func TestFindDuplicates_NearDup_AtThreshold(t *testing.T) {
	// Distance exactly 10 — should be grouped (inclusive).
	records := []scanner.FileRecord{
		rec(0),
		rec(bitsSet(10)),
	}
	groups := FindDuplicates(records, 10)
	if len(groups) != 1 {
		t.Fatalf("expected 1 group at threshold boundary, got %d", len(groups))
	}
}

func TestFindDuplicates_NearDup_AboveThreshold(t *testing.T) {
	// Distance 11 — should NOT be grouped at threshold 10.
	records := []scanner.FileRecord{
		rec(0),
		rec(bitsSet(11)),
	}
	groups := FindDuplicates(records, 10)
	if len(groups) != 0 {
		t.Fatalf("expected 0 groups above threshold, got %d", len(groups))
	}
}

func TestFindDuplicates_NearDup_Transitive(t *testing.T) {
	// A-B within threshold, B-C within threshold → all three in one group.
	a := uint64(0)
	b := bitsSet(5)  // distance 5 from a
	c := bitsSet(10) // distance 5 from b (bits 5-9), distance 10 from a
	records := []scanner.FileRecord{rec(a), rec(b), rec(c)}

	groups := FindDuplicates(records, 10)
	if len(groups) != 1 {
		t.Fatalf("expected 1 transitive group, got %d", len(groups))
	}
	if len(groups[0].Files) != 3 {
		t.Fatalf("expected 3 files in transitive group, got %d", len(groups[0].Files))
	}
}

func TestFindDuplicates_MixedExactAndNear(t *testing.T) {
	exactHash := uint64(0xDEADBEEFDEADBEEF)
	// two exact duplicates + one near-dup pair
	records := []scanner.FileRecord{
		rec(exactHash), rec(exactHash), // exact group
		rec(0), rec(bitsSet(8)),        // near-dup group
		rec(0xFFFFFFFFFFFFFFFF),        // unique — distance 64 from 0, far from everything
	}
	groups := FindDuplicates(records, 10)
	if len(groups) != 2 {
		t.Fatalf("expected 2 groups (1 exact + 1 near-dup), got %d", len(groups))
	}
}
