package store

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// A filename is a label and decides nothing, but it still crosses into a text
// column, and the one thing text will not accept is bytes that are not
// characters. Cutting a long name at a byte count ends inside a character
// whenever the name is not ASCII, and PostgreSQL refuses the whole row — so the
// picture, which was never the problem, is lost over its label.

func TestSafeFilenameCutsBetweenCharactersNotBytes(t *testing.T) {
	// Long enough to need cutting, and arranged so that the 120th byte lands
	// inside a character rather than between two.
	name := "2026 " + strings.Repeat("화이트보드", 9) + ".png"
	if len(name) <= 120 || utf8.RuneStart(name[120]) {
		t.Fatalf("this name no longer tests the boundary: %d bytes, rune start at 120 = %v", len(name), utf8.RuneStart(name[120]))
	}

	cleaned := safeFilename(name)
	if !utf8.ValidString(cleaned) {
		t.Fatalf("a cut name is not text any more: %q", cleaned)
	}
	if len(cleaned) > 120 {
		t.Fatalf("kept %d bytes, wanted at most 120", len(cleaned))
	}
	if !strings.HasPrefix(name, cleaned) {
		t.Fatalf("the label is no longer what the person called it: %q", cleaned)
	}
}

func TestSafeFilenameKeepsAShortNameWhole(t *testing.T) {
	if got := safeFilename("  화이트보드.png  "); got != "화이트보드.png" {
		t.Fatalf("got %q", got)
	}
}

func TestSafeFilenameDropsSeparatorsAndControls(t *testing.T) {
	if got := safeFilename("../etc/pass\"wd\x00.png"); got != "..etcpasswd.png" {
		t.Fatalf("got %q", got)
	}
}
