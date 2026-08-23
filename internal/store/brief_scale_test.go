package store

import (
	"strconv"
	"testing"
	"time"
)

// Finding duplicates means comparing every pair, so the work grows with the
// square of the space. Measured at 1024 dimensions: 1,000 thoughts take 229ms,
// 2,000 take 916ms and 10,000 would take about 23 seconds — per space, every
// morning. A brief that times out silently is worse than one that says what it
// left out.
func TestDuplicateScanKeepsTheRecentEnd(t *testing.T) {
	notes := make([]Note, maxDuplicateScanNotes+50)
	base := time.Now().Add(-time.Duration(len(notes)) * time.Minute)
	for index := range notes {
		// ListNotes orders by created_at ascending, so the fixture does too.
		notes[index] = Note{Content: strconv.Itoa(index), CreatedAt: base.Add(time.Duration(index) * time.Minute)}
	}

	kept, trimmed := recentForDuplicateScan(notes)
	if !trimmed {
		t.Fatal("a space past the bound was not trimmed")
	}
	if len(kept) != maxDuplicateScanNotes {
		t.Fatalf("kept %d, want %d", len(kept), maxDuplicateScanNotes)
	}
	// The newest thought must survive. Keeping the head would drop precisely the
	// recent end, where a duplicate almost always is, and nothing about the
	// result would look wrong.
	if kept[len(kept)-1].Content != notes[len(notes)-1].Content {
		t.Errorf("the newest thought was dropped: kept ends at %q, space ends at %q",
			kept[len(kept)-1].Content, notes[len(notes)-1].Content)
	}
	if kept[0].CreatedAt.Before(notes[0].CreatedAt.Add(time.Minute)) {
		t.Error("the oldest thoughts were kept rather than the newest")
	}
}

// Under the bound nothing is trimmed, so a small workspace does not read as
// partly examined.
func TestDuplicateScanLeavesSmallSpacesWhole(t *testing.T) {
	for _, size := range []int{0, 1, 2, maxDuplicateScanNotes} {
		notes := make([]Note, size)
		kept, trimmed := recentForDuplicateScan(notes)
		if trimmed {
			t.Errorf("a space of %d was reported as trimmed", size)
		}
		if len(kept) != size {
			t.Errorf("size %d became %d", size, len(kept))
		}
	}
}
