package realtime

import (
	"context"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPublishWakesOnlyMatchingSubscribers(t *testing.T) {
	hub := New(nil)
	watched, other := uuid.New(), uuid.New()
	subscription := hub.Subscribe(watched)
	defer subscription.Close()
	bystander := hub.Subscribe(other)
	defer bystander.Close()

	hub.Publish(watched)
	select {
	case <-subscription.C():
	case <-time.After(time.Second):
		t.Fatal("subscriber of the published space was not woken")
	}
	select {
	case <-bystander.C():
		t.Fatal("subscriber of an unrelated space was woken")
	default:
	}
}

func TestPublishCoalescesWithoutBlocking(t *testing.T) {
	hub := New(nil)
	spaceID := uuid.New()
	subscription := hub.Subscribe(spaceID)
	defer subscription.Close()

	// A reader that is busy must never stall a writer: extra signals collapse
	// into the single pending one the reader will act on.
	for range 100 {
		hub.Publish(spaceID)
	}
	if got := len(subscription.C()); got != 1 {
		t.Fatalf("expected one coalesced signal, got %d", got)
	}
}

func TestCloseIsIdempotentAndDeregisters(t *testing.T) {
	hub := New(nil)
	spaceID := uuid.New()
	subscription := hub.Subscribe(spaceID)
	subscription.Close()
	subscription.Close()

	if subscribers, spaces, _, _ := hub.Stats(); subscribers != 0 || spaces != 0 {
		t.Fatalf("expected an empty registry, got %d subscribers across %d spaces", subscribers, spaces)
	}
	// Publishing to a space nobody watches must remain a no-op.
	hub.Publish(spaceID)
	select {
	case _, open := <-subscription.C():
		if !open {
			t.Fatal("Close must not close the signal channel while a publisher may still hold a reference")
		}
	default:
	}
}

func TestPublishAndCloseCanRaceSafely(t *testing.T) {
	hub := New(nil)
	spaceID := uuid.New()
	for range 1000 {
		subscription := hub.Subscribe(spaceID)
		start := make(chan struct{})
		var workers sync.WaitGroup
		workers.Add(2)
		go func() {
			defer workers.Done()
			<-start
			hub.Publish(spaceID)
		}()
		go func() {
			defer workers.Done()
			<-start
			subscription.Close()
		}()
		close(start)
		workers.Wait()
	}
}

func TestParsePayload(t *testing.T) {
	spaceID := uuid.New()
	if got, ok := parsePayload(spaceID.String() + " 42"); !ok || got != spaceID {
		t.Fatalf("expected %s, got %s (ok=%v)", spaceID, got, ok)
	}
	if got, ok := parsePayload(spaceID.String()); !ok || got != spaceID {
		t.Fatalf("payload without a sequence should still parse, got %s (ok=%v)", got, ok)
	}
	for _, payload := range []string{"", "not-a-uuid 1", spaceID.String() + " abc"} {
		if _, ok := parsePayload(payload); ok {
			t.Fatalf("expected %q to be rejected", payload)
		}
	}
}

func TestRunLeavesSingleConnectionPoolForRequestsIntegration(t *testing.T) {
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
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if pool.Config().MaxConns != 1 {
		t.Fatalf("test requires a one-connection pool, got %d", pool.Config().MaxConns)
	}

	hub := New(pool)
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		hub.Run(runCtx)
		close(done)
	}()
	returned := false
	select {
	case <-done:
		returned = true
	case <-time.After(500 * time.Millisecond):
	}
	if !returned {
		cancel()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("LISTEN hub did not release the single pool connection after cancellation")
		}
		t.Fatal("LISTEN hub must disable itself instead of occupying the only request connection")
	}
	cancel()
	if hub.Listening() {
		t.Fatal("single-connection fallback must report the listener as unavailable")
	}
	pingCtx, pingCancel := context.WithTimeout(ctx, time.Second)
	defer pingCancel()
	if err = pool.Ping(pingCtx); err != nil {
		t.Fatalf("single request connection was unavailable: %v", err)
	}
}
