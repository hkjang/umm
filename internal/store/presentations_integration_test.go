package store

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// This layer's whole job is access control and keeping a link and its sources
// in step. Neither can be shown without a real database: an in-memory fake
// would be asserting that the fake behaves, and the SQL is where the rule
// actually lives.

func presentationFixture(t *testing.T) (*Store, uuid.UUID, uuid.UUID, []uuid.UUID) {
	t.Helper()
	db, userID, spaceID := retrievalSpace(t)
	ctx := context.Background()

	notes := []uuid.UUID{uuid.New(), uuid.New(), uuid.New()}
	for i, id := range notes {
		if _, err := db.Pool.Exec(ctx,
			`INSERT INTO notes(id,space_id,author_id,content) VALUES($1,$2,$3,$4)`,
			id, spaceID, userID, []string{"문제", "원인", "대안"}[i]); err != nil {
			t.Fatal(err)
		}
	}
	return db, userID, spaceID, notes
}

func TestPresentationLinkRoundTripIntegration(t *testing.T) {
	db, userID, spaceID, notes := presentationFixture(t)
	ctx := context.Background()

	link, err := db.CreatePresentationLink(ctx, userID, spaceID, "pt_abc", "회고 주기 재검토")
	if err != nil {
		t.Fatal(err)
	}
	// Written before compiling, so a compile that fails still leaves a record
	// rather than a deck in Ptium umm has never heard of.
	if link.Status != PresentationPending {
		t.Fatalf("a new link should be pending, got %q", link.Status)
	}

	sources := []SlideSource{
		{SlidePosition: 1, NoteID: notes[0]},
		{SlidePosition: 2, NoteID: notes[1]},
		{SlidePosition: 2, NoteID: notes[2]},
	}
	const source = "# 회고\n@cover\n"
	if err := db.CompletePresentationLink(ctx, userID, link.ID, PresentationReady, source, sources, 3, 1, ""); err != nil {
		t.Fatal(err)
	}

	links, err := db.ListPresentationLinks(ctx, userID, spaceID)
	if err != nil {
		t.Fatal(err)
	}
	if len(links) != 1 || links[0].Status != PresentationReady || links[0].ThoughtCount != 3 || links[0].ExcludedCount != 1 {
		t.Fatalf("link not recorded as expected: %+v", links)
	}
	// The list is read far more often than any one source, so it must not carry
	// megabytes of deck text to draw a few rows.
	if links[0].CompiledSource != "" {
		t.Fatalf("the list carried the compiled source: %q", links[0].CompiledSource)
	}

	got, err := db.PresentationLinkSource(ctx, userID, link.ID)
	if err != nil || got != source {
		t.Fatalf("source round trip: %q, %v", got, err)
	}

	stored, err := db.PresentationSources(ctx, userID, link.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 3 {
		t.Fatalf("expected three source rows, got %+v", stored)
	}
}

// Recompiling replaces the mapping. Adding to it would leave a slide claiming
// thoughts that are no longer on it.
func TestRecompilingReplacesTheSourceMappingIntegration(t *testing.T) {
	db, userID, spaceID, notes := presentationFixture(t)
	ctx := context.Background()

	link, err := db.CreatePresentationLink(ctx, userID, spaceID, "pt_recompile", "덱")
	if err != nil {
		t.Fatal(err)
	}
	first := []SlideSource{{SlidePosition: 1, NoteID: notes[0]}, {SlidePosition: 2, NoteID: notes[1]}}
	if err := db.CompletePresentationLink(ctx, userID, link.ID, PresentationReady, "a", first, 2, 0, ""); err != nil {
		t.Fatal(err)
	}
	second := []SlideSource{{SlidePosition: 1, NoteID: notes[2]}}
	if err := db.CompletePresentationLink(ctx, userID, link.ID, PresentationReady, "b", second, 1, 0, ""); err != nil {
		t.Fatal(err)
	}

	stored, err := db.PresentationSources(ctx, userID, link.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 || stored[0].NoteID != notes[2] {
		t.Fatalf("the old mapping survived a recompile: %+v", stored)
	}
}

// The other direction, and the reason the table earns its place: someone
// editing a note that decks quote is making a different decision from someone
// editing one nobody has used.
func TestANoteKnowsWhichTalksUsedItIntegration(t *testing.T) {
	db, userID, spaceID, notes := presentationFixture(t)
	ctx := context.Background()

	for _, name := range []string{"pt_one", "pt_two"} {
		link, err := db.CreatePresentationLink(ctx, userID, spaceID, name, name)
		if err != nil {
			t.Fatal(err)
		}
		if err := db.CompletePresentationLink(ctx, userID, link.ID, PresentationReady, "x",
			[]SlideSource{{SlidePosition: 1, NoteID: notes[0]}}, 1, 0, ""); err != nil {
			t.Fatal(err)
		}
	}

	used, err := db.PresentationsUsingNote(ctx, userID, notes[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(used) != 2 {
		t.Fatalf("expected both talks, got %+v", used)
	}
	unused, err := db.PresentationsUsingNote(ctx, userID, notes[1])
	if err != nil {
		t.Fatal(err)
	}
	if len(unused) != 0 {
		t.Fatalf("a note nobody used reported %d talks", len(unused))
	}
}

// A thought from another space would credit a slide to something the deck's
// readers cannot see.
func TestASlideCannotCiteAThoughtFromAnotherSpaceIntegration(t *testing.T) {
	db, userID, spaceID, notes := presentationFixture(t)
	ctx := context.Background()

	otherSpace := uuid.New()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'다른 공간')`, otherSpace, userID); err != nil {
		t.Fatal(err)
	}
	outsider := uuid.New()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO notes(id,space_id,author_id,content) VALUES($1,$2,$3,'남의 생각')`,
		outsider, otherSpace, userID); err != nil {
		t.Fatal(err)
	}

	link, err := db.CreatePresentationLink(ctx, userID, spaceID, "pt_outsider", "덱")
	if err != nil {
		t.Fatal(err)
	}
	err = db.CompletePresentationLink(ctx, userID, link.ID, PresentationReady, "x", []SlideSource{
		{SlidePosition: 1, NoteID: notes[0]},
		{SlidePosition: 1, NoteID: outsider},
	}, 2, 0, "")
	if err != nil {
		t.Fatal(err)
	}

	stored, err := db.PresentationSources(ctx, userID, link.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 || stored[0].NoteID != notes[0] {
		t.Fatalf("a thought from another space was cited: %+v", stored)
	}
}

func TestAStrangerCannotMakeOrReadALinkIntegration(t *testing.T) {
	db, userID, spaceID, notes := presentationFixture(t)
	ctx := context.Background()

	stranger := uuid.New()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,'stranger_pres'::citext,'stranger')`, stranger); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, stranger)

	if _, err := db.CreatePresentationLink(ctx, stranger, spaceID, "pt_nope", "덱"); err == nil {
		t.Fatal("a stranger made a deck from someone else's space")
	}

	link, err := db.CreatePresentationLink(ctx, userID, spaceID, "pt_private", "덱")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.CompletePresentationLink(ctx, userID, link.ID, PresentationReady, "비밀 소스",
		[]SlideSource{{SlidePosition: 1, NoteID: notes[0]}}, 1, 0, ""); err != nil {
		t.Fatal(err)
	}

	if err := db.CompletePresentationLink(ctx, stranger, link.ID, PresentationFailed, "x", nil, 0, 0, "hacked"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("a stranger wrote to someone else's link: %v", err)
	}
	if links, err := db.ListPresentationLinks(ctx, stranger, spaceID); err != nil || len(links) != 0 {
		t.Fatalf("a stranger listed someone else's talks: %+v %v", links, err)
	}
	if sources, err := db.PresentationSources(ctx, stranger, link.ID); err != nil || len(sources) != 0 {
		t.Fatalf("a stranger read someone else's slide sources: %+v %v", sources, err)
	}
	if _, err := db.PresentationLinkSource(ctx, stranger, link.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("a stranger read someone else's deck source: %v", err)
	}
	if used, err := db.PresentationsUsingNote(ctx, stranger, notes[0]); err != nil || len(used) != 0 {
		t.Fatalf("a stranger saw which talks used someone else's note: %+v %v", used, err)
	}
}

func TestAnUnknownStatusIsRefusedIntegration(t *testing.T) {
	db, userID, spaceID, _ := presentationFixture(t)
	ctx := context.Background()

	link, err := db.CreatePresentationLink(ctx, userID, spaceID, "pt_status", "덱")
	if err != nil {
		t.Fatal(err)
	}
	// Refused in Go rather than left to the CHECK constraint, so the API can
	// answer 400 instead of 500.
	if err := db.CompletePresentationLink(ctx, userID, link.ID, "exploded", "x", nil, 0, 0, ""); !errors.Is(err, ErrUnknownPresentationStatus) {
		t.Fatalf("an unknown status was accepted: %v", err)
	}
}

func TestAFailedCompileKeepsWhatPtiumSaidIntegration(t *testing.T) {
	db, userID, spaceID, _ := presentationFixture(t)
	ctx := context.Background()

	link, err := db.CreatePresentationLink(ctx, userID, spaceID, "pt_failed", "덱")
	if err != nil {
		t.Fatal(err)
	}
	const why = "템플릿에 해당 레이아웃이 없습니다"
	if err := db.CompletePresentationLink(ctx, userID, link.ID, PresentationFailed, "", nil, 0, 0, why); err != nil {
		t.Fatal(err)
	}
	links, err := db.ListPresentationLinks(ctx, userID, spaceID)
	if err != nil || len(links) != 1 {
		t.Fatalf("list: %+v %v", links, err)
	}
	// A failure that is still explainable after the job is long gone.
	if links[0].Status != PresentationFailed || links[0].Error != why {
		t.Fatalf("the reason was lost: %+v", links[0])
	}
}

// Deleting a space is a decision about the space; the deck lives in Ptium and
// is unaffected, but umm's record of it has nothing left to hang from.
func TestDeletingASpaceTakesItsLinksIntegration(t *testing.T) {
	db, userID, spaceID, notes := presentationFixture(t)
	ctx := context.Background()

	link, err := db.CreatePresentationLink(ctx, userID, spaceID, "pt_cascade", "덱")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.CompletePresentationLink(ctx, userID, link.ID, PresentationReady, "x",
		[]SlideSource{{SlidePosition: 1, NoteID: notes[0]}}, 1, 0, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `DELETE FROM spaces WHERE id=$1`, spaceID); err != nil {
		t.Fatal(err)
	}

	var remaining int
	if err := db.Pool.QueryRow(ctx,
		`SELECT count(*) FROM presentation_sources WHERE presentation_link_id=$1`, link.ID).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 0 {
		t.Fatalf("%d source rows outlived their space", remaining)
	}
}
