package store

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
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
