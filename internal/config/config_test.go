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
