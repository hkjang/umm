package config

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
)

// Config deliberately contains the only four deployment inputs accepted by umm.
// All mutable service configuration belongs in PostgreSQL and is managed in the UI.
type Config struct {
	PostgresDSN            string
	BootstrapAdmin         string
	BootstrapAdminPassword string
	EncryptionKey          []byte
}

func Load() (Config, error) {
	cfg := Config{
		PostgresDSN:            strings.TrimSpace(os.Getenv("POSTGRES_DSN")),
		BootstrapAdmin:         strings.TrimSpace(os.Getenv("BOOTSTRAP_ADMIN")),
		BootstrapAdminPassword: os.Getenv("BOOTSTRAP_ADMIN_PASSWORD"),
	}
	if cfg.PostgresDSN == "" || cfg.BootstrapAdmin == "" || cfg.BootstrapAdminPassword == "" {
		return Config{}, errors.New("POSTGRES_DSN, BOOTSTRAP_ADMIN, BOOTSTRAP_ADMIN_PASSWORD and ENCRYPTION_KEY are required")
	}
	key, err := parseKey(os.Getenv("ENCRYPTION_KEY"))
	if err != nil {
		return Config{}, err
	}
	cfg.EncryptionKey = key
	return cfg, nil
}

func parseKey(raw string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, errors.New("ENCRYPTION_KEY is required")
	}
	for _, decode := range []func(string) ([]byte, error){base64.StdEncoding.DecodeString, hex.DecodeString} {
		if key, err := decode(raw); err == nil && len(key) == 32 {
			return key, nil
		}
	}
	if len([]byte(raw)) == 32 {
		return []byte(raw), nil
	}
	return nil, fmt.Errorf("ENCRYPTION_KEY must be exactly 32 bytes, 64 hex characters, or base64-encoded 32 bytes (sha256 hint: %x)", sha256.Sum256([]byte(raw)))
}
