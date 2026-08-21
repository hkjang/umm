package httpapi

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/auth"
	"github.com/hkjang/umm/internal/cryptoutil"
	"github.com/hkjang/umm/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func legacyV1Ciphertext(t *testing.T, key []byte, plain string) string {
	t.Helper()
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	sealed := aead.Seal(nonce, nonce, []byte(plain), []byte("umm:v1"))
	return base64.RawURLEncoding.EncodeToString(sealed)
}

func isolatedHTTPStore(t *testing.T, dsn string) *store.Store {
	t.Helper()
	ctx := context.Background()
	adminConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	adminPool, err := pgxpool.NewWithConfig(ctx, adminConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(adminPool.Close)

	schema := "httpapi_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err = adminPool.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = adminPool.Exec(context.Background(), "DROP SCHEMA "+identifier+" CASCADE")
	})

	testConfig := adminConfig.Copy()
	testConfig.ConnConfig.RuntimeParams["search_path"] = identifier + ", public"
	testPool, err := pgxpool.NewWithConfig(ctx, testConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(testPool.Close)
	db := &store.Store{Pool: testPool}
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestRotateEncryptionKeyRewrapsUnprefixedLegacyPromptIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db := isolatedHTTPStore(t, dsn)

	oldKey := []byte("0123456789abcdef0123456789abcdef")
	newKey := []byte("abcdef0123456789abcdef0123456789")
	keyring, err := cryptoutil.NewWithPrevious(newKey, oldKey)
	if err != nil {
		t.Fatal(err)
	}
	db.Cipher = keyring

	adminID := uuid.New()
	username := "key_rotation_" + strings.ReplaceAll(adminID.String(), "-", "")
	if _, err = db.Pool.Exec(ctx, `INSERT INTO users(id,username,display_name,role) VALUES($1,$2::citext,$2::text,'admin')`, adminID, username); err != nil {
		t.Fatal(err)
	}
	legacyPrompt := legacyV1Ciphertext(t, oldKey, "historical prompt")
	currentUnprefixed, err := keyring.Encrypt("unwrapped current prompt")
	if err != nil {
		t.Fatal(err)
	}
	var legacyCallID, currentCallID int64
	if err = db.Pool.QueryRow(ctx, `INSERT INTO ai_calls(user_id,model,status,prompt_ciphertext) VALUES($1,'legacy-model','success',$2) RETURNING id`, adminID, legacyPrompt).Scan(&legacyCallID); err != nil {
		t.Fatal(err)
	}
	if err = db.Pool.QueryRow(ctx, `INSERT INTO ai_calls(user_id,model,status,prompt_ciphertext) VALUES($1,'current-model','success',$2) RETURNING id`, adminID, currentUnprefixed).Scan(&currentCallID); err != nil {
		t.Fatal(err)
	}

	authService := &auth.Service{Store: db}
	session, err := authService.CreateSession(ctx, adminID, auth.SessionOrigin{UserAgent: "integration-test", ClientIP: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: db, Cipher: keyring}
	router := chi.NewRouter()
	router.Get("/status", server.encryptionKeyStatus)
	router.Post("/rotate", server.rotateEncryptionKey)
	handler := authService.Middleware(auth.Require(auth.RequireAdmin(router)))
	send := func(method, path string) (*httptest.ResponseRecorder, map[string]any) {
		t.Helper()
		request := httptest.NewRequest(method, path, nil)
		request.AddCookie(&http.Cookie{Name: auth.CookieName, Value: session})
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		var payload map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode %s response: %v body=%s", path, err, response.Body.String())
		}
		return response, payload
	}

	before, beforePayload := send(http.MethodGet, "/status")
	if before.Code != http.StatusOK || beforePayload["pendingRotation"] != float64(2) || beforePayload["unreadable"] != float64(0) {
		t.Fatalf("status before rotation=%d payload=%#v", before.Code, beforePayload)
	}
	rotated, rotatedPayload := send(http.MethodPost, "/rotate")
	if rotated.Code != http.StatusOK || rotatedPayload["rotated"] != float64(2) {
		t.Fatalf("rotation response=%d payload=%#v", rotated.Code, rotatedPayload)
	}

	primaryOnly, err := cryptoutil.New(newKey)
	if err != nil {
		t.Fatal(err)
	}
	for callID, expected := range map[int64]string{
		legacyCallID:  "historical prompt",
		currentCallID: "unwrapped current prompt",
	} {
		var stored string
		if err = db.Pool.QueryRow(ctx, `SELECT prompt_ciphertext FROM ai_calls WHERE id=$1`, callID).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		plain, decryptErr := primaryOnly.Decrypt(strings.TrimPrefix(stored, "enc:"))
		if decryptErr != nil || plain != expected || !strings.HasPrefix(stored, "enc:v2."+primaryOnly.KeyID()+".") {
			t.Fatalf("rotated prompt is not primary-key ciphertext: prefix=%q plain=%q err=%v", fmt.Sprintf("%.24s", stored), plain, decryptErr)
		}
	}
	after, afterPayload := send(http.MethodGet, "/status")
	if after.Code != http.StatusOK || afterPayload["pendingRotation"] != float64(0) || afterPayload["unreadable"] != float64(0) {
		t.Fatalf("status after rotation=%d payload=%#v", after.Code, afterPayload)
	}
}
