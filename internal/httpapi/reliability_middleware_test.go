package httpapi

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestOpaqueOffsetCursorRoundTripAndValidation(t *testing.T) {
	for _, offset := range []int{1, 25, 1_000_000} {
		encoded := encodeOffsetCursor(offset)
		decoded, ok := decodeOffsetCursor(encoded)
		if !ok || decoded != offset {
			t.Fatalf("cursor round trip %d => %q => %d, %v", offset, encoded, decoded, ok)
		}
	}
	for _, invalid := range []string{"not-base64!", "b2Zmc2V0Oi0x", "b2Zmc2V0OjEwMDAwMDE", "cGFnZTox"} {
		if _, ok := decodeOffsetCursor(invalid); ok {
			t.Errorf("invalid cursor %q was accepted", invalid)
		}
	}
}

func TestMentionParsingDeduplicatesCaseInsensitively(t *testing.T) {
	got := mentionedUsernameTokens("@Alice 확인 부탁해요. (@bob) @ALICE email@example.com")
	want := []string{"alice", "bob)"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mentions = %#v, want %#v", got, want)
	}
}

func TestMentionParsingSupportsOIDCAndUnicodeUsernames(t *testing.T) {
	got := mentionedUsernameTokens("@alice@example.com, 확인해 주세요. (@김민수) @δοκιμή+team")
	want := []string{"alice@example.com,", "김민수)", "δοκιμή+team"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mentions = %#v, want %#v", got, want)
	}
}

func TestMentionParsingPreservesUsernamePunctuation(t *testing.T) {
	got := mentionedUsernameTokens("@ops! @alice., @normal,")
	want := []string{"ops!", "alice.,", "normal,"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mention tokens = %#v, want %#v", got, want)
	}
}

func TestCommentCreateErrorsPreserveRetryableFailures(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{name: "missing note", err: pgx.ErrNoRows, want: http.StatusNotFound},
		{name: "invalid parent", err: store.ErrInvalidParentComment, want: http.StatusBadRequest},
		{name: "database failure", err: errors.New("database unavailable"), want: http.StatusInternalServerError},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			status, _ := commentCreateError(test.err)
			if status != test.want {
				t.Fatalf("status = %d, want %d", status, test.want)
			}
		})
	}
}

func TestCommentMutationErrorsPreserveRetryableFailures(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{name: "missing or forbidden", err: pgx.ErrNoRows, want: http.StatusForbidden},
		{name: "wrapped missing or forbidden", err: fmt.Errorf("resolve comment: %w", pgx.ErrNoRows), want: http.StatusForbidden},
		{name: "database failure", err: errors.New("database unavailable"), want: http.StatusInternalServerError},
		{name: "commit failure", err: errors.New("commit failed"), want: http.StatusInternalServerError},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			status, _ := commentMutationError(test.err, "forbidden", "failed")
			if status != test.want {
				t.Fatalf("status = %d, want %d", status, test.want)
			}
		})
	}
}

func TestOfflineCanvasMutationErrorsPreserveRetryableFailures(t *testing.T) {
	if got := updateNoteLookupFailureStatus(pgx.ErrNoRows); got != http.StatusNotFound {
		t.Fatalf("inaccessible update status = %d", got)
	}
	if got := updateNoteLookupFailureStatus(errors.New("lookup unavailable")); got != http.StatusInternalServerError {
		t.Fatalf("transient update lookup status = %d", got)
	}
	if got := deleteNoteErrorStatus(pgx.ErrNoRows); got != http.StatusNotFound {
		t.Fatalf("missing delete status = %d", got)
	}
	if got := deleteNoteErrorStatus(errors.New("commit failed")); got != http.StatusInternalServerError {
		t.Fatalf("transient delete status = %d", got)
	}
	if got := createEdgeErrorStatus(pgx.ErrNoRows); got != http.StatusBadRequest {
		t.Fatalf("invalid edge status = %d", got)
	}
	if got := createEdgeErrorStatus(&pgconn.PgError{Code: "23505"}); got != http.StatusBadRequest {
		t.Fatalf("duplicate edge status = %d", got)
	}
	if got := createEdgeErrorStatus(errors.New("outbox unavailable")); got != http.StatusInternalServerError {
		t.Fatalf("transient edge status = %d", got)
	}
}

func TestIdempotencyKeyPattern(t *testing.T) {
	for _, valid := range []string{"offline:12345678", "note_2026-08-21", "abc.def-123"} {
		if !idempotencyKeyPattern.MatchString(valid) {
			t.Errorf("valid key %q rejected", valid)
		}
	}
	for _, invalid := range []string{"short", "contains space", "한글키-12345678"} {
		if idempotencyKeyPattern.MatchString(invalid) {
			t.Errorf("invalid key %q accepted", invalid)
		}
	}
}

func TestIdempotencyIsLimitedToAtomicCanvasMutations(t *testing.T) {
	for _, request := range []struct{ method, path string }{
		{http.MethodPost, "/api/v1/spaces/space-id/notes"},
		{http.MethodPost, "/api/v1/spaces/space-id/edges"},
		{http.MethodPost, "/api/v1/notes/note-id/comments"},
		{http.MethodPut, "/api/v1/notes/note-id"},
		{http.MethodPut, "/api/v1/comments/comment-id/resolve"},
		{http.MethodDelete, "/api/v1/notes/note-id"},
		{http.MethodDelete, "/api/v1/comments/comment-id"},
	} {
		if !idempotencySupported(request.method, request.path) {
			t.Errorf("supported mutation rejected: %s %s", request.method, request.path)
		}
	}
	for _, request := range []struct{ method, path string }{
		{http.MethodPost, "/api/v1/ai/assist"},
		{http.MethodPost, "/api/v1/dreams/id/regenerate"},
		{http.MethodPost, "/api/v1/admin/ai-evals/id/run"},
		{http.MethodPost, "/api/v1/api-keys"},
	} {
		if idempotencySupported(request.method, request.path) {
			t.Errorf("non-atomic or long mutation accepted: %s %s", request.method, request.path)
		}
	}
}

func TestSensitiveCredentialPathsCannotBeResponseCached(t *testing.T) {
	for _, path := range []string{
		"/api/v1/api-keys",
		"/api/v1/api-keys/8dbe15dc-283d-4b64-ae36-728a5a04b8fc/rotate",
		"/api/v1/webhooks",
		"/api/v1/webhooks/8dbe15dc-283d-4b64-ae36-728a5a04b8fc/rotate-secret",
	} {
		if !sensitiveCredentialPathPattern.MatchString(path) {
			t.Errorf("sensitive credential path %q was not recognized", path)
		}
	}
	for _, path := range []string{"/api/v1/notes", "/api/v1/webhooks/id/test", "/api/v1/api-keys/id"} {
		if sensitiveCredentialPathPattern.MatchString(path) {
			t.Errorf("ordinary mutation path %q was marked sensitive", path)
		}
	}
}

func TestIdempotencyRequestIdentityBindsTargetAndBody(t *testing.T) {
	first := httptest.NewRequest("POST", "/api/v1/notes?mode=one", strings.NewReader(`{"content":"first"}`))
	same := httptest.NewRequest("POST", "/api/v1/notes?mode=one", strings.NewReader(`{"content":"first"}`))
	differentBody := httptest.NewRequest("POST", "/api/v1/notes?mode=one", strings.NewReader(`{"content":"second"}`))
	differentQuery := httptest.NewRequest("POST", "/api/v1/notes?mode=two", strings.NewReader(`{"content":"first"}`))
	identity := idempotencyRequestIdentity(first, []byte(`{"content":"first"}`))
	if identity != idempotencyRequestIdentity(same, []byte(`{"content":"first"}`)) {
		t.Fatal("identical requests must have the same identity")
	}
	if identity == idempotencyRequestIdentity(differentBody, []byte(`{"content":"second"}`)) {
		t.Fatal("different request bodies must not share an identity")
	}
	if identity == idempotencyRequestIdentity(differentQuery, []byte(`{"content":"first"}`)) {
		t.Fatal("different query strings must not share an identity")
	}
}

func TestDecodeJSONRejectsTrailingValues(t *testing.T) {
	request := httptest.NewRequest("POST", "/", strings.NewReader(`{"value":1} {"value":2}`))
	response := httptest.NewRecorder()
	var payload struct {
		Value int `json:"value"`
	}
	if err := decodeJSON(response, request, &payload); err == nil {
		t.Fatal("decodeJSON accepted a second JSON value")
	}
}

func TestTodayDreamsAreRedactedWithoutDreamScope(t *testing.T) {
	result := store.TodayReview{
		Dreams: []store.ReviewDream{{ID: uuid.New(), Content: "scoped dream"}},
		Counts: map[string]int{"dreams": 1, "review": 2},
	}
	redactTodayDreams(&result, false)
	if len(result.Dreams) != 0 || result.Dreams == nil {
		t.Fatalf("dreams were not redacted as an empty JSON array: %#v", result.Dreams)
	}
	if result.Counts["dreams"] != 0 || result.Counts["review"] != 2 {
		t.Fatalf("unexpected redacted counts: %#v", result.Counts)
	}
}

func TestTodayDreamsRemainWithDreamScope(t *testing.T) {
	result := store.TodayReview{Dreams: []store.ReviewDream{{ID: uuid.New()}}, Counts: map[string]int{"dreams": 1}}
	redactTodayDreams(&result, true)
	if len(result.Dreams) != 1 || result.Counts["dreams"] != 1 {
		t.Fatalf("authorized dreams were changed: %#v", result)
	}
}

func TestSecurityHeadersPinScriptsToAPerResponseNonce(t *testing.T) {
	server := &Server{}
	var served string
	handler := server.securityHeaders(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		served = cspNonce(r)
	}))

	first := httptest.NewRecorder()
	handler.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/", nil))
	firstNonce := served
	policy := first.Header().Get("Content-Security-Policy")
	if firstNonce == "" {
		t.Fatal("the handler must be able to read the nonce for the response it is rendering")
	}
	if !strings.Contains(policy, "'nonce-"+firstNonce+"'") || !strings.Contains(policy, "'strict-dynamic'") {
		t.Fatalf("script-src must pin the response nonce, got %q", policy)
	}
	for _, directive := range []string{"object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'"} {
		if !strings.Contains(policy, directive) {
			t.Fatalf("missing %q in %q", directive, policy)
		}
	}

	second := httptest.NewRecorder()
	handler.ServeHTTP(second, httptest.NewRequest(http.MethodGet, "/", nil))
	if served == firstNonce {
		t.Fatal("a reused nonce defeats the purpose; each response needs a fresh one")
	}
}

func TestStrictTransportSecurityOnlyOnTLS(t *testing.T) {
	server := &Server{}
	handler := server.securityHeaders(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))

	plain := httptest.NewRecorder()
	handler.ServeHTTP(plain, httptest.NewRequest(http.MethodGet, "/", nil))
	if plain.Header().Get("Strict-Transport-Security") != "" {
		t.Fatal("asserting HSTS over plain HTTP would lock an evaluation deployment out of its own browser")
	}

	forwarded := httptest.NewRequest(http.MethodGet, "/", nil)
	forwarded.Header.Set("X-Forwarded-Proto", "https")
	behindProxy := httptest.NewRecorder()
	handler.ServeHTTP(behindProxy, forwarded)
	if behindProxy.Header().Get("Strict-Transport-Security") == "" {
		t.Fatal("a TLS terminating proxy must still produce HSTS")
	}
}

func TestInjectNonceLabelsEveryScriptTag(t *testing.T) {
	document := []byte(`<html><head><meta name="csp-nonce" content="__CSP_NONCE__"></head><body><script type="module" src="/a.js"></script><SCRIPT>x</SCRIPT></body></html>`)
	out := string(injectNonce(document, "abc123"))
	if strings.Count(out, `nonce="abc123"`) != 2 {
		t.Fatalf("both script tags need the nonce attribute, got %q", out)
	}
	if !strings.Contains(out, `content="abc123"`) || strings.Contains(out, nonceMarker) {
		t.Fatalf("the marker must be replaced so the bundle can read the nonce, got %q", out)
	}
}
