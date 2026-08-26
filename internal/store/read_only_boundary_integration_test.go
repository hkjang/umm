package store

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// What a member shared in to read may and may not do, in one place.
//
// Every one of these paths guards itself today. That was checked by reading all
// of them after one turned out not to — suggesting connections wrote edges into
// a space its caller could only read, because reading the notes is allowed and
// nothing after that asked whether they could be written.
//
// Reading them proves what is true now. This is what keeps it true: a new write
// path, or a guard dropped from an existing one, fails here rather than waiting
// to be noticed.
func TestAReadOnlyMemberCannotChangeTheSpaceIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db := isolatedStore(t, dsn)

	ownerID, readerID := uuid.New(), uuid.New()
	name := func(id uuid.UUID) string { return "boundary_" + strings.ReplaceAll(id.String(), "-", "") }
	if _, err := db.Pool.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text),($3,$4::citext,$4::text)`,
		ownerID, name(ownerID), readerID, name(readerID)); err != nil {
		t.Fatal(err)
	}
	spaceID, otherSpaceID := uuid.New(), uuid.New()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'공유 공간'),($3,$4,'읽는 사람의 공간')`,
		spaceID, ownerID, otherSpaceID, readerID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO space_members(space_id,user_id,permission) VALUES($1,$2,'view')`, spaceID, readerID); err != nil {
		t.Fatal(err)
	}
	first, second := uuid.New(), uuid.New()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO notes(id,space_id,author_id,content) VALUES($1,$2,$3,'첫 생각'),($4,$2,$3,'둘째 생각')`,
		first, spaceID, ownerID, second); err != nil {
		t.Fatal(err)
	}
	existing, err := db.CreateEdge(ctx, ownerID, Edge{SpaceID: spaceID, SourceID: first, TargetID: second, Relation: RelationRelated})
	if err != nil {
		t.Fatal(err)
	}

	// Counted before and after: a refusal that still wrote something would pass
	// a test that only checked the error.
	count := func(table string) int {
		t.Helper()
		var n int
		query := "SELECT count(*) FROM " + table + " WHERE space_id=$1"
		if table == "notes" {
			query += " AND deleted_at IS NULL"
		}
		if err := db.Pool.QueryRow(ctx, query, spaceID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	notesBefore, edgesBefore := count("notes"), count("note_edges")

	refusals := []struct {
		what string
		run  func() error
	}{
		{"write a new thought", func() error {
			_, err := db.CreateNote(ctx, readerID, Note{SpaceID: spaceID, AuthorID: readerID, Content: "읽기 전용이 쓴 생각"})
			return err
		}},
		{"change an existing thought", func() error {
			_, err := db.UpdateNote(ctx, readerID, Note{ID: first, Version: 1, Content: "고쳐 봄", Color: "yellow", Kind: "thought"}, nil)
			return err
		}},
		{"delete a thought", func() error { return db.DeleteNote(ctx, readerID, first) }},
		{"connect two thoughts", func() error {
			_, err := db.CreateEdge(ctx, readerID, Edge{SpaceID: spaceID, SourceID: second, TargetID: first, Relation: RelationRelated})
			return err
		}},
		{"take a thought out of the space", func() error {
			_, _, err := db.MoveNote(ctx, readerID, first, otherSpaceID)
			return err
		}},
		{"merge two thoughts", func() error {
			_, err := db.MergeNotes(ctx, readerID, first, second, "합친 생각")
			return err
		}},
		{"start a line of thinking", func() error {
			_, err := db.CreateBranch(ctx, readerID, spaceID, "갈래", &first)
			return err
		}},
		{"accept a suggested connection", func() error {
			_, err := db.AcceptSuggestion(ctx, readerID, existing.ID)
			return err
		}},
	}
	for _, tc := range refusals {
		if err := tc.run(); err == nil {
			t.Errorf("a read-only member was allowed to %s", tc.what)
		}
	}

	if notes, edges := count("notes"), count("note_edges"); notes != notesBefore || edges != edgesBefore {
		t.Errorf("the space changed anyway: notes %d->%d, edges %d->%d", notesBefore, notes, edgesBefore, edges)
	}

	// The one thing they may do. Not being able to change something is no reason
	// to stop talking about it, and a boundary that swallowed this would be
	// wrong in the other direction.
	if _, _, err := db.CreateComment(ctx, readerID, first, nil, "읽기 전용의 댓글", nil); err != nil {
		t.Errorf("a read-only member could not comment: %v", err)
	}
}
