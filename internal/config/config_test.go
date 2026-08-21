package config

import (
	"encoding/base64"
	"testing"
)

func TestParseKeyFormats(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	for _, input := range []string{string(key), base64.StdEncoding.EncodeToString(key)} {
		got, err := parseKey(input)
		if err != nil {
			t.Fatalf("parse key: %v", err)
		}
		if string(got) != string(key) {
			t.Fatal("parsed key mismatch")
		}
	}
}
func TestParseKeyRejectsWeakLength(t *testing.T) {
	if _, err := parseKey("too-short"); err == nil {
		t.Fatal("expected invalid key error")
	}
}

func TestLoadUsesOptionalHTTPAddress(t *testing.T) {
	t.Setenv("POSTGRES_DSN", "postgres://example/umm")
	t.Setenv("BOOTSTRAP_ADMIN", "admin")
	t.Setenv("BOOTSTRAP_ADMIN_PASSWORD", "test-password")
	t.Setenv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef")
	t.Setenv("UMM_HTTP_ADDR", "127.0.0.1:18081")
	config, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if config.HTTPAddr != "127.0.0.1:18081" {
		t.Fatalf("HTTPAddr = %q", config.HTTPAddr)
	}
}

func TestLoadRejectsInvalidHTTPAddress(t *testing.T) {
	t.Setenv("POSTGRES_DSN", "postgres://example/umm")
	t.Setenv("BOOTSTRAP_ADMIN", "admin")
	t.Setenv("BOOTSTRAP_ADMIN_PASSWORD", "test-password")
	t.Setenv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef")
	t.Setenv("UMM_HTTP_ADDR", "127.0.0.1")
	if _, err := Load(); err == nil {
		t.Fatal("invalid UMM_HTTP_ADDR was accepted")
	}
}
