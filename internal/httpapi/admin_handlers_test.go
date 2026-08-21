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
