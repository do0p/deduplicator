package matcher

import (
	"math/bits"
	"runtime"
	"sync"

	"github.com/do0p/deduplicator/internal/scanner"
)

type DuplicateGroup struct {
	Files []scanner.FileRecord `json:"files"`
}

// unionFind is a simple non-concurrent Union-Find over integer indices.
type unionFind struct {
	parent []int
}

func newUnionFind(n int) *unionFind {
	p := make([]int, n)
	for i := range p {
		p[i] = i
	}
	return &unionFind{p}
}

func (u *unionFind) find(x int) int {
	for u.parent[x] != x {
		u.parent[x] = u.parent[u.parent[x]]
		x = u.parent[x]
	}
	return x
}

func (u *unionFind) union(a, b int) {
	ra, rb := u.find(a), u.find(b)
	if ra != rb {
		u.parent[ra] = rb
	}
}

func hamming(a, b uint64) int {
	return bits.OnesCount64(a ^ b)
}

// FindDuplicates groups records into duplicate sets.
// Images: pHash Hamming distance ≤ threshold (existing two-pass logic).
// Videos: exact SHA-256 content hash match.
func FindDuplicates(records []scanner.FileRecord, threshold int) []DuplicateGroup {
	var images, videos []scanner.FileRecord
	for _, r := range records {
		if r.IsVideo {
			videos = append(videos, r)
		} else {
			images = append(images, r)
		}
	}
	groups := findImageDuplicates(images, threshold)
	groups = append(groups, findVideoDuplicates(videos)...)
	return groups
}

func findVideoDuplicates(videos []scanner.FileRecord) []DuplicateGroup {
	byHash := make(map[string][]scanner.FileRecord)
	for _, v := range videos {
		if v.ContentHash != "" {
			byHash[v.ContentHash] = append(byHash[v.ContentHash], v)
		}
	}
	var groups []DuplicateGroup
	for _, files := range byHash {
		if len(files) >= 2 {
			groups = append(groups, DuplicateGroup{Files: files})
		}
	}
	return groups
}

// findImageDuplicates groups images by pHash similarity.
// Pass 1: exact pHash match (O(n)).
// Pass 2: near-duplicate Hamming distance (parallel O(n²)).
func findImageDuplicates(records []scanner.FileRecord, threshold int) []DuplicateGroup {
	byHash := map[uint64][]int{}
	for i, r := range records {
		byHash[r.Hash] = append(byHash[r.Hash], i)
	}

	used := make([]bool, len(records))
	var exactGroups [][]int
	var singletons []int

	for _, idxs := range byHash {
		if len(idxs) > 1 {
			exactGroups = append(exactGroups, idxs)
			for _, i := range idxs {
				used[i] = true
			}
		} else {
			singletons = append(singletons, idxs[0])
		}
	}

	n := len(singletons)
	uf := newUnionFind(n)

	if threshold > 0 && n > 1 {
		numCPU := runtime.NumCPU()
		bandSize := (n + numCPU - 1) / numCPU

		var mu sync.Mutex
		var wg sync.WaitGroup

		for band := 0; band < numCPU; band++ {
			start := band * bandSize
			end := start + bandSize
			if end > n {
				end = n
			}
			if start >= n {
				break
			}

			wg.Add(1)
			go func(rowStart, rowEnd int) {
				defer wg.Done()
				var pairs [][2]int
				for i := rowStart; i < rowEnd; i++ {
					for j := i + 1; j < n; j++ {
						if hamming(records[singletons[i]].Hash, records[singletons[j]].Hash) <= threshold {
							pairs = append(pairs, [2]int{i, j})
						}
					}
				}
				if len(pairs) > 0 {
					mu.Lock()
					for _, p := range pairs {
						uf.union(p[0], p[1])
					}
					mu.Unlock()
				}
			}(start, end)
		}
		wg.Wait()
	}

	nearGroups := map[int][]int{}
	for i := range singletons {
		root := uf.find(i)
		nearGroups[root] = append(nearGroups[root], i)
	}

	var groups []DuplicateGroup

	for _, idxs := range exactGroups {
		g := DuplicateGroup{}
		for _, i := range idxs {
			g.Files = append(g.Files, records[i])
		}
		groups = append(groups, g)
	}

	for _, singIdxs := range nearGroups {
		if len(singIdxs) < 2 {
			continue
		}
		g := DuplicateGroup{}
		for _, si := range singIdxs {
			g.Files = append(g.Files, records[singletons[si]])
		}
		groups = append(groups, g)
	}

	_ = used
	return groups
}
