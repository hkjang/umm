package webhook

import (
	"context"
	"net"
	"net/http"
	"testing"
)

func TestNewUsesGuardedDirectTransport(t *testing.T) {
	service := New(nil, nil)
	transport, ok := service.client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("webhook transport has type %T, want *http.Transport", service.client.Transport)
	}
	if transport.Proxy != nil {
		t.Fatal("webhook transport must not use a proxy")
	}
	if transport.DialContext == nil {
		t.Fatal("webhook transport must use the guarded dialer")
	}
}

func TestPublicIPRejectsPrivateAndReservedRanges(t *testing.T) {
	tests := map[string]bool{
		"8.8.8.8":              true,
		"2606:4700:4700::1111": true,
		"127.0.0.1":            false,
		"10.1.2.3":             false,
		"100.64.0.1":           false,
		"169.254.1.1":          false,
		"192.0.2.8":            false,
		"198.18.0.1":           false,
		"198.51.100.8":         false,
		"203.0.113.8":          false,
		"240.0.0.1":            false,
		"::1":                  false,
		"fc00::1":              false,
		"fe80::1":              false,
		"2001:db8::1":          false,
	}
	for raw, want := range tests {
		if got := publicIP(net.ParseIP(raw)); got != want {
			t.Errorf("publicIP(%q) = %v, want %v", raw, got, want)
		}
	}
}

func TestValidateEndpointRejectsUnsafeURLs(t *testing.T) {
	for _, raw := range []string{
		"http://example.com/hook",
		"https://user:pass@example.com/hook",
		"https://example.com:8443/hook",
		"https://example.com/hook#secret",
		"https://127.0.0.1/hook",
		"https://localhost/hook",
	} {
		if err := ValidateEndpoint(context.Background(), raw); err == nil {
			t.Errorf("ValidateEndpoint(%q) accepted an unsafe URL", raw)
		}
	}
}

func TestValidateEvents(t *testing.T) {
	if !ValidateEvents([]string{"note.created", "comment.created"}) || !ValidateEvents([]string{"*"}) {
		t.Fatal("supported webhook events were rejected")
	}
	if ValidateEvents(nil) || ValidateEvents([]string{"unknown.event"}) {
		t.Fatal("unsupported webhook events were accepted")
	}
}
