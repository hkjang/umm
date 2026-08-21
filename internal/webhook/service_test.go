package webhook

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/cryptoutil"
	"github.com/hkjang/umm/internal/store"
)

func TestNewUsesGuardedDirectTransport(t *testing.T) {
	service := New(nil, nil)
	transport, ok := service.client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("webhook transport has type %T, want *http.Transport", service.client.Transport)
	}
	if transport.Proxy != nil {
		t.Fatal("webhook transport must not use a proxy")
	}
	if transport.DialContext == nil {
		t.Fatal("webhook transport must use the guarded dialer")
	}
}

func TestPublicIPRejectsPrivateAndReservedRanges(t *testing.T) {
	tests := map[string]bool{
		"8.8.8.8":              true,
		"2606:4700:4700::1111": true,
		"127.0.0.1":            false,
		"10.1.2.3":             false,
		"100.64.0.1":           false,
		"169.254.1.1":          false,
		"192.0.2.8":            false,
		"198.18.0.1":           false,
		"198.51.100.8":         false,
		"203.0.113.8":          false,
		"240.0.0.1":            false,
		"::1":                  false,
		"fc00::1":              false,
		"fe80::1":              false,
		"2001:db8::1":          false,
	}
	for raw, want := range tests {
		if got := publicIP(net.ParseIP(raw)); got != want {
			t.Errorf("publicIP(%q) = %v, want %v", raw, got, want)
		}
	}
}

func TestValidateEndpointRejectsUnsafeURLs(t *testing.T) {
	for _, raw := range []string{
		"http://example.com/hook",
		"https://user:pass@example.com/hook",
		"https://example.com:8443/hook",
		"https://example.com/hook#secret",
		"https://127.0.0.1/hook",
		"https://localhost/hook",
	} {
		if err := ValidateEndpoint(context.Background(), raw); err == nil {
			t.Errorf("ValidateEndpoint(%q) accepted an unsafe URL", raw)
		}
	}
}

func TestValidateEvents(t *testing.T) {
	if !ValidateEvents([]string{"note.created", "comment.created"}) || !ValidateEvents([]string{"*"}) {
		t.Fatal("supported webhook events were rejected")
	}
	if ValidateEvents(nil) || ValidateEvents([]string{"unknown.event"}) {
		t.Fatal("unsupported webhook events were accepted")
	}
}

func TestDurableQueueSurvivesServiceRestartIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db, err := store.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	cipher, err := cryptoutil.New(bytes.Repeat([]byte{0x42}, 32))
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, err := cipher.Encrypt("restart-safe-secret")
	if err != nil {
		t.Fatal(err)
	}

	userID, ownerID, subscriptionID, eventID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	username := "webhook_restart_" + userID.String()
	ownerName := "webhook_space_owner_" + ownerID.String()
	if _, err = db.Pool.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text),($3,$4::citext,$4::text)`, userID, username, ownerID, ownerName); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1 OR id=$2`, userID, ownerID)
	if _, err = db.Pool.Exec(ctx, `INSERT INTO webhook_subscriptions(id,owner_id,name,url,secret_ciphertext,events) VALUES($1,$2,'restart queue','https://example.com/webhook',$3,ARRAY['note.created'])`, subscriptionID, userID, ciphertext); err != nil {
		t.Fatal(err)
	}

	beforeRestart := New(db, cipher)
	queued, err := beforeRestart.Enqueue(ctx, Event{ID: eventID, Type: "note.created", ActorID: userID, Data: map[string]any{"source": "integration"}})
	if err != nil {
		t.Fatal(err)
	}
	if queued != 1 {
		t.Fatalf("persisted deliveries = %d, want 1", queued)
	}
	var deliveryID uuid.UUID
	var status string
	var payload []byte
	if err = db.Pool.QueryRow(ctx, `UPDATE webhook_deliveries SET next_attempt_at='2000-01-01',created_at='2000-01-01' WHERE subscription_id=$1 AND event_id=$2 RETURNING id,status,payload`, subscriptionID, eventID).
		Scan(&deliveryID, &status, &payload); err != nil {
		t.Fatal(err)
	}
	if status != "queued" {
		t.Fatalf("delivery status = %q, want queued", status)
	}
	var persisted Event
	if err = json.Unmarshal(payload, &persisted); err != nil {
		t.Fatal(err)
	}
	if persisted.ID != eventID || persisted.Type != "note.created" || persisted.CreatedAt.IsZero() {
		t.Fatalf("persisted event is incomplete: %#v", persisted)
	}

	afterRestart := New(db, cipher)
	claimed, ok, err := afterRestart.claimNext(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !ok || claimed.ID != deliveryID || claimed.SubscriptionID != subscriptionID {
		t.Fatalf("restarted service claimed %#v, ok=%v; want delivery %s", claimed, ok, deliveryID)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT status FROM webhook_deliveries WHERE id=$1`, deliveryID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "processing" {
		t.Fatalf("claimed delivery status = %q, want processing", status)
	}
	if elapsed := time.Since(persisted.CreatedAt); elapsed < 0 || elapsed > time.Minute {
		t.Fatalf("unexpected persisted event timestamp %s", persisted.CreatedAt)
	}
	if err = afterRestart.finishSuccess(ctx, claimed, http.StatusNoContent, 1); err != nil {
		t.Fatal(err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT status,payload FROM webhook_deliveries WHERE id=$1`, deliveryID).Scan(&status, &payload); err != nil {
		t.Fatal(err)
	}
	if status != "delivered" || string(payload) != "{}" {
		t.Fatalf("terminal delivery status=%q payload=%s, want delivered/{}", status, payload)
	}

	spaceID, revokedEventID := uuid.New(), uuid.New()
	if _, err = db.Pool.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'webhook authorization')`, spaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO space_members(space_id,user_id,permission) VALUES($1,$2,'view')`, spaceID, userID); err != nil {
		t.Fatal(err)
	}
	queued, err = afterRestart.Enqueue(ctx, Event{ID: revokedEventID, Type: "note.created", SpaceID: spaceID, ActorID: ownerID, Data: map[string]any{"scope": "current"}})
	if err != nil {
		t.Fatal(err)
	}
	if queued != 1 {
		t.Fatalf("authorized deliveries = %d, want 1", queued)
	}
	if _, err = db.Pool.Exec(ctx, `DELETE FROM space_members WHERE space_id=$1 AND user_id=$2`, spaceID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `UPDATE webhook_deliveries SET next_attempt_at='2000-01-01',created_at='2000-01-01' WHERE subscription_id=$1 AND event_id=$2`, subscriptionID, revokedEventID); err != nil {
		t.Fatal(err)
	}
	revoked, ok, err := afterRestart.claimNext(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("delivery was not claimable after access revocation")
	}
	if err = afterRestart.deliverClaimed(ctx, revoked); err == nil {
		t.Fatal("delivery proceeded after the subscription owner lost space access")
	}
	var failureCount int
	if err = db.Pool.QueryRow(ctx, `SELECT d.status,d.payload,s.failure_count FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id WHERE d.id=$1`, revoked.ID).Scan(&status, &payload, &failureCount); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || string(payload) != "{}" || failureCount != 0 {
		t.Fatalf("revoked delivery status=%q payload=%s failure_count=%d, want failed/{}/0", status, payload, failureCount)
	}
	if _, err = db.Pool.Exec(ctx, `UPDATE webhook_deliveries SET attempted_at=now()-interval '31 days' WHERE subscription_id=$1`, subscriptionID); err != nil {
		t.Fatal(err)
	}
	afterRestart.cleanupDeliveries(ctx)
	var retained int
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM webhook_deliveries WHERE subscription_id=$1`, subscriptionID).Scan(&retained); err != nil {
		t.Fatal(err)
	}
	if retained != 0 {
		t.Fatalf("terminal delivery retention kept %d rows older than %d days", retained, deliveryRetentionDays)
	}
}

func TestFinishFailurePersistsBoundedUTF8Integration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db, err := store.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	userID, subscriptionID, deliveryID := uuid.New(), uuid.New(), uuid.New()
	username := "webhook_utf8_" + userID.String()
	if _, err = db.Pool.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text)`, userID, username); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	if _, err = db.Pool.Exec(ctx, `INSERT INTO webhook_subscriptions(id,owner_id,name,url,secret_ciphertext,events) VALUES($1,$2,'UTF-8 failure','https://example.com/webhook','unused',ARRAY['note.created'])`, subscriptionID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO webhook_deliveries(id,subscription_id,event_id,event_type,payload,status,claimed_at) VALUES($1,$2,$3,'note.created','{}','processing',now())`, deliveryID, subscriptionID, uuid.New()); err != nil {
		t.Fatal(err)
	}

	rawError := strings.Repeat("a", 499) + "한" + string([]byte{0xff}) + "tail"
	service := New(db, nil)
	if err = service.finishFailure(ctx, delivery{ID: deliveryID, SubscriptionID: subscriptionID}, http.StatusBadGateway, errors.New(rawError), 2, true); err != nil {
		t.Fatal(err)
	}

	var status, deliveryError, lastError string
	var attemptCount, responseStatus, failureCount int
	if err = db.Pool.QueryRow(ctx, `
		SELECT d.status,d.error,d.attempt_count,d.response_status,s.failure_count,s.last_error
		FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id=d.subscription_id
		WHERE d.id=$1`, deliveryID).Scan(&status, &deliveryError, &attemptCount, &responseStatus, &failureCount, &lastError); err != nil {
		t.Fatal(err)
	}
	want := strings.Repeat("a", 499)
	if status != "failed" || deliveryError != want || lastError != want || attemptCount != 2 || responseStatus != http.StatusBadGateway || failureCount != 1 {
		t.Fatalf("persisted failure status=%q error=%q last_error=%q attempts=%d response=%d failures=%d", status, deliveryError, lastError, attemptCount, responseStatus, failureCount)
	}
	if !utf8.ValidString(deliveryError) || len(deliveryError) > 500 {
		t.Fatalf("delivery error must be valid UTF-8 within 500 bytes: len=%d valid=%v", len(deliveryError), utf8.ValidString(deliveryError))
	}
}
