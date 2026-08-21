package httpapi

import (
	"testing"

	"github.com/hkjang/umm/internal/dream"
)

func TestValidateGeneralSettings(t *testing.T) {
	s := &Server{}
	valid := map[string]any{"service_name": "umm", "public_url": "https://umm.internal", "timezone": "Asia/Seoul"}
	if err := s.validateSetting("general", valid); err != nil {
		t.Fatalf("valid settings rejected: %v", err)
	}
	invalid := map[string]any{"service_name": "umm", "public_url": "javascript:alert(1)", "timezone": "Asia/Seoul"}
	if err := s.validateSetting("general", invalid); err == nil {
		t.Fatal("invalid public URL accepted")
	}
}

func TestValidateDreamTokenLimit(t *testing.T) {
	s := &Server{}
	valid := map[string]any{
		"quality_threshold": 0.7,
		"schedule":          "02:00",
		"frequency":         "daily",
		"token_limit":       float64(262144),
	}
	if err := s.validateSetting("dream", valid); err != nil {
		t.Fatalf("256K token limit rejected: %v", err)
	}
	for _, invalid := range []float64{63, 262145, 4096.5} {
		valid["token_limit"] = invalid
		if err := s.validateSetting("dream", valid); err == nil {
			t.Fatalf("invalid token limit accepted: %v", invalid)
		}
	}
}

func TestValidateAIGatewayTimeout(t *testing.T) {
	s := &Server{}
	valid := map[string]any{"base_url": "https://ai.internal", "log_retention_days": float64(90), "timeout_seconds": float64(dream.MaxGatewayTimeoutSeconds), "max_retries": float64(dream.MaxGatewayRetries)}
	if err := s.validateSetting("ai_gateway", valid); err != nil {
		t.Fatalf("30 minute timeout rejected: %v", err)
	}
	valid["timeout_seconds"] = float64(dream.MaxGatewayTimeoutSeconds + 1)
	if err := s.validateSetting("ai_gateway", valid); err == nil {
		t.Fatal("timeout over 30 minutes accepted")
	}
	valid["timeout_seconds"] = float64(dream.MaxGatewayTimeoutSeconds)
	valid["max_retries"] = float64(dream.MaxGatewayRetries + 1)
	if err := s.validateSetting("ai_gateway", valid); err == nil {
		t.Fatal("excessive gateway retries accepted")
	}
}

func TestValidateSecuritySettingsDistinguishesOmittedAndExplicitValues(t *testing.T) {
	s := &Server{}
	legacy := map[string]any{"api_key_scopes": []any{"notes:read"}}
	if err := s.validateSetting("security", legacy); err != nil {
		t.Fatalf("legacy payload with omitted abuse guards was rejected: %v", err)
	}

	withUnlimitedAI := map[string]any{
		"api_key_scopes":        []any{"notes:read"},
		"login_max_failures":    float64(8),
		"ai_daily_limit":        float64(0),
		"api_rate_per_minute":   float64(600),
		"ai_rate_per_minute":    float64(6),
		"login_lockout_minutes": float64(15),
	}
	if err := s.validateSetting("security", withUnlimitedAI); err != nil {
		t.Fatalf("explicit zero daily limit was rejected: %v", err)
	}

	withNull := map[string]any{"api_key_scopes": []any{"notes:read"}, "login_max_failures": nil}
	if err := s.validateSetting("security", withNull); err == nil {
		t.Fatal("an explicit null abuse guard was accepted as an omission")
	}
}
