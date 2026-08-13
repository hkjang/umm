package httpapi

import "testing"

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
