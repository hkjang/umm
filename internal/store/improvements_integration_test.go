package store

import (
	"context"
	"os"
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

func reviewContains(items []ReviewItem, noteID uuid.UUID, requirePinned bool) bool {
	for _, item := range items {
		if item.ID == noteID && (!requirePinned || item.Pinned) {
			return true
		}
	}
	return false
}
