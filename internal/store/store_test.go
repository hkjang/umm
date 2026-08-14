package store

import (
	"reflect"
	"testing"
)

func TestNoteSearchPatternsSplitsAndEscapesTerms(t *testing.T) {
	got := noteSearchPatterns(`  한국어 검색 100% draft_name path\part `)
	want := []string{"%한국어%", "%검색%", `%100\%%`, `%draft\_name%`, `%path\\part%`}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected search patterns: got %#v want %#v", got, want)
	}
}

func TestNoteSearchPatternsEmptyQuery(t *testing.T) {
	if got := noteSearchPatterns("  \t\n"); len(got) != 0 {
		t.Fatalf("empty query returned patterns: %#v", got)
	}
}
