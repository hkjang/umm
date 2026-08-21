package auth

import (
	"errors"
	"testing"
)

func TestNewAPIKeyMaterialFailsClosed(t *testing.T) {
	entropyErr := errors.New("entropy unavailable")
	tests := []struct {
		name        string
		generate    func(int) (string, error)
		wantEntropy bool
	}{
		{
			name:        "secret generation",
			wantEntropy: true,
			generate: func(int) (string, error) {
				return "", entropyErr
			},
		},
		{
			name:        "prefix generation",
			wantEntropy: true,
			generate: func(bytes int) (string, error) {
				if bytes == 32 {
					return "full-secret", nil
				}
				return "", entropyErr
			},
		},
		{
			name: "short prefix",
			generate: func(bytes int) (string, error) {
				if bytes == 32 {
					return "full-secret", nil
				}
				return "short", nil
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			prefix, raw, err := newAPIKeyMaterial(test.generate)
			if err == nil || prefix != "" || raw != "" {
				t.Fatalf("failed entropy produced key material: prefix=%q raw=%q err=%v", prefix, raw, err)
			}
			if test.wantEntropy && !errors.Is(err, entropyErr) {
				t.Fatalf("entropy error was not propagated: %v", err)
			}
		})
	}
}

func TestNewAPIKeyMaterialFormatsGeneratedEntropy(t *testing.T) {
	prefix, raw, err := newAPIKeyMaterial(func(bytes int) (string, error) {
		if bytes == 32 {
			return "full-secret", nil
		}
		return "AbCdEfGh", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if prefix != "abcdefgh" || raw != "umm_key_abcdefgh_full-secret" {
		t.Fatalf("unexpected key material: prefix=%q raw=%q", prefix, raw)
	}
}
