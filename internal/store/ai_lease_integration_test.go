package store

import (
	"context"
	"errors"
	"net/url"
	"os"
	"testing"
	"time"
)

func TestAILeaseCapacityDoesNotConsumeRequestPoolIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("pool_max_conns", "1")
	parsed.RawQuery = query.Encode()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	db, err := Open(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()

	first, releaseFirst, err := db.BeginAILease(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = first.Rollback(context.Background())
		releaseFirst()
	}()
	second, releaseSecond, err := db.BeginAILease(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = second.Rollback(context.Background())
		releaseSecond()
	}()

	requestCtx, requestCancel := context.WithTimeout(ctx, 500*time.Millisecond)
	err = db.Pool.Ping(requestCtx)
	requestCancel()
	if err != nil {
		t.Fatalf("two active AI leases consumed the one-connection request pool: %v", err)
	}
	if acquired := db.Pool.Stat().AcquiredConns(); acquired != 0 {
		t.Fatalf("request-pool connections held by AI leases = %d, want 0", acquired)
	}

	blockedCtx, blockedCancel := context.WithTimeout(ctx, 150*time.Millisecond)
	_, _, err = db.BeginAILease(blockedCtx)
	blockedCancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("third AI lease exceeded bounded capacity: %v", err)
	}

	if err = first.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	releaseFirst()
	third, releaseThird, err := db.BeginAILease(ctx)
	if err != nil {
		t.Fatalf("AI lease capacity did not resume after release: %v", err)
	}
	if err = third.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	releaseThird()
}
