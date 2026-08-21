package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

// embeddingFallbackRetryInterval turns a remote failure into a short circuit
// breaker. Canvas reads keep using the complete local fallback set during the
// window instead of paying the remote timeout again on every page load. An
// administrator changing the gateway configuration clears the window early.
const embeddingFallbackRetryInterval = 5 * time.Minute

var errEmbeddingProviderChanged = errors.New("embedding provider changed while the request was in flight")

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
	mu            sync.Mutex
	provider      intelligence.Provider
	loadedAt      time.Time
	remoteRetryAt time.Time
}

// EmbeddingProvider resolves the active embedding backend. With no configured
// embedding model — the default — this is the offline local algorithm.
func (s *Store) EmbeddingProvider(ctx context.Context) intelligence.Provider {
	s.embeddings.mu.Lock()
	defer s.embeddings.mu.Unlock()
	now := time.Now()
	if !s.embeddings.loadedAt.IsZero() && now.Sub(s.embeddings.loadedAt) < embeddingSettingsTTL {
		return availableEmbeddingProvider(s.embeddings.provider, now, s.embeddings.remoteRetryAt)
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
			Model: strings.TrimSpace(settings.EmbeddingModel), Timeout: timeout, SettingsManaged: true,
		}
	}
	if !sameEmbeddingProvider(s.embeddings.provider, provider) {
		s.embeddings.remoteRetryAt = time.Time{}
	}
	s.embeddings.provider = provider
	s.embeddings.loadedAt = now
	return availableEmbeddingProvider(provider, now, s.embeddings.remoteRetryAt)
}

func availableEmbeddingProvider(provider intelligence.Provider, now, remoteRetryAt time.Time) intelligence.Provider {
	if provider.Algorithm() != intelligence.LocalAlgorithm && now.Before(remoteRetryAt) {
		return intelligence.Provider{}
	}
	return provider
}

func sameEmbeddingProvider(left, right intelligence.Provider) bool {
	if left.Remote == nil || right.Remote == nil {
		return left.Remote == nil && right.Remote == nil
	}
	return left.Remote.BaseURL == right.Remote.BaseURL &&
		left.Remote.APIKey == right.Remote.APIKey &&
		left.Remote.Model == right.Remote.Model &&
		left.Remote.Timeout == right.Remote.Timeout &&
		left.Remote.SettingsManaged == right.Remote.SettingsManaged
}

func (s *Store) deferRemoteEmbeddings(provider intelligence.Provider) {
	if provider.Algorithm() == intelligence.LocalAlgorithm {
		return
	}
	s.embeddings.mu.Lock()
	defer s.embeddings.mu.Unlock()
	// A late response from an old configuration must not suppress a newly
	// configured gateway on this instance.
	if !sameEmbeddingProvider(s.embeddings.provider, provider) {
		return
	}
	s.embeddings.remoteRetryAt = time.Now().Add(embeddingFallbackRetryInterval)
}

// InvalidateEmbeddingProvider drops the cached settings so an administrator's
// change takes effect on the next request instead of after the TTL.
func (s *Store) InvalidateEmbeddingProvider() {
	s.embeddings.mu.Lock()
	s.embeddings.loadedAt = time.Time{}
	s.embeddings.remoteRetryAt = time.Time{}
	s.embeddings.mu.Unlock()
}

type embeddingTarget struct {
	ID      uuid.UUID
	Content string
	Version int
}

// UpsertEmbedding refreshes a single note's vector after a write.
func (s *Store) UpsertEmbedding(ctx context.Context, noteID uuid.UUID, content string, version int) error {
	provider, err := s.embeddingProviderForNote(ctx, noteID)
	if err != nil {
		return err
	}
	algorithm, err := s.writeEmbeddingsWithProvider(ctx, []embeddingTarget{{ID: noteID, Content: content, Version: version}}, provider)
	if err == nil && provider.Algorithm() != intelligence.LocalAlgorithm && algorithm == intelligence.LocalAlgorithm {
		s.deferRemoteEmbeddings(provider)
	}
	return err
}

// embeddingProviderForNote fails closed to local embeddings when either the
// note or its containing space opts out of AI processing. The lookup happens
// before content can be handed to a configured remote provider.
func (s *Store) embeddingProviderForNote(ctx context.Context, noteID uuid.UUID) (intelligence.Provider, error) {
	var excluded bool
	err := s.Pool.QueryRow(ctx, `
		SELECT n.ai_excluded OR sp.ai_excluded
		FROM notes n JOIN spaces sp ON sp.id=n.space_id
		WHERE n.id=$1 AND n.deleted_at IS NULL`, noteID).Scan(&excluded)
	if err != nil {
		return intelligence.Provider{}, fmt.Errorf("read embedding exclusion: %w", err)
	}
	if excluded {
		return intelligence.Provider{}, nil
	}
	return s.EmbeddingProvider(ctx), nil
}

func (s *Store) embeddingProviderForNotes(ctx context.Context, notes []Note) intelligence.Provider {
	spaceSet := make(map[uuid.UUID]struct{}, len(notes))
	for _, note := range notes {
		if note.AIExcluded || note.SpaceID == uuid.Nil {
			return intelligence.Provider{}
		}
		spaceSet[note.SpaceID] = struct{}{}
	}
	spaceIDs := make([]uuid.UUID, 0, len(spaceSet))
	for spaceID := range spaceSet {
		spaceIDs = append(spaceIDs, spaceID)
	}
	var spaceExcluded bool
	var found int
	if err := s.Pool.QueryRow(ctx, `SELECT COALESCE(bool_or(ai_excluded),false),count(*) FROM spaces WHERE id=ANY($1)`, spaceIDs).Scan(&spaceExcluded, &found); err != nil || spaceExcluded || found != len(spaceIDs) {
		return intelligence.Provider{}
	}
	return s.EmbeddingProvider(ctx)
}

// embeddingProviderForSearch keeps a query scoped to an AI-excluded space on
// the local provider. Authorization and exclusion are resolved together before
// any query text can be handed to a configured remote gateway. Missing,
// inaccessible, or temporarily unreadable spaces also fail closed to local.
func (s *Store) embeddingProviderForSearch(ctx context.Context, userID uuid.UUID, spaceID *uuid.UUID) intelligence.Provider {
	if spaceID == nil {
		return s.EmbeddingProvider(ctx)
	}
	var excluded bool
	err := s.Pool.QueryRow(ctx, `
		SELECT sp.ai_excluded
		FROM spaces sp
		WHERE sp.id=$1
		  AND (sp.owner_id=$2 OR EXISTS(
		    SELECT 1 FROM space_members sm WHERE sm.space_id=sp.id AND sm.user_id=$2))`, *spaceID, userID).Scan(&excluded)
	if err != nil || excluded {
		return intelligence.Provider{}
	}
	return s.EmbeddingProvider(ctx)
}

// ensureEmbeddings brings a batch of notes up to date. Before v0.8.0 this issued
// one no-op UPDATE per note on every canvas load; now it asks the database which
// vectors are actually stale and embeds only those.
func (s *Store) ensureEmbeddings(ctx context.Context, notes []Note) {
	if len(notes) == 0 {
		return
	}
	provider := s.embeddingProviderForNotes(ctx, notes)
	algorithm := provider.Algorithm()
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
	actualAlgorithm, writeErr := s.writeEmbeddingsWithProvider(ctx, stale, provider)
	if writeErr != nil {
		return
	}
	if algorithm != intelligence.LocalAlgorithm && actualAlgorithm == intelligence.LocalAlgorithm {
		s.deferRemoteEmbeddings(provider)
		// A gateway outage can leave older notes with remote vectors and newer
		// notes with local fallbacks. Rewrite the whole comparison set locally so
		// Canvas counts, related notes and clusters never mix or omit vector spaces.
		all := make([]embeddingTarget, len(notes))
		for index, note := range notes {
			all[index] = embeddingTarget{ID: note.ID, Content: note.Content, Version: note.Version}
		}
		_, _ = s.writeEmbeddings(ctx, all, intelligence.Provider{}, provider)
	}
}

func (s *Store) writeEmbeddingsWithProvider(ctx context.Context, targets []embeddingTarget, provider intelligence.Provider) (string, error) {
	return s.writeEmbeddings(ctx, targets, provider, provider)
}

// writeEmbeddings lets a caller force the embedding algorithm while retaining
// the settings-backed provider that authorized the overall operation. The
// outage-wide local normalization pass uses a local active provider with its
// original remote provider as origin, so an intervening gateway change fences
// the rewrite just like the first fallback batch.
func (s *Store) writeEmbeddings(ctx context.Context, targets []embeddingTarget, provider, origin intelligence.Provider) (string, error) {
	if len(targets) == 0 {
		return provider.Algorithm(), nil
	}
	actualAlgorithm := provider.Algorithm()
	activeProvider := provider
	for start := 0; start < len(targets); start += embeddingBatchSize {
		batch := targets[start:min(start+embeddingBatchSize, len(targets))]
		texts := make([]string, len(batch))
		for i, target := range batch {
			texts[i] = target.Content
		}
		vectors, algorithm := activeProvider.Embed(ctx, texts)
		model := activeProvider.Model()
		if algorithm == intelligence.LocalAlgorithm {
			actualAlgorithm = intelligence.LocalAlgorithm
			model = ""
			// One failed remote batch is enough evidence for this write. Finish
			// the remaining batches locally instead of repeating the full timeout.
			activeProvider = intelligence.Provider{}
		}
		if err := s.persistEmbeddingBatch(ctx, batch, vectors, algorithm, model, origin); err != nil {
			return actualAlgorithm, err
		}
	}
	return actualAlgorithm, nil
}

// persistEmbeddingBatch fences remote results against the current settings row.
// The shared lock and writes live in one transaction: either an old request
// commits before the administrator's settings update, or it observes the new
// vector-space identifier and is discarded. It can never commit afterward.
func (s *Store) persistEmbeddingBatch(ctx context.Context, batch []embeddingTarget, vectors [][]float32, algorithm, model string, origin intelligence.Provider) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if origin.Remote != nil && origin.Remote.SettingsManaged {
		var raw []byte
		if err = tx.QueryRow(ctx, `SELECT value FROM app_settings WHERE key='ai_gateway' FOR SHARE`).Scan(&raw); err != nil {
			return err
		}
		var settings embeddingSettings
		if err = json.Unmarshal(raw, &settings); err != nil {
			return err
		}
		current := intelligence.Provider{}
		if strings.TrimSpace(settings.BaseURL) != "" && strings.TrimSpace(settings.EmbeddingModel) != "" {
			current.Remote = &intelligence.RemoteConfig{BaseURL: settings.BaseURL, Model: strings.TrimSpace(settings.EmbeddingModel)}
		}
		if current.Algorithm() != origin.Algorithm() {
			s.InvalidateEmbeddingProvider()
			return errEmbeddingProviderChanged
		}
	}
	for i, target := range batch {
		// A newer content version always wins. At the same version, a current
		// provider may replace a different vector space, while an older content
		// version can never win merely because its algorithm differs.
		if _, err = tx.Exec(ctx, `
			INSERT INTO note_embeddings(note_id,algorithm,model,dimensions,vector,content_version,updated_at)
			VALUES($1,$2,$3,$4,$5,$6,now())
			ON CONFLICT(note_id) DO UPDATE SET
			  algorithm=EXCLUDED.algorithm,model=EXCLUDED.model,dimensions=EXCLUDED.dimensions,
			  vector=EXCLUDED.vector,content_version=EXCLUDED.content_version,updated_at=now()
			WHERE note_embeddings.content_version<EXCLUDED.content_version
			   OR (note_embeddings.content_version=EXCLUDED.content_version
			       AND note_embeddings.algorithm<>EXCLUDED.algorithm)`,
			target.ID, algorithm, model, len(vectors[i]), vectors[i], target.Version); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// loadEmbeddings chooses one current algorithm for the entire comparison set.
// The most complete set wins, with the configured provider breaking ties. This
// lets an outage-wide local fallback remain usable without ever mixing it with
// remote vectors.
func (s *Store) loadEmbeddings(ctx context.Context, notes []Note) map[uuid.UUID][]float32 {
	if len(notes) == 0 {
		return map[uuid.UUID][]float32{}
	}
	ids := make([]uuid.UUID, len(notes))
	versions := make(map[uuid.UUID]int, len(notes))
	for i, n := range notes {
		ids[i] = n.ID
		versions[n.ID] = n.Version
	}
	rows, err := s.Pool.Query(ctx, `SELECT note_id,algorithm,vector,content_version FROM note_embeddings WHERE note_id=ANY($1)`, ids)
	if err != nil {
		return map[uuid.UUID][]float32{}
	}
	defer rows.Close()
	byAlgorithm := map[string]map[uuid.UUID][]float32{}
	for rows.Next() {
		var id uuid.UUID
		var algorithm string
		var vector []float32
		var contentVersion int
		if rows.Scan(&id, &algorithm, &vector, &contentVersion) == nil && contentVersion >= versions[id] {
			if byAlgorithm[algorithm] == nil {
				byAlgorithm[algorithm] = map[uuid.UUID][]float32{}
			}
			byAlgorithm[algorithm][id] = vector
		}
	}
	preferred := s.EmbeddingProvider(ctx).Algorithm()
	chosen := ""
	best := -1
	for algorithm, vectors := range byAlgorithm {
		count := len(vectors)
		if count > best || (count == best && algorithm == preferred) || (count == best && chosen != preferred && algorithm < chosen) {
			chosen, best = algorithm, count
		}
	}
	if chosen == "" {
		return map[uuid.UUID][]float32{}
	}
	return byAlgorithm[chosen]
}

// EmbedQuery vectorises a search query and reports the algorithm that actually
// produced it. A remote provider can fall back locally, so callers must use the
// returned label rather than the provider's configured label when selecting
// stored vectors.
func (s *Store) EmbedQuery(ctx context.Context, query string) ([]float32, string) {
	return s.embedQueryWithProvider(ctx, query, s.EmbeddingProvider(ctx))
}

func (s *Store) embedQueryWithProvider(ctx context.Context, query string, provider intelligence.Provider) ([]float32, string) {
	vectors, algorithm := provider.Embed(ctx, []string{query})
	if provider.Algorithm() != intelligence.LocalAlgorithm && algorithm == intelligence.LocalAlgorithm {
		s.deferRemoteEmbeddings(provider)
	}
	if len(vectors) == 0 {
		return nil, algorithm
	}
	return vectors[0], algorithm
}
