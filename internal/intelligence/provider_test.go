package intelligence

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestProviderDefaultsToLocalAlgorithm(t *testing.T) {
	var provider Provider
	if got := provider.Algorithm(); got != LocalAlgorithm {
		t.Fatalf("an unconfigured provider must stay offline, got %q", got)
	}
	vectors, algorithm := provider.Embed(context.Background(), []string{"생각"})
	if algorithm != LocalAlgorithm || len(vectors) != 1 || len(vectors[0]) != Dimensions {
		t.Fatalf("expected one local vector of %d dimensions, got %d vectors labelled %q", Dimensions, len(vectors), algorithm)
	}
}

func TestProviderWithoutModelStaysLocal(t *testing.T) {
	provider := Provider{Remote: &RemoteConfig{BaseURL: "https://gateway.internal", Model: "  "}}
	if got := provider.Algorithm(); got != LocalAlgorithm {
		t.Fatalf("a base URL without a model must not switch the algorithm, got %q", got)
	}
}

func TestProviderUsesTheGatewayAndNormalises(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/embeddings" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer secret" {
			t.Errorf("credential was not forwarded, got %q", got)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"index": 0, "embedding": []float32{3, 4}}}})
	}))
	defer server.Close()

	provider := Provider{Remote: &RemoteConfig{BaseURL: server.URL, APIKey: "secret", Model: "text-embed", Timeout: 5 * time.Second}}
	if got := provider.Algorithm(); got != "gateway:text-embed" {
		t.Fatalf("expected the gateway algorithm label, got %q", got)
	}
	vectors, algorithm := provider.Embed(context.Background(), []string{"생각"})
	if algorithm != "gateway:text-embed" {
		t.Fatalf("expected the gateway label, got %q", algorithm)
	}
	if math.Abs(float64(vectors[0][0])-0.6) > 1e-6 || math.Abs(float64(vectors[0][1])-0.8) > 1e-6 {
		t.Fatalf("gateway vectors must be normalised for Cosine, got %v", vectors[0])
	}
}

// A degraded gateway must never be mistaken for a successful one: the returned
// algorithm has to say the vectors are local, or they would be stored under the
// gateway label and compared against incompatible vectors later.
func TestProviderFallsBackAndReportsLocal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "upstream is down", http.StatusBadGateway)
	}))
	defer server.Close()

	provider := Provider{Remote: &RemoteConfig{BaseURL: server.URL, Model: "text-embed", Timeout: time.Second}}
	vectors, algorithm := provider.Embed(context.Background(), []string{"생각"})
	if algorithm != LocalAlgorithm {
		t.Fatalf("a failed gateway call must report local vectors, got %q", algorithm)
	}
	if len(vectors) != 1 || len(vectors[0]) != Dimensions {
		t.Fatalf("expected a usable local fallback vector, got %d vectors", len(vectors))
	}
	if _, err := provider.EmbedStrict(context.Background(), []string{"생각"}); err == nil {
		t.Fatal("EmbedStrict must surface the gateway error for the settings screen")
	}
}

func TestProviderRejectsAMismatchedBatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"index": 0, "embedding": []float32{1}}}})
	}))
	defer server.Close()

	provider := Provider{Remote: &RemoteConfig{BaseURL: server.URL, Model: "m", Timeout: time.Second}}
	if _, err := provider.EmbedStrict(context.Background(), []string{"a", "b"}); err == nil {
		t.Fatal("a response with fewer vectors than inputs must be an error, not a silent misalignment")
	}
}

func TestEmbeddingsEndpoint(t *testing.T) {
	cases := map[string]string{
		"https://gw.internal":               "https://gw.internal/v1/embeddings",
		"https://gw.internal/":              "https://gw.internal/v1/embeddings",
		"https://gw.internal/v1":            "https://gw.internal/v1/embeddings",
		"https://gw.internal/v1/embeddings": "https://gw.internal/v1/embeddings",
		"https://gw.internal/openai/v1":     "https://gw.internal/openai/v1/embeddings",
	}
	for input, want := range cases {
		got, err := EmbeddingsEndpoint(input)
		if err != nil || got != want {
			t.Fatalf("%s: want %s, got %s (err=%v)", input, want, got, err)
		}
	}
	for _, invalid := range []string{"", "ftp://gw", "not a url", "/relative"} {
		if _, err := EmbeddingsEndpoint(invalid); err == nil {
			t.Fatalf("expected %q to be rejected", invalid)
		}
	}
}
