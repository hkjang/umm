package store

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/intelligence"
	"github.com/jackc/pgx/v5"
)

func TestTodayReviewStateIsIsolatedPerUserIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()

	ownerID, memberID, spaceID, noteID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	ownerName, memberName := "review_owner_"+ownerID.String(), "review_member_"+memberID.String()
	if _, err = tx.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text),($3,$4::citext,$4::text)`, ownerID, ownerName, memberID, memberName); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO user_preferences(user_id) VALUES($1),($2)`, ownerID, memberID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'review isolation')`, spaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO space_members(space_id,user_id,permission) VALUES($1,$2,'view')`, spaceID, memberID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO notes(id,space_id,author_id,content) VALUES($1,$2,$3,'personal review state')`, noteID, spaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1 OR id=$2`, ownerID, memberID)

	pinned := true
	if _, err = db.UpdateReview(ctx, ownerID, noteID, nil, &pinned, false); err != nil {
		t.Fatal(err)
	}
	ownerReview, err := db.TodayReview(ctx, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	memberReview, err := db.TodayReview(ctx, memberID)
	if err != nil {
		t.Fatal(err)
	}
	if !reviewContains(ownerReview.Review, noteID, true) {
		t.Fatal("owner's pinned note was not returned in the review queue")
	}
	if reviewContains(memberReview.Review, noteID, false) {
		t.Fatal("owner's pinned state leaked into the member's review queue")
	}

	if _, err = db.UpdateReview(ctx, memberID, noteID, nil, nil, true); err != nil {
		t.Fatal(err)
	}
	ownerReview, err = db.TodayReview(ctx, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	if !reviewContains(ownerReview.Review, noteID, true) {
		t.Fatal("member review completion changed the owner's pinned state")
	}
}

func TestHybridSearchKeepsOlderLexicalMatchesIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()

	userID, spaceID, noteID := uuid.New(), uuid.New(), uuid.New()
	username := "search_user_" + userID.String()
	needle := "archived-exact-" + noteID.String()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text)`, userID, username); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'large search corpus')`, spaceID, userID); err != nil {
		t.Fatal(err)
	}
	deepContent := strings.Repeat("unrelated archival prefix ", 100) + needle
	if _, err = tx.Exec(ctx, `INSERT INTO notes(id,space_id,author_id,title,content,created_at,updated_at) VALUES($1,$2,$3,'',$4,now()-interval '10 years',now()-interval '10 years')`, noteID, spaceID, userID, deepContent); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO notes(space_id,author_id,content,created_at,updated_at) SELECT $1,$2,'recent semantic decoy '||value,now(),now() FROM generate_series(1,2001) AS value`, spaceID, userID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)

	page, err := db.SearchNotesHybrid(ctx, userID, SearchOptions{Query: needle, Limit: 5})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range page.Notes {
		if item.ID == noteID {
			return
		}
	}
	t.Fatalf("older exact match %s was omitted from %#v", noteID, page.Notes)
}

func TestHybridSearchRanksAcrossBoundedLexicalCandidatesIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()

	userID, spaceID, exactID := uuid.New(), uuid.New(), uuid.New()
	username := "bounded_search_" + userID.String()
	needle := "bounded-rank-" + exactID.String()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text)`, userID, username); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'bounded lexical search')`, spaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO notes(id,space_id,author_id,title,content,created_at,updated_at) VALUES($1,$2,$3,$4,'',now()-interval '10 years',now()-interval '10 years')`, exactID, spaceID, userID, needle); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO notes(space_id,author_id,content,created_at,updated_at) SELECT $1,$2,$3||' decoy '||value,now(),now() FROM generate_series(1,$4) AS value`, spaceID, userID, needle, hybridLexicalCandidateLimit+1); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)

	page, err := db.SearchNotesHybrid(ctx, userID, SearchOptions{Query: needle, Limit: 5})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Notes) == 0 || page.Notes[0].ID != exactID {
		t.Fatalf("old exact-title match was not ranked into the bounded candidate set: %#v", page.Notes)
	}
}

func TestHybridSearchRanksExactBodyAcrossBoundedCandidatesIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()

	userID, spaceID, exactID := uuid.New(), uuid.New(), uuid.New()
	username := "exact_body_search_" + userID.String()
	needle := "exact-body-rank-" + exactID.String()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text)`, userID, username); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'exact body bounded search')`, spaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO notes(id,space_id,author_id,title,content,created_at,updated_at) VALUES($1,$2,$3,'',$4,now()-interval '10 years',now()-interval '10 years')`, exactID, spaceID, userID, needle); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO notes(space_id,author_id,title,content,created_at,updated_at) SELECT $1,$2,'','prefix '||$3||' suffix '||value,now(),now() FROM generate_series(1,$4) AS value`, spaceID, userID, needle, hybridLexicalCandidateLimit+1); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)

	page, err := db.SearchNotesHybrid(ctx, userID, SearchOptions{Query: needle, Limit: 5})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Notes) == 0 || page.Notes[0].ID != exactID {
		t.Fatalf("old exact-body match was not ranked into the bounded candidate set: %#v", page.Notes)
	}
}

func TestCreateCommentDoesNotNotifyRemovedNoteAuthorIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()

	ownerID, formerMemberID, spaceID, noteID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	ownerName, formerName := "comment_owner_"+ownerID.String(), "former_author_"+formerMemberID.String()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text),($3,$4::citext,$4::text)`, ownerID, ownerName, formerMemberID, formerName); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'removed author notification')`, spaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO space_members(space_id,user_id,permission) VALUES($1,$2,'edit')`, spaceID, formerMemberID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO notes(id,space_id,author_id,content) VALUES($1,$2,$3,'former member note')`, noteID, spaceID, formerMemberID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM space_members WHERE space_id=$1 AND user_id=$2`, spaceID, formerMemberID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1 OR id=$2`, ownerID, formerMemberID)

	if _, _, err = db.CreateComment(ctx, ownerID, noteID, nil, "access-scoped comment", nil); err != nil {
		t.Fatal(err)
	}
	var notifications int
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM notifications WHERE user_id=$1 AND resource_id=$2`, formerMemberID, noteID).Scan(&notifications); err != nil {
		t.Fatal(err)
	}
	if notifications != 0 {
		t.Fatalf("removed note author received %d inaccessible comment notifications", notifications)
	}
}

func TestCreateCommentResolvesLongestPunctuationUsernameIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()

	ownerID, bangID, plainBangID := uuid.New(), uuid.New(), uuid.New()
	dotID, plainDotID, spaceID, noteID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	ownerName := "mention_owner_" + suffix
	plainBangName, bangName := "ops"+suffix, "ops"+suffix+"!"
	plainDotName, dotName := "alice"+suffix, "alice"+suffix+"."
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `
		INSERT INTO users(id,username,display_name) VALUES
		($1,$2::citext,$2::text),($3,$4::citext,$4::text),($5,$6::citext,$6::text),
		($7,$8::citext,$8::text),($9,$10::citext,$10::text)`,
		ownerID, ownerName, bangID, bangName, plainBangID, plainBangName,
		dotID, dotName, plainDotID, plainDotName); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'punctuation mentions')`, spaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO space_members(space_id,user_id,permission) VALUES($1,$2,'view'),($1,$3,'view'),($1,$4,'view'),($1,$5,'view')`, spaceID, bangID, plainBangID, dotID, plainDotID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO notes(id,space_id,author_id,content) VALUES($1,$2,$3,'punctuation mention target')`, noteID, spaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(ctx, `DELETE FROM users WHERE id=ANY($1::uuid[])`, []uuid.UUID{ownerID, bangID, plainBangID, dotID, plainDotID})

	comment, _, err := db.CreateComment(ctx, ownerID, noteID, nil,
		"확인 @"+bangName+" 그리고 @"+dotName+", 부탁합니다.",
		[]string{bangName, dotName + ","})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, username := range comment.Mentions {
		got[username] = true
	}
	if len(comment.Mentions) != 2 || !got[bangName] || !got[dotName] || got[plainBangName] || got[plainDotName] {
		t.Fatalf("longest punctuation usernames were not selected: %#v", comment.Mentions)
	}
}

func TestContentQueriesRejectRevokedMemberIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()

	ownerID, memberID, spaceID := uuid.New(), uuid.New(), uuid.New()
	sourceID, linkedID, edgeID := uuid.New(), uuid.New(), uuid.New()
	ownerName, memberName := "content_owner_"+ownerID.String(), "content_member_"+memberID.String()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text),($3,$4::citext,$4::text)`, ownerID, ownerName, memberID, memberName); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'revoked content reads')`, spaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO space_members(space_id,user_id,permission) VALUES($1,$2,'view')`, spaceID, memberID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO notes(id,space_id,author_id,content) VALUES
		($1,$2,$3,'source secret'),($4,$2,$3,'linked secret')`, sourceID, spaceID, ownerID, linkedID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO note_edges(id,space_id,source_note_id,target_note_id,created_by) VALUES($1,$2,$3,$4,$5)`, edgeID, spaceID, sourceID, linkedID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO note_revisions(note_id,version,content,title,color,kind,x,y,width,height,rotation,changed_by) VALUES($1,1,'revision secret','','yellow','thought',0,0,240,160,0,$2)`, sourceID, ownerID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1 OR id=$2`, ownerID, memberID)
	if _, _, err = db.CreateComment(ctx, ownerID, sourceID, nil, "comment secret", nil); err != nil {
		t.Fatal(err)
	}

	comments, err := db.ListComments(ctx, memberID, sourceID)
	if err != nil || len(comments) != 1 || comments[0].Body != "comment secret" {
		t.Fatalf("member comment access before revocation: %#v err=%v", comments, err)
	}
	backlinks, err := db.Backlinks(ctx, memberID, sourceID)
	if err != nil || len(backlinks) != 1 || backlinks[0].Note.Content != "linked secret" {
		t.Fatalf("member backlink access before revocation: %#v err=%v", backlinks, err)
	}
	notes, _, err := db.ListNotes(ctx, memberID, spaceID, "")
	if err != nil || len(notes) != 2 {
		t.Fatalf("member canvas access before revocation: %d err=%v", len(notes), err)
	}
	filtered, _, err := db.ListNotes(ctx, memberID, spaceID, "source")
	if err != nil || len(filtered) != 1 || filtered[0].Content != "source secret" {
		t.Fatalf("member filtered canvas access before revocation: %#v err=%v", filtered, err)
	}
	history, err := db.NoteHistory(ctx, memberID, sourceID)
	if err != nil || len(history) != 1 || history[0].Content != "revision secret" {
		t.Fatalf("member history access before revocation: %#v err=%v", history, err)
	}
	if _, err = db.Pool.Exec(ctx, `DELETE FROM space_members WHERE space_id=$1 AND user_id=$2`, spaceID, memberID); err != nil {
		t.Fatal(err)
	}

	checks := []struct {
		name string
		call func() error
	}{
		{name: "comments", call: func() error { _, err := db.ListComments(ctx, memberID, sourceID); return err }},
		{name: "backlinks", call: func() error { _, err := db.Backlinks(ctx, memberID, sourceID); return err }},
		{name: "canvas", call: func() error { _, _, err := db.ListNotes(ctx, memberID, spaceID, ""); return err }},
		{name: "history", call: func() error { _, err := db.NoteHistory(ctx, memberID, sourceID); return err }},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			if err := check.call(); !errors.Is(err, pgx.ErrNoRows) {
				t.Fatalf("revoked member received content or wrong error: %v", err)
			}
		})
	}
}

func TestTodayReviewExcludesActivityFromDeletedNotesIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()

	ownerID, memberID, spaceID, noteID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	ownerName, memberName := "deleted_activity_owner_"+ownerID.String(), "deleted_activity_member_"+memberID.String()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text),($3,$4::citext,$4::text)`, ownerID, ownerName, memberID, memberName); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO user_preferences(user_id) VALUES($1),($2)`, ownerID, memberID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'deleted activity')`, spaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO space_members(space_id,user_id,permission) VALUES($1,$2,'view')`, spaceID, memberID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO notes(id,space_id,author_id,content) VALUES($1,$2,$3,'soon deleted note')`, noteID, spaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1 OR id=$2`, ownerID, memberID)

	comment, _, err := db.CreateComment(ctx, memberID, noteID, nil, "must disappear with its note", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.DeleteNote(ctx, ownerID, noteID); err != nil {
		t.Fatal(err)
	}
	review, err := db.TodayReview(ctx, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	for _, activity := range review.Activity {
		if activity.ID == comment.ID || activity.NoteID == noteID {
			t.Fatalf("activity from deleted note was returned: %#v", activity)
		}
	}
}

func TestTodayReviewTreatsDeletedCounterpartAsOrphanIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()

	userID, spaceID, survivorID, deletedID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	username := "orphan_owner_" + userID.String()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text)`, userID, username); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO user_preferences(user_id) VALUES($1)`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'deleted neighbor')`, spaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO notes(id,space_id,author_id,content) VALUES($1,$3,$4,'survivor'),($2,$3,$4,'deleted neighbor')`, survivorID, deletedID, spaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO note_edges(space_id,source_note_id,target_note_id,created_by) VALUES($1,$2,$3,$4)`, spaceID, survivorID, deletedID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE notes SET deleted_at=now() WHERE id=$1`, deletedID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)

	review, err := db.TodayReview(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if !reviewContains(review.Orphans, survivorID, false) {
		t.Fatalf("note linked only to a deleted counterpart was not returned as orphan: %#v", review.Orphans)
	}
}

func TestViewCommentAuthorCannotResolveThreadIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()

	ownerID, viewerID, spaceID, noteID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	ownerName, viewerName := "resolve_owner_"+ownerID.String(), "resolve_viewer_"+viewerID.String()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text),($3,$4::citext,$4::text)`, ownerID, ownerName, viewerID, viewerName); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'comment resolution permissions')`, spaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO space_members(space_id,user_id,permission) VALUES($1,$2,'view')`, spaceID, viewerID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO notes(id,space_id,author_id,content) VALUES($1,$2,$3,'shared note')`, noteID, spaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1 OR id=$2`, ownerID, viewerID)

	comment, _, err := db.CreateComment(ctx, viewerID, noteID, nil, "viewer-authored thread", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = db.ResolveComment(ctx, viewerID, comment.ID, true); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("view-only author resolved a thread: %v", err)
	}
	resolved, _, err := db.ResolveComment(ctx, ownerID, comment.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.ResolvedAt == nil || resolved.ResolvedBy == nil || *resolved.ResolvedBy != ownerID {
		t.Fatalf("space owner could not resolve the thread: %#v", resolved)
	}
}

func TestNoteMutationAndWebhookOutboxCommitTogetherIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()

	userID, spaceID, subscriptionID := uuid.New(), uuid.New(), uuid.New()
	username := "atomic_outbox_" + userID.String()
	if _, err = db.Pool.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text)`, userID, username); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	if _, err = db.Pool.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'atomic outbox')`, spaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO webhook_subscriptions(id,owner_id,name,url,secret_ciphertext,events) VALUES($1,$2,'atomic outbox','https://example.com/webhook','test-ciphertext',ARRAY['note.created'])`, subscriptionID, userID); err != nil {
		t.Fatal(err)
	}

	note, err := db.CreateNote(ctx, userID, Note{SpaceID: spaceID, Content: "mutation and outbox share one commit"})
	if err != nil {
		t.Fatal(err)
	}
	var notes, events, deliveries int
	var eventType, resourceID, content string
	err = db.Pool.QueryRow(ctx, `
		SELECT
		  (SELECT count(*) FROM notes WHERE id=$1),
		  (SELECT count(*) FROM space_events WHERE space_id=$2 AND resource_id=$1 AND event_type='note.created'),
		  (SELECT count(*) FROM webhook_deliveries WHERE subscription_id=$3 AND event_type='note.created' AND payload->>'resourceId'=CAST($1 AS text)),
		  (SELECT event_type FROM webhook_deliveries WHERE subscription_id=$3 LIMIT 1),
		  (SELECT payload->>'resourceId' FROM webhook_deliveries WHERE subscription_id=$3 LIMIT 1),
		  (SELECT payload->'data'->>'content' FROM webhook_deliveries WHERE subscription_id=$3 LIMIT 1)`,
		note.ID, spaceID, subscriptionID).Scan(&notes, &events, &deliveries, &eventType, &resourceID, &content)
	if err != nil {
		t.Fatal(err)
	}
	if notes != 1 || events != 1 || deliveries != 1 || eventType != "note.created" || resourceID != note.ID.String() || content != note.Content {
		t.Fatalf("atomic mutation/outbox mismatch notes=%d events=%d deliveries=%d type=%q resource=%q content=%q", notes, events, deliveries, eventType, resourceID, content)
	}
}

func reviewContains(items []ReviewItem, noteID uuid.UUID, requirePinned bool) bool {
	for _, item := range items {
		if item.ID == noteID && (!requirePinned || item.Pinned) {
			return true
		}
	}
	return false
}

func TestAIDailyQuotaReservationIsAtomicAcrossStoresIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	first, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Pool.Close()
	if err = first.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	second, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Pool.Close()

	userID := uuid.New()
	username := "quota_user_" + userID.String()
	if _, err = first.Pool.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text)`, userID, username); err != nil {
		t.Fatal(err)
	}
	defer first.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)

	type result struct {
		id      uuid.UUID
		allowed bool
		err     error
	}
	const contenders = 12
	start := make(chan struct{})
	results := make(chan result, contenders)
	var workers sync.WaitGroup
	for index := range contenders {
		workers.Add(1)
		db := first
		if index%2 == 1 {
			db = second
		}
		go func() {
			defer workers.Done()
			<-start
			id, _, allowed, reserveErr := db.ReserveAIDailyQuota(ctx, userID, 1)
			results <- result{id: id, allowed: allowed, err: reserveErr}
		}()
	}
	close(start)
	workers.Wait()
	close(results)

	allowed := 0
	var winningReservation uuid.UUID
	for item := range results {
		if item.err != nil {
			t.Fatal(item.err)
		}
		if item.allowed {
			allowed++
			winningReservation = item.id
		}
	}
	if allowed != 1 || winningReservation == uuid.Nil {
		t.Fatalf("expected exactly one atomic reservation, got %d (id=%s)", allowed, winningReservation)
	}
	if err = first.ReleaseAIDailyQuota(ctx, winningReservation); err != nil {
		t.Fatal(err)
	}

	replacement, used, replacementAllowed, err := second.ReserveAIDailyQuota(ctx, userID, 1)
	if err != nil || !replacementAllowed || used != 1 {
		t.Fatalf("released slot was not reusable: allowed=%v used=%d err=%v", replacementAllowed, used, err)
	}
	if err = second.ConsumeAIDailyQuota(ctx, replacement); err != nil {
		t.Fatal(err)
	}

	_, used, allowedAfterCall, err := first.ReserveAIDailyQuota(ctx, userID, 1)
	if err != nil {
		t.Fatal(err)
	}
	if allowedAfterCall || used != 1 {
		t.Fatalf("durable quota ledger did not retain usage: allowed=%v used=%d", allowedAfterCall, used)
	}
	var consumed, calls int
	if err = first.Pool.QueryRow(ctx, `
		SELECT
		  (SELECT count(*) FROM ai_quota_reservations WHERE user_id=$1 AND consumed_at IS NOT NULL AND expires_at>now()+interval '23 hours'),
		  (SELECT count(*) FROM ai_calls WHERE user_id=$1)`, userID).Scan(&consumed, &calls); err != nil {
		t.Fatal(err)
	}
	if consumed != 1 || calls != 0 {
		t.Fatalf("quota usage must survive independently of ai_calls logging: consumed=%d calls=%d", consumed, calls)
	}
}

func TestHybridSearchUsesTheActualFallbackVectorSpaceIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "gateway unavailable", http.StatusBadGateway)
	}))
	defer gateway.Close()
	db.embeddings.provider = intelligence.Provider{Remote: &intelligence.RemoteConfig{
		BaseURL: gateway.URL,
		Model:   "remote-model",
		Timeout: time.Second,
	}}
	db.embeddings.loadedAt = time.Now()

	userID, spaceID, noteID := uuid.New(), uuid.New(), uuid.New()
	username := "fallback_search_" + userID.String()
	query := "semantic-fallback-" + noteID.String()
	if _, err = db.Pool.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text)`, userID, username); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	if _, err = db.Pool.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'fallback vector space')`, spaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO notes(id,space_id,author_id,content) VALUES($1,$2,$3,$4)`, noteID, spaceID, userID, query); err != nil {
		t.Fatal(err)
	}
	// This vector belongs to the configured remote space and is deliberately
	// unusable. A local fallback query must ignore it and locally embed the row.
	if _, err = db.Pool.Exec(ctx, `
		INSERT INTO note_embeddings(note_id,algorithm,model,dimensions,vector,content_version)
		VALUES($1,$2,'remote-model',2,$3,1)`, noteID, db.embeddings.provider.Algorithm(), []float32{0, 0}); err != nil {
		t.Fatal(err)
	}

	page, err := db.SearchNotesHybrid(ctx, userID, SearchOptions{Query: query, Limit: 5})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Notes) != 1 || page.Notes[0].ID != noteID {
		t.Fatalf("fallback search omitted the note: %#v", page.Notes)
	}
	if !strings.Contains(page.Notes[0].Reason, "의미상 유사") {
		t.Fatalf("search compared the fallback query in the wrong vector space: %#v", page.Notes[0])
	}
}

func TestGatewayChangeWithSameModelReembedsIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	newGateway := func(calls *atomic.Int64, vector []float32) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			calls.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"index": 0, "embedding": vector}}})
		}))
	}
	var firstCalls, secondCalls atomic.Int64
	firstGateway := newGateway(&firstCalls, []float32{1, 0})
	defer firstGateway.Close()
	secondGateway := newGateway(&secondCalls, []float32{0, 2, 0})
	defer secondGateway.Close()
	firstProvider := intelligence.Provider{Remote: &intelligence.RemoteConfig{BaseURL: firstGateway.URL, Model: "shared-model", Timeout: time.Second}}
	secondProvider := intelligence.Provider{Remote: &intelligence.RemoteConfig{BaseURL: secondGateway.URL, Model: "shared-model", Timeout: time.Second}}
	if firstProvider.Algorithm() == secondProvider.Algorithm() {
		t.Fatal("different gateways with the same model label shared a vector-space identifier")
	}

	userID, spaceID, noteID := uuid.New(), uuid.New(), uuid.New()
	username := "embedding_gateway_change_" + userID.String()
	if _, err = db.Pool.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text)`, userID, username); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	if _, err = db.Pool.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'gateway identity')`, spaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO notes(id,space_id,author_id,content) VALUES($1,$2,$3,'same content version')`, noteID, spaceID, userID); err != nil {
		t.Fatal(err)
	}
	notes := []Note{{ID: noteID, SpaceID: spaceID, Content: "same content version", Version: 1}}

	db.embeddings.mu.Lock()
	db.embeddings.provider = firstProvider
	db.embeddings.loadedAt = time.Now()
	db.embeddings.mu.Unlock()
	db.ensureEmbeddings(ctx, notes)
	var algorithm, model string
	var dimensions int
	if err = db.Pool.QueryRow(ctx, `SELECT algorithm,model,dimensions FROM note_embeddings WHERE note_id=$1`, noteID).Scan(&algorithm, &model, &dimensions); err != nil {
		t.Fatal(err)
	}
	if algorithm != firstProvider.Algorithm() || model != "shared-model" || dimensions != 2 || firstCalls.Load() != 1 {
		t.Fatalf("first gateway embedding mismatch: algorithm=%q model=%q dimensions=%d calls=%d", algorithm, model, dimensions, firstCalls.Load())
	}

	db.embeddings.mu.Lock()
	db.embeddings.provider = secondProvider
	db.embeddings.loadedAt = time.Now()
	db.embeddings.remoteRetryAt = time.Time{}
	db.embeddings.mu.Unlock()
	db.ensureEmbeddings(ctx, notes)
	if err = db.Pool.QueryRow(ctx, `SELECT algorithm,model,dimensions FROM note_embeddings WHERE note_id=$1`, noteID).Scan(&algorithm, &model, &dimensions); err != nil {
		t.Fatal(err)
	}
	if algorithm != secondProvider.Algorithm() || model != "shared-model" || dimensions != 3 || firstCalls.Load() != 1 || secondCalls.Load() != 1 {
		t.Fatalf("gateway change did not re-embed: algorithm=%q model=%q dimensions=%d calls=%d/%d", algorithm, model, dimensions, firstCalls.Load(), secondCalls.Load())
	}
	loaded := db.loadEmbeddings(ctx, notes)
	if len(loaded[noteID]) != 3 || loaded[noteID][1] != 1 {
		t.Fatalf("new gateway vector space was not loaded: %#v", loaded)
	}
}

func TestStaleGatewayResponseCannotOverwriteCurrentEmbeddingIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	var originalGateway []byte
	if err = db.Pool.QueryRow(ctx, `SELECT value FROM app_settings WHERE key='ai_gateway'`).Scan(&originalGateway); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = db.Pool.Exec(context.Background(), `UPDATE app_settings SET value=$1::jsonb,updated_at=clock_timestamp() WHERE key='ai_gateway'`, originalGateway)
		db.InvalidateEmbeddingProvider()
	}()

	oldStarted := make(chan struct{})
	releaseOld := make(chan struct{})
	var startOnce, releaseOnce sync.Once
	var oldCalls, currentCalls atomic.Int64
	oldGateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		oldCalls.Add(1)
		startOnce.Do(func() { close(oldStarted) })
		select {
		case <-releaseOld:
		case <-r.Context().Done():
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"index": 0, "embedding": []float32{1, 0}}}})
	}))
	defer oldGateway.Close()
	defer releaseOnce.Do(func() { close(releaseOld) })
	currentGateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		currentCalls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"index": 0, "embedding": []float32{0, 2, 0}}}})
	}))
	defer currentGateway.Close()

	putGateway := func(baseURL string) {
		t.Helper()
		raw, marshalErr := json.Marshal(embeddingSettings{BaseURL: baseURL, EmbeddingModel: "shared-model", TimeoutSeconds: 5})
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		if _, updateErr := db.Pool.Exec(ctx, `UPDATE app_settings SET value=$1::jsonb,updated_at=clock_timestamp() WHERE key='ai_gateway'`, raw); updateErr != nil {
			t.Fatal(updateErr)
		}
		db.InvalidateEmbeddingProvider()
	}

	userID, spaceID, noteID := uuid.New(), uuid.New(), uuid.New()
	username := "stale_embedding_" + userID.String()
	if _, err = db.Pool.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text)`, userID, username); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	if _, err = db.Pool.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'stale gateway fence')`, spaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO notes(id,space_id,author_id,content) VALUES($1,$2,$3,'same content version')`, noteID, spaceID, userID); err != nil {
		t.Fatal(err)
	}
	notes := []Note{{ID: noteID, SpaceID: spaceID, Content: "same content version", Version: 1}}

	putGateway(oldGateway.URL)
	oldProvider := db.EmbeddingProvider(ctx)
	if oldProvider.Remote == nil || !oldProvider.Remote.SettingsManaged {
		t.Fatal("the settings-backed provider was not marked for configuration fencing")
	}
	oldDone := make(chan struct{})
	go func() {
		defer close(oldDone)
		db.ensureEmbeddings(ctx, notes)
	}()
	select {
	case <-oldStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("the old gateway request did not start")
	}

	putGateway(currentGateway.URL)
	currentProvider := db.EmbeddingProvider(ctx)
	if currentProvider.Algorithm() == oldProvider.Algorithm() {
		t.Fatal("the gateway change did not produce a new vector-space identifier")
	}
	db.ensureEmbeddings(ctx, notes)
	releaseOnce.Do(func() { close(releaseOld) })
	select {
	case <-oldDone:
	case <-time.After(5 * time.Second):
		t.Fatal("the stale gateway request did not finish")
	}

	var algorithm, model string
	var dimensions, version int
	var vector []float32
	if err = db.Pool.QueryRow(ctx, `SELECT algorithm,model,dimensions,vector,content_version FROM note_embeddings WHERE note_id=$1`, noteID).Scan(&algorithm, &model, &dimensions, &vector, &version); err != nil {
		t.Fatal(err)
	}
	if algorithm != currentProvider.Algorithm() || model != "shared-model" || dimensions != 3 || version != 1 || len(vector) != 3 || vector[1] != 1 {
		t.Fatalf("stale response replaced the current embedding: algorithm=%q model=%q dimensions=%d version=%d vector=%v", algorithm, model, dimensions, version, vector)
	}
	if oldCalls.Load() != 1 || currentCalls.Load() != 1 {
		t.Fatalf("unexpected gateway calls: old=%d current=%d", oldCalls.Load(), currentCalls.Load())
	}

	if err = db.persistEmbeddingBatch(ctx,
		[]embeddingTarget{{ID: noteID, Content: "older content", Version: 0}},
		[][]float32{{1, 0, 0, 0}}, "legacy-vector-space", "legacy-model", intelligence.Provider{}); err != nil {
		t.Fatal(err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT algorithm,dimensions,content_version FROM note_embeddings WHERE note_id=$1`, noteID).Scan(&algorithm, &dimensions, &version); err != nil {
		t.Fatal(err)
	}
	if algorithm != currentProvider.Algorithm() || dimensions != 3 || version != 1 {
		t.Fatalf("an older content version replaced the current embedding: algorithm=%q dimensions=%d version=%d", algorithm, dimensions, version)
	}
}

func TestLoadEmbeddingsUsesOneFallbackVectorSpaceIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	var gatewayCalls atomic.Int64
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		gatewayCalls.Add(1)
		http.Error(w, "gateway unavailable", http.StatusBadGateway)
	}))
	defer gateway.Close()
	db.embeddings.provider = intelligence.Provider{Remote: &intelligence.RemoteConfig{
		BaseURL: gateway.URL,
		Model:   "remote-model",
		Timeout: time.Second,
	}}
	db.embeddings.loadedAt = time.Now()

	userID, spaceID := uuid.New(), uuid.New()
	username := "fallback_load_" + userID.String()
	if _, err = db.Pool.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text)`, userID, username); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	if _, err = db.Pool.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'fallback load')`, spaceID, userID); err != nil {
		t.Fatal(err)
	}
	noteIDs := make([]uuid.UUID, embeddingBatchSize+2)
	notes := make([]Note, len(noteIDs))
	batch := &pgx.Batch{}
	for index := range noteIDs {
		noteIDs[index] = uuid.New()
		content := "fallback note " + noteIDs[index].String()
		notes[index] = Note{ID: noteIDs[index], SpaceID: spaceID, Content: content, Version: 1}
		batch.Queue(`INSERT INTO notes(id,space_id,author_id,content) VALUES($1,$2,$3,$4)`, noteIDs[index], spaceID, userID, content)
	}
	results := db.Pool.SendBatch(ctx, batch)
	for range noteIDs {
		if _, err = results.Exec(); err != nil {
			_ = results.Close()
			t.Fatal(err)
		}
	}
	if err = results.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `
		INSERT INTO note_embeddings(note_id,algorithm,model,dimensions,vector,content_version)
		VALUES($1,$2,'remote-model',2,$3,1)`, noteIDs[0], db.embeddings.provider.Algorithm(), []float32{1, 0}); err != nil {
		t.Fatal(err)
	}

	db.ensureEmbeddings(ctx, notes)
	db.ensureEmbeddings(ctx, notes)
	if calls := gatewayCalls.Load(); calls != 1 {
		t.Fatalf("current local fallbacks retried the unavailable gateway %d times", calls)
	}
	db.embeddings.mu.Lock()
	db.embeddings.remoteRetryAt = time.Now().Add(-time.Second)
	db.embeddings.mu.Unlock()
	db.ensureEmbeddings(ctx, notes)
	if calls := gatewayCalls.Load(); calls != 2 {
		t.Fatalf("gateway was not retried once after the fallback window: %d calls", calls)
	}
	vectors := db.loadEmbeddings(ctx, notes)
	if len(vectors) != len(notes) || len(vectors[noteIDs[0]]) != intelligence.Dimensions || len(vectors[noteIDs[len(noteIDs)-1]]) != intelligence.Dimensions {
		t.Fatalf("outage fallback omitted vectors: %#v", vectors)
	}
	var localRows, algorithms int
	if err = db.Pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE algorithm=$2),count(DISTINCT algorithm)
		FROM note_embeddings WHERE note_id=ANY($1)`, noteIDs, intelligence.LocalAlgorithm).Scan(&localRows, &algorithms); err != nil {
		t.Fatal(err)
	}
	if localRows != len(notes) || algorithms != 1 {
		t.Fatalf("fallback comparison set was not normalized locally: local=%d algorithms=%d", localRows, algorithms)
	}
}

func TestAIExcludedNotesNeverReachRemoteEmbeddingGatewayIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	var gatewayCalls atomic.Int64
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		gatewayCalls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"index": 0, "embedding": []float32{1, 0}}}})
	}))
	defer gateway.Close()
	db.embeddings.provider = intelligence.Provider{Remote: &intelligence.RemoteConfig{
		BaseURL: gateway.URL,
		Model:   "remote-model",
		Timeout: time.Second,
	}}
	db.embeddings.loadedAt = time.Now()

	userID := uuid.New()
	spaceExcludedID, mixedSpaceID := uuid.New(), uuid.New()
	spaceNoteID, privateNoteID, publicNoteID := uuid.New(), uuid.New(), uuid.New()
	username := "embedding_privacy_" + userID.String()
	if _, err = db.Pool.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text)`, userID, username); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	if _, err = db.Pool.Exec(ctx, `
		INSERT INTO spaces(id,owner_id,name,ai_excluded) VALUES
		($1,$3,'excluded space',true),($2,$3,'mixed space',false)`, spaceExcludedID, mixedSpaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `
		INSERT INTO notes(id,space_id,author_id,content,ai_excluded) VALUES
		($1,$4,$6,'space private secret',false),
		($2,$5,$6,'note private secret',true),
		($3,$5,$6,'ordinary thought',false)`, spaceNoteID, privateNoteID, publicNoteID, spaceExcludedID, mixedSpaceID, userID); err != nil {
		t.Fatal(err)
	}

	if err = db.UpsertEmbedding(ctx, spaceNoteID, "space private secret", 1); err != nil {
		t.Fatal(err)
	}
	if err = db.UpsertEmbedding(ctx, privateNoteID, "note private secret", 1); err != nil {
		t.Fatal(err)
	}
	db.ensureEmbeddings(ctx, []Note{
		{ID: privateNoteID, SpaceID: mixedSpaceID, Content: "note private secret", AIExcluded: true, Version: 1},
		{ID: publicNoteID, SpaceID: mixedSpaceID, Content: "ordinary thought", Version: 1},
	})
	page, err := db.SearchNotesHybrid(ctx, userID, SearchOptions{
		Query:   "space private secret",
		SpaceID: &spaceExcludedID,
		Limit:   5,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Notes) != 1 || page.Notes[0].ID != spaceNoteID {
		t.Fatalf("AI-excluded space search lost its local result: %#v", page.Notes)
	}
	if calls := gatewayCalls.Load(); calls != 0 {
		t.Fatalf("AI-excluded content or scoped query reached the remote embedding gateway %d times", calls)
	}
	page, err = db.SearchNotesHybrid(ctx, userID, SearchOptions{
		Query:   "ordinary thought",
		SpaceID: &mixedSpaceID,
		Limit:   5,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Notes) == 0 || page.Notes[0].ID != publicNoteID || gatewayCalls.Load() != 1 {
		t.Fatalf("ordinary scoped search did not retain the configured gateway: notes=%#v calls=%d", page.Notes, gatewayCalls.Load())
	}
	var localRows int
	if err = db.Pool.QueryRow(ctx, `
		SELECT count(*) FROM note_embeddings
		WHERE note_id=ANY($1) AND algorithm=$2`, []uuid.UUID{spaceNoteID, privateNoteID, publicNoteID}, intelligence.LocalAlgorithm).Scan(&localRows); err != nil {
		t.Fatal(err)
	}
	if localRows != 3 {
		t.Fatalf("AI exclusions did not keep the comparison set local: %d rows", localRows)
	}
}
