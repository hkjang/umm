package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/auth"
	"github.com/hkjang/umm/internal/store"
)

func TestIdempotencyPendingLeaseRecoversAfterCrashIntegration(t *testing.T) {
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

	userID := uuid.New()
	username := "idempotency_lease_" + userID.String()
	if _, err = db.Pool.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text)`, userID, username); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID)
	authService := &auth.Service{Store: db}
	session, err := authService.CreateSession(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}

	calls := 0
	server := &Server{Store: db}
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		writeJSON(w, http.StatusCreated, map[string]bool{"created": true})
	})
	handler := authService.Middleware(auth.Require(server.idempotency(next)))
	body := `{"content":"recover after crash"}`
	path := "/api/v1/spaces/" + uuid.NewString() + "/notes"
	requestFor := func(key string) *http.Request {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		request.Header.Set("Idempotency-Key", key)
		request.AddCookie(&http.Cookie{Name: auth.CookieName, Value: session})
		return request
	}

	staleKey := "lease-expired-12345678"
	staleIdentity := idempotencyRequestIdentity(requestFor(staleKey), []byte(body))
	if _, err = db.Pool.Exec(ctx, `INSERT INTO idempotency_records(user_id,idempotency_key,method,path,state,created_at,expires_at) VALUES($1,$2,'POST',$3,'pending',now()-interval '3 minutes',now()-interval '1 second')`, userID, staleKey, staleIdentity); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, requestFor(staleKey))
	if response.Code != http.StatusCreated || calls != 1 {
		t.Fatalf("expired reservation response=%d calls=%d body=%s", response.Code, calls, response.Body.String())
	}
	var state string
	var completedExpiry time.Time
	if err = db.Pool.QueryRow(ctx, `SELECT state,expires_at FROM idempotency_records WHERE user_id=$1 AND idempotency_key=$2`, userID, staleKey).Scan(&state, &completedExpiry); err != nil {
		t.Fatal(err)
	}
	if state != "completed" || time.Until(completedExpiry) < 23*time.Hour {
		t.Fatalf("recovered reservation state=%s expiry=%s", state, completedExpiry)
	}

	activeKey := "lease-active-12345678"
	activeIdentity := idempotencyRequestIdentity(requestFor(activeKey), []byte(body))
	if _, err = db.Pool.Exec(ctx, `INSERT INTO idempotency_records(user_id,idempotency_key,method,path,state,expires_at) VALUES($1,$2,'POST',$3,'pending',now()+interval '2 minutes')`, userID, activeKey, activeIdentity); err != nil {
		t.Fatal(err)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, requestFor(activeKey))
	retryAfter, parseErr := strconv.Atoi(response.Header().Get("Retry-After"))
	if response.Code != http.StatusTooEarly || calls != 1 || parseErr != nil || retryAfter < 1 || retryAfter > int(idempotencyPendingLease/time.Second) {
		t.Fatalf("active reservation response=%d calls=%d retry-after=%q body=%s", response.Code, calls, response.Header().Get("Retry-After"), response.Body.String())
	}
}
