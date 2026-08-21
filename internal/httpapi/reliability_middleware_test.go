package httpapi

import (
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/store"
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
	got := mentionedUsernames("@Alice 확인 부탁해요. (@bob) @ALICE email@example.com")
	want := []string{"alice", "bob"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mentions = %#v, want %#v", got, want)
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
