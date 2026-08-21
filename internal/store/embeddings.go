package store

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/intelligence"
)

// embeddingSettingsTTL keeps the ai_gateway lookup off the hot path. Thirty
// seconds is short enough that an administrator sees a model change take effect
// while they are still on the settings screen.
const embeddingSettingsTTL = 30 * time.Second

// embeddingBatchSize bounds one gateway request. Larger batches mean fewer round
// trips; too large and a single slow note blocks a whole canvas load.
const embeddingBatchSize = 64

// Decrypter is the subset of cryptoutil.Cipher the store needs to read the
// gateway credential. It stays an interface so the store keeps no hard
// dependency on key management.
type Decrypter interface {
	Decrypt(string) (string, error)
}

type embeddingSettings struct {
	BaseURL        string `json:"base_url"`
	APIKey         string `json:"api_key"`
	TimeoutSeconds int    `json:"timeout_seconds"`
	EmbeddingModel string `json:"embedding_model"`
}

type embeddingCache struct {
	mu       sync.Mutex
	provider intelligence.Provider
	loadedAt time.Time
}

// EmbeddingProvider resolves the active embedding backend. With no configured
// embedding model — the default — this is the offline local algorithm.
func (s *Store) EmbeddingProvider(ctx context.Context) intelligence.Provider {
	s.embeddings.mu.Lock()
	defer s.embeddings.mu.Unlock()
	if !s.embeddings.loadedAt.IsZero() && time.Since(s.embeddings.loadedAt) < embeddingSettingsTTL {
		return s.embeddings.provider
	}
	provider := intelligence.Provider{}
	var settings embeddingSettings
	if s.GetSetting(ctx, "ai_gateway", &settings) == nil &&
		strings.TrimSpace(settings.EmbeddingModel) != "" && strings.TrimSpace(settings.BaseURL) != "" {
		key := settings.APIKey
		if s.Cipher != nil && strings.HasPrefix(key, "enc:") {
			if plain, err := s.Cipher.Decrypt(strings.TrimPrefix(key, "enc:")); err == nil {
				key = plain
			}
		}
		timeout := time.Duration(settings.TimeoutSeconds) * time.Second
		if settings.TimeoutSeconds <= 0 {
			timeout = 45 * time.Second
		}
		provider.Remote = &intelligence.RemoteConfig{
			BaseURL: settings.BaseURL, APIKey: key,
			Model: strings.TrimSpace(settings.EmbeddingModel), Timeout: timeout,
		}
	}
	s.embeddings.provider = provider
	s.embeddings.loadedAt = time.Now()
	return provider
}

// InvalidateEmbeddingProvider drops the cached settings so an administrator's
// change takes effect on the next request instead of after the TTL.
func (s *Store) InvalidateEmbeddingProvider() {
	s.embeddings.mu.Lock()
	s.embeddings.loadedAt = time.Time{}
	s.embeddings.mu.Unlock()
}

type embeddingTarget struct {
	ID      uuid.UUID
	Content string
	Version int
}

// UpsertEmbedding refreshes a single note's vector after a write.
func (s *Store) UpsertEmbedding(ctx context.Context, noteID uuid.UUID, content string, version int) error {
	return s.writeEmbeddings(ctx, []embeddingTarget{{ID: noteID, Content: content, Version: version}})
}

// ensureEmbeddings brings a batch of notes up to date. Before v0.8.0 this issued
// one no-op UPDATE per note on every canvas load; now it asks the database which
// vectors are actually stale and embeds only those.
func (s *Store) ensureEmbeddings(ctx context.Context, notes []Note) {
	if len(notes) == 0 {
		return
	}
	algorithm := s.EmbeddingProvider(ctx).Algorithm()
	ids := make([]uuid.UUID, len(notes))
	for i, n := range notes {
		ids[i] = n.ID
	}
	current := map[uuid.UUID]int{}
	rows, err := s.Pool.Query(ctx, `SELECT note_id,content_version FROM note_embeddings WHERE note_id=ANY($1) AND algorithm=$2`, ids, algorithm)
	if err == nil {
		for rows.Next() {
			var id uuid.UUID
			var version int
			if rows.Scan(&id, &version) == nil {
				current[id] = version
			}
		}
		rows.Close()
	}
	stale := make([]embeddingTarget, 0, len(notes))
	for _, n := range notes {
		if version, ok := current[n.ID]; ok && version >= n.Version {
			continue
		}
		stale = append(stale, embeddingTarget{ID: n.ID, Content: n.Content, Version: n.Version})
	}
	_ = s.writeEmbeddings(ctx, stale)
}

func (s *Store) writeEmbeddings(ctx context.Context, targets []embeddingTarget) error {
	if len(targets) == 0 {
		return nil
	}
	provider := s.EmbeddingProvider(ctx)
	model := provider.Model()
	var firstErr error
	for start := 0; start < len(targets); start += embeddingBatchSize {
		batch := targets[start:min(start+embeddingBatchSize, len(targets))]
		texts := make([]string, len(batch))
		for i, target := range batch {
			texts[i] = target.Content
		}
		vectors, algorithm := provider.Embed(ctx, texts)
		if algorithm == intelligence.LocalAlgorithm {
			model = ""
		}
		for i, target := range batch {
			// A stored row is replaced when the note content moved on or when the
			// active algorithm changed, so switching models re-embeds instead of
			// leaving two incompatible vector spaces in one index.
			_, err := s.Pool.Exec(ctx, `
				INSERT INTO note_embeddings(note_id,algorithm,model,dimensions,vector,content_version,updated_at)
				VALUES($1,$2,$3,$4,$5,$6,now())
				ON CONFLICT(note_id) DO UPDATE SET
				  algorithm=EXCLUDED.algorithm,model=EXCLUDED.model,dimensions=EXCLUDED.dimensions,
				  vector=EXCLUDED.vector,content_version=EXCLUDED.content_version,updated_at=now()
				WHERE note_embeddings.content_version<EXCLUDED.content_version
				   OR note_embeddings.algorithm<>EXCLUDED.algorithm`,
				target.ID, algorithm, model, len(vectors[i]), vectors[i], target.Version)
			if err != nil && firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

// loadEmbeddings returns only vectors produced by the active algorithm. Mixing
// vector spaces would silently return meaningless similarity scores.
func (s *Store) loadEmbeddings(ctx context.Context, notes []Note) map[uuid.UUID][]float32 {
	out := map[uuid.UUID][]float32{}
	if len(notes) == 0 {
		return out
	}
	ids := make([]uuid.UUID, len(notes))
	for i, n := range notes {
		ids[i] = n.ID
	}
	rows, err := s.Pool.Query(ctx, `SELECT note_id,vector FROM note_embeddings WHERE note_id=ANY($1) AND algorithm=$2`, ids, s.EmbeddingProvider(ctx).Algorithm())
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var vector []float32
		if rows.Scan(&id, &vector) == nil {
			out[id] = vector
		}
	}
	return out
}

// EmbedQuery vectorises a search query with the active provider.
func (s *Store) EmbedQuery(ctx context.Context, query string) []float32 {
	vectors, _ := s.EmbeddingProvider(ctx).Embed(ctx, []string{query})
	if len(vectors) == 0 {
		return nil
	}
	return vectors[0]
}
