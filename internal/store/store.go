package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/intelligence"
	"github.com/hkjang/umm/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

// Store owns the database pool. Cipher is optional and only needed for the
// settings that hold encrypted credentials.
// The similarity cutoffs umm used before thresholds became relative to the
// active embedding backend. They remain the fallback for a workspace too small
// to produce a meaningful distribution, so behaviour there is unchanged.
const (
	legacyRelatedCutoff = .22
	legacyClusterCutoff = .34
)

type Store struct {
	Pool   *pgxpool.Pool
	Cipher Decrypter

	embeddings        embeddingCache
	embeddingQuality  embeddingQualityCache
	intelligence      intelligenceCache
	leaseConfig       *pgx.ConnConfig
	aiLeaseSlots      chan struct{}
	webhookLeaseSlots chan struct{}
}

const (
	// MaxAILeaseConnections bounds long Gateway authorization transactions.
	MaxAILeaseConnections = 2
	// MaxWebhookLeaseConnections matches the bounded delivery worker count.
	MaxWebhookLeaseConnections = 3
)

type User struct {
	ID          uuid.UUID  `json:"id"`
	Username    string     `json:"username"`
	DisplayName string     `json:"displayName"`
	Email       string     `json:"email"`
	Role        string     `json:"role"`
	TeamID      *uuid.UUID `json:"teamId,omitempty"`
	Active      bool       `json:"active"`
}

type Space struct {
	ID         uuid.UUID `json:"id"`
	OwnerID    uuid.UUID `json:"ownerId"`
	Name       string    `json:"name"`
	Color      string    `json:"color"`
	AIExcluded bool      `json:"aiExcluded"`
}

type Note struct {
	ID           uuid.UUID `json:"id"`
	SpaceID      uuid.UUID `json:"spaceId"`
	AuthorID     uuid.UUID `json:"authorId"`
	Content      string    `json:"content"`
	Title        string    `json:"title"`
	Color        string    `json:"color"`
	Kind         string    `json:"kind"`
	Source       string    `json:"source"`
	AIExcluded   bool      `json:"aiExcluded"`
	X            float64   `json:"x"`
	Y            float64   `json:"y"`
	Width        float64   `json:"width"`
	Height       float64   `json:"height"`
	Rotation     float64   `json:"rotation"`
	Version      int       `json:"version"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
	RelatedCount int       `json:"relatedCount"`
}

type Edge struct {
	ID       uuid.UUID `json:"id"`
	SpaceID  uuid.UUID `json:"spaceId"`
	SourceID uuid.UUID `json:"source"`
	TargetID uuid.UUID `json:"target"`
	Relation Relation  `json:"relation"`
	// Origin says who made this connection. It is set by whichever code performs
	// the write and is never taken from a request body, so a client cannot claim
	// that umm inferred a line the client drew.
	Origin Origin `json:"origin"`
	// Confidence is set only for inferred edges. A person who drew a line is not
	// expressing a probability, so it stays null for everything else.
	Confidence *float64 `json:"confidence,omitempty"`
}

type RelatedNote struct {
	Note   Note    `json:"note"`
	Score  float64 `json:"score"`
	Reason string  `json:"reason"`
}

type NoteSearchResult struct {
	ID        uuid.UUID `json:"id"`
	SpaceID   uuid.UUID `json:"spaceId"`
	SpaceName string    `json:"spaceName"`
	Title     string    `json:"title"`
	Content   string    `json:"content"`
	Kind      string    `json:"kind"`
	UpdatedAt time.Time `json:"updatedAt"`
	Score     float64   `json:"score"`
	Reason    string    `json:"reason"`
}
type ThoughtCluster struct {
	ID       string      `json:"id"`
	Label    string      `json:"label"`
	NoteIDs  []uuid.UUID `json:"noteIds"`
	Cohesion float64     `json:"cohesion"`
}
type NoteRevision struct {
	Version   int       `json:"version"`
	Content   string    `json:"content"`
	Title     string    `json:"title"`
	Color     string    `json:"color"`
	Kind      string    `json:"kind"`
	X         float64   `json:"x"`
	Y         float64   `json:"y"`
	Width     float64   `json:"width"`
	Height    float64   `json:"height"`
	Rotation  float64   `json:"rotation"`
	CreatedAt time.Time `json:"createdAt"`
}

func Open(ctx context.Context, dsn string) (*Store, error) {
	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse POSTGRES_DSN: %w", err)
	}
	applyPoolDefaults(poolConfig)
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect postgres: %w", err)
	}
	return &Store{
		Pool:              pool,
		leaseConfig:       pool.Config().ConnConfig.Copy(),
		aiLeaseSlots:      make(chan struct{}, MaxAILeaseConnections),
		webhookLeaseSlots: make(chan struct{}, MaxWebhookLeaseConnections),
	}, nil
}

// BeginAILease starts a long-lived Gateway authorization transaction outside
// the request pool and within the per-instance AI connection bound.
func (s *Store) BeginAILease(ctx context.Context) (pgx.Tx, func(), error) {
	return s.beginExternalLease(ctx, s.aiLeaseSlots, "AI")
}

// BeginWebhookLease starts a long-lived delivery authorization transaction
// outside the request pool and within the per-instance webhook worker bound.
func (s *Store) BeginWebhookLease(ctx context.Context) (pgx.Tx, func(), error) {
	return s.beginExternalLease(ctx, s.webhookLeaseSlots, "webhook")
}

func (s *Store) beginExternalLease(ctx context.Context, slots chan struct{}, kind string) (pgx.Tx, func(), error) {
	// Tests and specialized callers may construct Store directly. Keep that
	// legacy shape functional, while Store.Open always provisions the isolated
	// production path below.
	if s.leaseConfig == nil || slots == nil {
		tx, err := s.Pool.Begin(ctx)
		return tx, func() {}, err
	}

	select {
	case slots <- struct{}{}:
	case <-ctx.Done():
		return nil, nil, ctx.Err()
	}
	releaseSlot := func() { <-slots }
	conn, err := pgx.ConnectConfig(ctx, s.leaseConfig.Copy())
	if err != nil {
		releaseSlot()
		return nil, nil, fmt.Errorf("connect %s lease database capacity: %w", kind, err)
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = conn.Close(closeCtx)
		cancel()
		releaseSlot()
		return nil, nil, fmt.Errorf("begin %s lease transaction: %w", kind, err)
	}

	var once sync.Once
	release := func() {
		once.Do(func() {
			closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = conn.Close(closeCtx)
			cancel()
			releaseSlot()
		})
	}
	return tx, release, nil
}

// applyPoolDefaults keeps headroom for the connections umm holds open while
// bounding each instance independently of the host's CPU count. This keeps a
// high-core host or a small replica set from exhausting PostgreSQL's global
// connection limit. An explicit pool_max_conns in the DSN always wins.
func applyPoolDefaults(config *pgxpool.Config) {
	const (
		defaultMaxConns        = 16
		reservedLongLivedConns = 2
	)
	if !strings.Contains(config.ConnString(), "pool_max_conns") {
		config.MaxConns = defaultMaxConns
	}
	minimum := int32(reservedLongLivedConns)
	if minimum > config.MaxConns {
		minimum = config.MaxConns
	}
	if config.MinConns < minimum {
		config.MinConns = minimum
	}
	if config.MinConns > config.MaxConns {
		config.MinConns = config.MaxConns
	}
	if config.MaxConnLifetime == 0 {
		config.MaxConnLifetime = time.Hour
	}
	if config.MaxConnIdleTime == 0 {
		config.MaxConnIdleTime = 30 * time.Minute
	}
	if config.HealthCheckPeriod == 0 {
		config.HealthCheckPeriod = time.Minute
	}
}

func (s *Store) Migrate(ctx context.Context) error {
	conn, err := s.Pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire migration connection: %w", err)
	}
	defer conn.Release()
	if _, err = conn.Exec(ctx, `SELECT pg_advisory_lock(8112026)`); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	defer conn.Exec(context.Background(), `SELECT pg_advisory_unlock(8112026)`)
	if _, err = conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); err != nil {
		return fmt.Errorf("initialize migration ledger: %w", err)
	}
	entries, err := migrations.FS.ReadDir(".")
	if err != nil {
		return fmt.Errorf("read embedded migrations: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		version := strings.TrimSuffix(entry.Name(), ".sql")
		var applied bool
		if err := conn.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)`, version).Scan(&applied); err != nil {
			return fmt.Errorf("check migration %s: %w", entry.Name(), err)
		}
		if applied {
			continue
		}
		raw, readErr := migrations.FS.ReadFile(entry.Name())
		if readErr != nil {
			return readErr
		}
		tx, beginErr := conn.Begin(ctx)
		if beginErr != nil {
			return beginErr
		}
		if _, execErr := tx.Exec(ctx, string(raw)); execErr != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("apply migration %s: %w", entry.Name(), execErr)
		}
		if _, insertErr := tx.Exec(ctx, `INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING`, version); insertErr != nil {
			_ = tx.Rollback(ctx)
			return insertErr
		}
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return commitErr
		}
	}
	return nil
}

func (s *Store) BootstrapAdmin(ctx context.Context, username, password string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	var id uuid.UUID
	err = s.Pool.QueryRow(ctx, `
		INSERT INTO users(username,display_name,password_hash,role)
		VALUES($1::citext,$1::text,$2,'admin')
		ON CONFLICT(username) DO UPDATE SET role='admin', active=true
		RETURNING id`, username, string(hash)).Scan(&id)
	if err != nil {
		return err
	}
	_, err = s.Pool.Exec(ctx, `INSERT INTO user_preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING`, id)
	return err
}

func scanUser(row pgx.Row) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Email, &u.Role, &u.TeamID, &u.Active)
	return u, err
}

func (s *Store) UserByUsername(ctx context.Context, username string) (User, string, error) {
	return userByUsername(ctx, s.Pool, username)
}

// UserByUsernameTx reads a password identity on the caller's transaction. The
// login handler uses this after taking its cross-instance throttle locks so a
// one-connection pool never has to acquire a second connection while the lock
// is held.
func (s *Store) UserByUsernameTx(ctx context.Context, tx pgx.Tx, username string) (User, string, error) {
	return userByUsername(ctx, tx, username)
}

type rowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func userByUsername(ctx context.Context, query rowQuerier, username string) (User, string, error) {
	var u User
	var hash *string
	err := query.QueryRow(ctx, `SELECT id,username,display_name,COALESCE(email,''),role,team_id,active,password_hash FROM users WHERE username=$1`, username).
		Scan(&u.ID, &u.Username, &u.DisplayName, &u.Email, &u.Role, &u.TeamID, &u.Active, &hash)
	if err != nil {
		return User{}, "", err
	}
	if hash == nil {
		return u, "", nil
	}
	return u, *hash, nil
}

func (s *Store) UserByID(ctx context.Context, id uuid.UUID) (User, error) {
	return scanUser(s.Pool.QueryRow(ctx, `SELECT id,username,display_name,COALESCE(email,''),role,team_id,active FROM users WHERE id=$1`, id))
}

func (s *Store) UpsertOIDCUser(ctx context.Context, subject, username, display, email, role string) (User, error) {
	if username == "" {
		username = "oidc-" + subject
	}
	if display == "" {
		display = username
	}
	if role != "admin" && role != "team_lead" {
		role = "user"
	}
	var u User
	err := s.Pool.QueryRow(ctx, `
		INSERT INTO users(username,display_name,email,role,oidc_subject)
		VALUES($1,$2,NULLIF($3,''),$4,$5)
		ON CONFLICT(oidc_subject) DO UPDATE SET display_name=EXCLUDED.display_name,email=EXCLUDED.email,role=EXCLUDED.role,active=true,updated_at=now()
		RETURNING id,username,display_name,COALESCE(email,''),role,team_id,active`, username, display, email, role, subject).
		Scan(&u.ID, &u.Username, &u.DisplayName, &u.Email, &u.Role, &u.TeamID, &u.Active)
	if err == nil {
		_, _ = s.Pool.Exec(ctx, `INSERT INTO user_preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING`, u.ID)
	}
	return u, err
}

func (s *Store) GetSetting(ctx context.Context, key string, dst any) error {
	return getSetting(ctx, s.Pool, key, dst)
}

// GetSettingTx keeps setting reads on an existing transaction connection.
func (s *Store) GetSettingTx(ctx context.Context, tx pgx.Tx, key string, dst any) error {
	return getSetting(ctx, tx, key, dst)
}

func getSetting(ctx context.Context, query rowQuerier, key string, dst any) error {
	var raw []byte
	if err := query.QueryRow(ctx, `SELECT value FROM app_settings WHERE key=$1`, key).Scan(&raw); err != nil {
		return err
	}
	return json.Unmarshal(raw, dst)
}

func (s *Store) AllSettings(ctx context.Context) (map[string]json.RawMessage, error) {
	rows, err := s.Pool.Query(ctx, `SELECT key,value FROM app_settings ORDER BY key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]json.RawMessage{}
	for rows.Next() {
		var k string
		var v []byte
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

func (s *Store) PutSetting(ctx context.Context, key string, value any, actor uuid.UUID) error {
	if !AllowedSetting(key) {
		return errors.New("unknown setting section")
	}
	switch key {
	case "security":
		return s.putSettingPreserving(ctx, key, value, actor, []string{
			"login_max_failures",
			"login_lockout_minutes",
			"api_rate_per_minute",
			"ai_rate_per_minute",
			"ai_daily_limit",
		})
	case "oidc":
		return s.putSettingPreserving(ctx, key, value, actor, []string{"client_secret"})
	case "ai_gateway":
		return s.putSettingPreserving(ctx, key, value, actor, []string{"api_key"})
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = s.Pool.Exec(ctx, `INSERT INTO app_settings(key,value,updated_by,updated_at) VALUES($1,$2,$3,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`, key, raw, actor)
	return err
}

// LockSettingTx serializes read/merge/write setting transitions, including
// master-key rotation when the row may not exist yet.
func (s *Store) LockSettingTx(ctx context.Context, tx pgx.Tx, key string) error {
	if !AllowedSetting(key) {
		return errors.New("unknown setting section")
	}
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "umm:app-setting:"+key)
	return err
}

// putSettingPreserving applies backward-compatible object updates under a
// transaction-scoped lock. Older clients do not know newly added fields, so a
// whole-object PUT must retain those fields from the latest committed row while
// still honoring every field that the caller explicitly supplied.
func (s *Store) putSettingPreserving(ctx context.Context, key string, value any, actor uuid.UUID, preserve []string) error {
	incomingRaw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	incoming := map[string]json.RawMessage{}
	if err = json.Unmarshal(incomingRaw, &incoming); err != nil {
		return fmt.Errorf("decode incoming setting %q: %w", key, err)
	}
	if incoming == nil {
		return fmt.Errorf("setting %q must be a JSON object", key)
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin setting update %q: %w", key, err)
	}
	defer tx.Rollback(context.Background())
	if err = s.LockSettingTx(ctx, tx, key); err != nil {
		return fmt.Errorf("lock setting %q: %w", key, err)
	}

	var existingRaw []byte
	err = tx.QueryRow(ctx, `SELECT value FROM app_settings WHERE key=$1`, key).Scan(&existingRaw)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("read setting %q: %w", key, err)
	}
	if err == nil {
		existing := map[string]json.RawMessage{}
		if err = json.Unmarshal(existingRaw, &existing); err != nil {
			return fmt.Errorf("decode stored setting %q: %w", key, err)
		}
		for _, field := range preserve {
			if _, supplied := incoming[field]; supplied {
				continue
			}
			if raw, exists := existing[field]; exists {
				incoming[field] = raw
			}
		}
	}

	mergedRaw, err := json.Marshal(incoming)
	if err != nil {
		return fmt.Errorf("encode setting %q: %w", key, err)
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO app_settings(key,value,updated_by,updated_at)
		VALUES($1,$2,$3,now())
		ON CONFLICT(key) DO UPDATE
		SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`, key, mergedRaw, actor); err != nil {
		return fmt.Errorf("write setting %q: %w", key, err)
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit setting update %q: %w", key, err)
	}
	return nil
}

func AllowedSetting(key string) bool {
	switch key {
	case "general", "oidc", "security", "workflow", "dream", "ai_gateway", "intelligence":
		return true
	}
	return false
}

func (s *Store) EnsureDefaultSpace(ctx context.Context, userID uuid.UUID) (Space, error) {
	var sp Space
	err := s.Pool.QueryRow(ctx, `SELECT id,owner_id,name,color,ai_excluded FROM spaces WHERE owner_id=$1 ORDER BY created_at LIMIT 1`, userID).Scan(&sp.ID, &sp.OwnerID, &sp.Name, &sp.Color, &sp.AIExcluded)
	if err == nil {
		return sp, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return sp, err
	}
	err = s.Pool.QueryRow(ctx, `INSERT INTO spaces(owner_id,name) VALUES($1,'My Space') RETURNING id,owner_id,name,color,ai_excluded`, userID).Scan(&sp.ID, &sp.OwnerID, &sp.Name, &sp.Color, &sp.AIExcluded)
	return sp, err
}

func (s *Store) ListSpaces(ctx context.Context, userID uuid.UUID) ([]Space, error) {
	rows, err := s.Pool.Query(ctx, `SELECT DISTINCT s.id,s.owner_id,s.name,s.color,s.ai_excluded FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id WHERE s.owner_id=$1 OR m.user_id=$1 ORDER BY s.name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Space{}
	for rows.Next() {
		var v Space
		if err := rows.Scan(&v.ID, &v.OwnerID, &v.Name, &v.Color, &v.AIExcluded); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Store) CreateSpace(ctx context.Context, userID uuid.UUID, name string) (Space, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "새 공간"
	}
	var v Space
	err := s.Pool.QueryRow(ctx, `INSERT INTO spaces(owner_id,name) VALUES($1,$2) RETURNING id,owner_id,name,color,ai_excluded`, userID, name).Scan(&v.ID, &v.OwnerID, &v.Name, &v.Color, &v.AIExcluded)
	return v, err
}

func (s *Store) UpdateSpace(ctx context.Context, userID, spaceID uuid.UUID, name string, aiExcluded *bool) (Space, error) {
	name = strings.TrimSpace(name)
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Space{}, err
	}
	defer tx.Rollback(ctx)
	var v Space
	err = tx.QueryRow(ctx, `UPDATE spaces sp SET name=$3,ai_excluded=COALESCE($4,ai_excluded),updated_at=now() WHERE sp.id=$1 AND (sp.owner_id=$2 OR EXISTS(SELECT 1 FROM space_members sm WHERE sm.space_id=sp.id AND sm.user_id=$2 AND sm.permission='manage')) RETURNING id,owner_id,name,color,ai_excluded`, spaceID, userID, name, aiExcluded).
		Scan(&v.ID, &v.OwnerID, &v.Name, &v.Color, &v.AIExcluded)
	if err != nil {
		return Space{}, err
	}
	if err = s.AppendSpaceEvent(ctx, tx, userID, spaceID, "space.updated", spaceID, v); err != nil {
		return Space{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Space{}, err
	}
	return v, nil
}

func (s *Store) DeleteSpace(ctx context.Context, userID, spaceID uuid.UUID) error {
	cmd, err := s.Pool.Exec(ctx, `DELETE FROM spaces WHERE id=$1 AND owner_id=$2`, spaceID, userID)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func (s *Store) ListNotes(ctx context.Context, userID, spaceID uuid.UUID, query string) ([]Note, []Edge, error) {
	patterns := noteSearchPatterns(query)
	b := &queryBuilder{}
	space := b.bind(spaceID)
	user := b.bind(userID)
	match := "true"
	if len(patterns) > 0 {
		match = allMatch(noteTextExpression, patterns, b)
	}
	rows, err := s.Pool.Query(ctx, fmt.Sprintf(`
		SELECT n.id,n.space_id,n.author_id,n.content,n.title,n.color,n.kind,n.source,n.ai_excluded,
		       n.x,n.y,n.width,n.height,n.rotation,n.version,n.created_at,n.updated_at
		FROM notes n
		JOIN spaces sp ON sp.id=n.space_id
		LEFT JOIN space_members sm ON sm.space_id=sp.id AND sm.user_id=%s
		WHERE n.space_id=%s AND n.deleted_at IS NULL AND (sp.owner_id=%s OR sm.user_id=%s)
		  AND %s
		ORDER BY n.created_at`, user, space, user, user, match), b.args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	notes := []Note{}
	for rows.Next() {
		var n Note
		if err := rows.Scan(&n.ID, &n.SpaceID, &n.AuthorID, &n.Content, &n.Title, &n.Color, &n.Kind, &n.Source, &n.AIExcluded, &n.X, &n.Y, &n.Width, &n.Height, &n.Rotation, &n.Version, &n.CreatedAt, &n.UpdatedAt); err != nil {
			return nil, nil, err
		}
		notes = append(notes, n)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	rows.Close()
	if len(notes) == 0 {
		allowed, accessErr := s.checkSpaceViewAccess(ctx, userID, spaceID)
		if accessErr != nil {
			return nil, nil, accessErr
		}
		if !allowed {
			return nil, nil, pgx.ErrNoRows
		}
	}
	noteIDs := make([]uuid.UUID, len(notes))
	for i := range notes {
		noteIDs[i] = notes[i].ID
	}
	s.ensureEmbeddings(ctx, notes)
	vectors := s.loadEmbeddings(ctx, notes)
	// The cutoff is derived from this space's own score distribution rather than
	// fixed, so the count means the same thing whether the vectors came from the
	// offline algorithm or a configured embedding model. See intelligence.SimilarityScale.
	pairScores := make([]float64, 0, len(notes)*len(notes))
	for i := range notes {
		for j := i + 1; j < len(notes); j++ {
			pairScores = append(pairScores, intelligence.Cosine(vectors[notes[i].ID], vectors[notes[j].ID]))
		}
	}
	relatedCutoff := intelligence.NewSimilarityScale(pairScores).ThresholdOr(intelligence.Band(s.IntelligenceSettings(ctx).ClusterBand), legacyClusterCutoff)
	for i := range notes {
		for j := range notes {
			if i != j && intelligence.Cosine(vectors[notes[i].ID], vectors[notes[j].ID]) >= relatedCutoff {
				notes[i].RelatedCount++
			}
		}
	}
	edgeRows, err := s.Pool.Query(ctx, `
		SELECT e.id,e.space_id,e.source_note_id,e.target_note_id,e.relation,e.origin,e.confidence
		FROM note_edges e
		JOIN spaces sp ON sp.id=e.space_id
		LEFT JOIN space_members sm ON sm.space_id=sp.id AND sm.user_id=$3
		WHERE e.space_id=$1 AND e.source_note_id=ANY($2) AND e.target_note_id=ANY($2)
		  AND (sp.owner_id=$3 OR sm.user_id=$3)`, spaceID, noteIDs, userID)
	if err != nil {
		return nil, nil, err
	}
	defer edgeRows.Close()
	edges := []Edge{}
	for edgeRows.Next() {
		var e Edge
		if err := edgeRows.Scan(&e.ID, &e.SpaceID, &e.SourceID, &e.TargetID, &e.Relation, &e.Origin, &e.Confidence); err != nil {
			return nil, nil, err
		}
		edges = append(edges, e)
	}
	return notes, edges, edgeRows.Err()
}

func (s *Store) CanViewSpace(ctx context.Context, userID, spaceID uuid.UUID) bool {
	ok, _ := s.checkSpaceViewAccess(ctx, userID, spaceID)
	return ok
}

func (s *Store) checkSpaceViewAccess(ctx context.Context, userID, spaceID uuid.UUID) (bool, error) {
	var ok bool
	err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=$1 WHERE s.id=$2 AND (s.owner_id=$1 OR m.user_id=$1))`, userID, spaceID).Scan(&ok)
	return ok, err
}

func (s *Store) CreateNote(ctx context.Context, userID uuid.UUID, n Note) (Note, error) {
	if n.Color == "" {
		n.Color = "yellow"
	}
	if n.Kind == "" {
		n.Kind = "thought"
	}
	if n.Source == "" {
		n.Source = "user"
	}
	if n.Width == 0 {
		n.Width = 240
	}
	if n.Height == 0 {
		n.Height = 160
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Note{}, err
	}
	defer tx.Rollback(ctx)
	err = tx.QueryRow(ctx, `
		INSERT INTO notes(space_id,author_id,content,title,color,kind,source,ai_excluded,x,y,width,height,rotation)
		SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
		WHERE EXISTS(SELECT 1 FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=$2 WHERE s.id=$1 AND (s.owner_id=$2 OR m.permission IN ('edit','manage')))
		RETURNING id,space_id,author_id,content,title,color,kind,source,ai_excluded,x,y,width,height,rotation,version,created_at,updated_at`,
		n.SpaceID, userID, n.Content, n.Title, n.Color, n.Kind, n.Source, n.AIExcluded, n.X, n.Y, n.Width, n.Height, n.Rotation).
		Scan(&n.ID, &n.SpaceID, &n.AuthorID, &n.Content, &n.Title, &n.Color, &n.Kind, &n.Source, &n.AIExcluded, &n.X, &n.Y, &n.Width, &n.Height, &n.Rotation, &n.Version, &n.CreatedAt, &n.UpdatedAt)
	if err != nil {
		return Note{}, err
	}
	if err = s.AppendSpaceEvent(ctx, tx, userID, n.SpaceID, "note.created", n.ID, n); err != nil {
		return Note{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Note{}, err
	}
	_ = s.UpsertEmbedding(ctx, n.ID, n.Content, n.Version)
	return n, nil
}

func (s *Store) UpdateNote(ctx context.Context, userID uuid.UUID, n Note, aiExcluded *bool) (Note, error) {
	return s.updateNote(ctx, userID, n, aiExcluded, "note.updated")
}

func (s *Store) updateNote(ctx context.Context, userID uuid.UUID, n Note, aiExcluded *bool, eventType string) (Note, error) {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Note{}, err
	}
	defer tx.Rollback(ctx)
	_, err = tx.Exec(ctx, `INSERT INTO note_revisions(note_id,version,content,title,color,kind,x,y,width,height,rotation,changed_by) SELECT id,version,content,title,color,kind,x,y,width,height,rotation,$3 FROM notes WHERE id=$1 AND version=$2 AND deleted_at IS NULL ON CONFLICT(note_id,version) DO NOTHING`, n.ID, n.Version, userID)
	if err != nil {
		return Note{}, err
	}
	err = tx.QueryRow(ctx, `UPDATE notes SET content=$3,title=$4,color=$5,kind=$6,ai_excluded=COALESCE($7,ai_excluded),x=$8,y=$9,width=$10,height=$11,rotation=$12,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=$13 WHERE s.id=notes.space_id AND (s.owner_id=$13 OR m.permission IN ('edit','manage'))) RETURNING id,space_id,author_id,content,title,color,kind,source,ai_excluded,x,y,width,height,rotation,version,created_at,updated_at`, n.ID, n.Version, n.Content, n.Title, n.Color, n.Kind, aiExcluded, n.X, n.Y, n.Width, n.Height, n.Rotation, userID).Scan(&n.ID, &n.SpaceID, &n.AuthorID, &n.Content, &n.Title, &n.Color, &n.Kind, &n.Source, &n.AIExcluded, &n.X, &n.Y, &n.Width, &n.Height, &n.Rotation, &n.Version, &n.CreatedAt, &n.UpdatedAt)
	if err != nil {
		return Note{}, err
	}
	if err = s.AppendSpaceEvent(ctx, tx, userID, n.SpaceID, eventType, n.ID, n); err != nil {
		return Note{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Note{}, err
	}
	_ = s.UpsertEmbedding(ctx, n.ID, n.Content, n.Version)
	return n, nil
}

func (s *Store) DeleteNote(ctx context.Context, userID, noteID uuid.UUID) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var spaceID uuid.UUID
	err = tx.QueryRow(ctx, `UPDATE notes SET deleted_at=now(),updated_at=now() WHERE id=$1 AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=$2 WHERE s.id=notes.space_id AND (s.owner_id=$2 OR m.permission IN ('edit','manage'))) RETURNING space_id`, noteID, userID).Scan(&spaceID)
	if err != nil {
		return err
	}
	if err = s.AppendSpaceEvent(ctx, tx, userID, spaceID, "note.deleted", noteID, map[string]any{}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// CreateEdge records a connection a person drew through the web API.
func (s *Store) CreateEdge(ctx context.Context, userID uuid.UUID, e Edge) (Edge, error) {
	return s.createEdge(ctx, userID, e, OriginManual)
}

// CreateAgentEdge records a connection asserted through MCP by an agent holding
// a scoped key. Same rules as a manual edge, different provenance: once agents
// write into someone's memory, the person has to be able to see which parts of
// it they wrote.
func (s *Store) CreateAgentEdge(ctx context.Context, userID uuid.UUID, e Edge) (Edge, error) {
	return s.createEdge(ctx, userID, e, OriginAgent)
}

// createEdge is the single write path for asserted connections. Origin is an
// argument from the calling code, never a field carried in from a request body:
// letting a client choose it would restore exactly the hole this vocabulary was
// introduced to close — claiming that Dream, or umm's own inference, produced a
// connection the client drew.
func (s *Store) createEdge(ctx context.Context, userID uuid.UUID, e Edge, origin Origin) (Edge, error) {
	relation, err := ParseRelation(string(e.Relation))
	if err != nil {
		return Edge{}, err
	}
	e.Relation = relation
	e.Origin = origin
	e.Confidence = nil
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return Edge{}, err
	}
	defer tx.Rollback(ctx)
	err = tx.QueryRow(ctx, `
		INSERT INTO note_edges(space_id,source_note_id,target_note_id,relation,origin,created_by)
		SELECT $1,$2,$3,$4,$6,$5
		WHERE EXISTS(SELECT 1 FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=$5 WHERE s.id=$1 AND (s.owner_id=$5 OR m.permission IN ('edit','manage')))
		  AND EXISTS(SELECT 1 FROM notes WHERE id=$2 AND space_id=$1 AND deleted_at IS NULL)
		  AND EXISTS(SELECT 1 FROM notes WHERE id=$3 AND space_id=$1 AND deleted_at IS NULL)
		RETURNING id`, e.SpaceID, e.SourceID, e.TargetID, e.Relation, userID, e.Origin).Scan(&e.ID)
	if err != nil {
		return Edge{}, err
	}
	if err = s.AppendSpaceEvent(ctx, tx, userID, e.SpaceID, "edge.created", e.ID, e); err != nil {
		return Edge{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Edge{}, err
	}
	return e, nil
}

func (s *Store) Audit(ctx context.Context, actor *uuid.UUID, action, resourceType, resourceID string, metadata any) {
	raw, _ := json.Marshal(metadata)
	_, _ = s.Pool.Exec(ctx, `INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,$4,$5)`, actor, action, resourceType, resourceID, raw)
}

func (s *Store) RelatedNotes(ctx context.Context, userID, noteID uuid.UUID, limit int) ([]RelatedNote, error) {
	if limit < 1 || limit > 20 {
		limit = 5
	}
	var base Note
	err := s.Pool.QueryRow(ctx, `SELECT n.id,n.space_id,n.author_id,n.content,n.title,n.color,n.kind,n.source,n.ai_excluded,n.x,n.y,n.width,n.height,n.rotation,n.version,n.created_at,n.updated_at FROM notes n WHERE n.id=$1 AND n.deleted_at IS NULL AND EXISTS(SELECT 1 FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=$2 WHERE s.id=n.space_id AND (s.owner_id=$2 OR m.user_id=$2))`, noteID, userID).Scan(&base.ID, &base.SpaceID, &base.AuthorID, &base.Content, &base.Title, &base.Color, &base.Kind, &base.Source, &base.AIExcluded, &base.X, &base.Y, &base.Width, &base.Height, &base.Rotation, &base.Version, &base.CreatedAt, &base.UpdatedAt)
	if err != nil {
		return nil, err
	}
	notes, _, err := s.ListNotes(ctx, userID, base.SpaceID, "")
	if err != nil {
		return nil, err
	}
	vectors := s.loadEmbeddings(ctx, notes)
	baseVector := vectors[noteID]
	// Score everything first so the bar can be placed against the distribution
	// this note actually sits in; a constant would admit the whole workspace
	// under a sentence embedding model and almost nothing under the offline one.
	scores := make(map[uuid.UUID]float64, len(notes))
	observed := make([]float64, 0, len(notes))
	for _, n := range notes {
		if n.ID == noteID {
			continue
		}
		score := intelligence.Cosine(baseVector, vectors[n.ID])
		scores[n.ID] = score
		observed = append(observed, score)
	}
	bands := s.IntelligenceSettings(ctx)
	cutoff := intelligence.NewSimilarityScale(observed).ThresholdOr(intelligence.Band(bands.RelatedBand), legacyRelatedCutoff)
	related := []RelatedNote{}
	for _, n := range notes {
		if n.ID == noteID {
			continue
		}
		if score := scores[n.ID]; score >= cutoff {
			keywords := intelligence.Keywords(base.Content+" "+n.Content, 2)
			related = append(related, RelatedNote{Note: n, Score: score, Reason: strings.Join(keywords, " · ")})
		}
	}
	sort.Slice(related, func(i, j int) bool { return related[i].Score > related[j].Score })
	if len(related) > limit {
		related = related[:limit]
	}
	return related, nil
}

func (s *Store) Clusters(ctx context.Context, userID, spaceID uuid.UUID) ([]ThoughtCluster, error) {
	notes, _, err := s.ListNotes(ctx, userID, spaceID, "")
	if err != nil {
		return nil, err
	}
	vectors := s.loadEmbeddings(ctx, notes)
	// One cutoff for the whole space, taken from every pair in it. Deriving it
	// per seed would let a note with no strong neighbours drag its own bar down
	// until anything joined it.
	pairScores := make([]float64, 0, len(notes)*len(notes)/2)
	for i := range notes {
		for j := i + 1; j < len(notes); j++ {
			pairScores = append(pairScores, intelligence.Cosine(vectors[notes[i].ID], vectors[notes[j].ID]))
		}
	}
	cutoff := intelligence.NewSimilarityScale(pairScores).ThresholdOr(intelligence.Band(s.IntelligenceSettings(ctx).ClusterBand), legacyClusterCutoff)
	used := map[uuid.UUID]bool{}
	clusters := []ThoughtCluster{}
	for _, seed := range notes {
		if used[seed.ID] {
			continue
		}
		ids := []uuid.UUID{seed.ID}
		used[seed.ID] = true
		var cohesion float64
		text := seed.Content
		for _, candidate := range notes {
			if used[candidate.ID] {
				continue
			}
			score := intelligence.Cosine(vectors[seed.ID], vectors[candidate.ID])
			if score >= cutoff {
				ids = append(ids, candidate.ID)
				used[candidate.ID] = true
				cohesion += score
				text += " " + candidate.Content
			}
		}
		if len(ids) < 2 {
			continue
		}
		keywords := intelligence.Keywords(text, 2)
		label := "연결된 생각"
		if len(keywords) > 0 {
			label = strings.Join(keywords, " · ")
		}
		clusters = append(clusters, ThoughtCluster{ID: "cluster-" + seed.ID.String(), Label: label, NoteIDs: ids, Cohesion: cohesion / float64(len(ids)-1)})
	}
	sort.Slice(clusters, func(i, j int) bool { return clusters[i].Cohesion > clusters[j].Cohesion })
	return clusters, nil
}

func (s *Store) NoteHistory(ctx context.Context, userID, noteID uuid.UUID) ([]NoteRevision, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT r.version,r.content,r.title,r.color,r.kind,r.x,r.y,r.width,r.height,r.rotation,r.created_at
		FROM note_revisions r
		JOIN notes n ON n.id=r.note_id AND n.deleted_at IS NULL
		JOIN spaces sp ON sp.id=n.space_id
		LEFT JOIN space_members sm ON sm.space_id=sp.id AND sm.user_id=$2
		WHERE r.note_id=$1 AND (sp.owner_id=$2 OR sm.user_id=$2)
		ORDER BY r.version DESC LIMIT 50`, noteID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []NoteRevision{}
	for rows.Next() {
		var v NoteRevision
		if err := rows.Scan(&v.Version, &v.Content, &v.Title, &v.Color, &v.Kind, &v.X, &v.Y, &v.Width, &v.Height, &v.Rotation, &v.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if len(out) == 0 {
		allowed, accessErr := s.noteViewAccess(ctx, userID, noteID)
		if accessErr != nil {
			return nil, accessErr
		}
		if !allowed {
			return nil, pgx.ErrNoRows
		}
	}
	return out, nil
}
func (s *Store) RestoreNote(ctx context.Context, userID, noteID uuid.UUID, version int) (Note, error) {
	var n Note
	err := s.Pool.QueryRow(ctx, `SELECT n.id,n.space_id,n.author_id,r.content,r.title,r.color,r.kind,n.source,n.ai_excluded,r.x,r.y,r.width,r.height,r.rotation,n.version,n.created_at,n.updated_at FROM notes n JOIN note_revisions r ON r.note_id=n.id AND r.version=$2 WHERE n.id=$1 AND n.deleted_at IS NULL`, noteID, version).Scan(&n.ID, &n.SpaceID, &n.AuthorID, &n.Content, &n.Title, &n.Color, &n.Kind, &n.Source, &n.AIExcluded, &n.X, &n.Y, &n.Width, &n.Height, &n.Rotation, &n.Version, &n.CreatedAt, &n.UpdatedAt)
	if err != nil {
		return Note{}, err
	}
	return s.updateNote(ctx, userID, n, &n.AIExcluded, "note.restored")
}
