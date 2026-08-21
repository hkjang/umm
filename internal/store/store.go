package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/intelligence"
	"github.com/hkjang/umm/migrations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

type Store struct{ Pool *pgxpool.Pool }

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
	Relation string    `json:"relation"`
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
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect postgres: %w", err)
	}
	return &Store{Pool: pool}, nil
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
	var u User
	var hash *string
	err := s.Pool.QueryRow(ctx, `SELECT id,username,display_name,COALESCE(email,''),role,team_id,active,password_hash FROM users WHERE username=$1`, username).
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
	var raw []byte
	if err := s.Pool.QueryRow(ctx, `SELECT value FROM app_settings WHERE key=$1`, key).Scan(&raw); err != nil {
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
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = s.Pool.Exec(ctx, `INSERT INTO app_settings(key,value,updated_by,updated_at) VALUES($1,$2,$3,now()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`, key, raw, actor)
	return err
}

func AllowedSetting(key string) bool {
	switch key {
	case "general", "oidc", "security", "workflow", "dream", "ai_gateway":
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
	var v Space
	err := s.Pool.QueryRow(ctx, `UPDATE spaces sp SET name=$3,ai_excluded=COALESCE($4,ai_excluded),updated_at=now() WHERE sp.id=$1 AND (sp.owner_id=$2 OR EXISTS(SELECT 1 FROM space_members sm WHERE sm.space_id=sp.id AND sm.user_id=$2 AND sm.permission='manage')) RETURNING id,owner_id,name,color,ai_excluded`, spaceID, userID, name, aiExcluded).
		Scan(&v.ID, &v.OwnerID, &v.Name, &v.Color, &v.AIExcluded)
	return v, err
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

func (s *Store) CanEditSpace(ctx context.Context, userID, spaceID uuid.UUID) bool {
	var ok bool
	_ = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=$1 WHERE s.id=$2 AND (s.owner_id=$1 OR m.permission IN ('edit','manage')))`, userID, spaceID).Scan(&ok)
	return ok
}

func noteSearchPatterns(query string) []string {
	escape := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	terms := strings.Fields(strings.TrimSpace(query))
	patterns := make([]string, 0, len(terms))
	for _, term := range terms {
		patterns = append(patterns, "%"+escape.Replace(term)+"%")
	}
	return patterns
}

func (s *Store) SearchNotes(ctx context.Context, userID uuid.UUID, query string, limit int) ([]NoteSearchResult, error) {
	patterns := noteSearchPatterns(query)
	if len(patterns) == 0 {
		return []NoteSearchResult{}, nil
	}
	if limit < 1 {
		limit = 12
	}
	if limit > 30 {
		limit = 30
	}
	rows, err := s.Pool.Query(ctx, `
		SELECT n.id,n.space_id,sp.name,n.title,left(n.content,500),n.kind,n.updated_at
		FROM notes n
		JOIN spaces sp ON sp.id=n.space_id
		WHERE n.deleted_at IS NULL
		  AND (sp.owner_id=$1 OR EXISTS(SELECT 1 FROM space_members sm WHERE sm.space_id=sp.id AND sm.user_id=$1))
		  AND NOT EXISTS(
			SELECT 1 FROM unnest($2::text[]) AS term(pattern)
			WHERE concat_ws(' ',n.title,n.content,sp.name) NOT ILIKE term.pattern ESCAPE E'\\'
		  )
		ORDER BY (NULLIF(trim(n.title),'') IS NOT NULL) DESC,n.updated_at DESC
		LIMIT $3`, userID, patterns, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	results := []NoteSearchResult{}
	for rows.Next() {
		var result NoteSearchResult
		if err := rows.Scan(&result.ID, &result.SpaceID, &result.SpaceName, &result.Title, &result.Content, &result.Kind, &result.UpdatedAt); err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	return results, rows.Err()
}

func (s *Store) ListNotes(ctx context.Context, userID, spaceID uuid.UUID, query string) ([]Note, []Edge, error) {
	if !s.CanViewSpace(ctx, userID, spaceID) {
		return nil, nil, pgx.ErrNoRows
	}
	patterns := noteSearchPatterns(query)
	rows, err := s.Pool.Query(ctx, `SELECT id,space_id,author_id,content,title,color,kind,source,ai_excluded,x,y,width,height,rotation,version,created_at,updated_at FROM notes WHERE space_id=$1 AND deleted_at IS NULL AND (cardinality($2::text[])=0 OR NOT EXISTS(SELECT 1 FROM unnest($2::text[]) AS term(pattern) WHERE concat_ws(' ',content,title) NOT ILIKE term.pattern ESCAPE E'\\')) ORDER BY created_at`, spaceID, patterns)
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
	noteIDs := make([]uuid.UUID, len(notes))
	for i := range notes {
		noteIDs[i] = notes[i].ID
	}
	s.ensureEmbeddings(ctx, notes)
	vectors := s.loadEmbeddings(ctx, notes)
	for i := range notes {
		for j := range notes {
			if i != j && intelligence.Cosine(vectors[notes[i].ID], vectors[notes[j].ID]) >= .34 {
				notes[i].RelatedCount++
			}
		}
	}
	edgeRows, err := s.Pool.Query(ctx, `SELECT id,space_id,source_note_id,target_note_id,relation FROM note_edges WHERE space_id=$1 AND source_note_id=ANY($2) AND target_note_id=ANY($2)`, spaceID, noteIDs)
	if err != nil {
		return nil, nil, err
	}
	defer edgeRows.Close()
	edges := []Edge{}
	for edgeRows.Next() {
		var e Edge
		if err := edgeRows.Scan(&e.ID, &e.SpaceID, &e.SourceID, &e.TargetID, &e.Relation); err != nil {
			return nil, nil, err
		}
		edges = append(edges, e)
	}
	return notes, edges, edgeRows.Err()
}

func (s *Store) CanViewSpace(ctx context.Context, userID, spaceID uuid.UUID) bool {
	var ok bool
	_ = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=$1 WHERE s.id=$2 AND (s.owner_id=$1 OR m.user_id=$1))`, userID, spaceID).Scan(&ok)
	return ok
}

func (s *Store) CreateNote(ctx context.Context, userID uuid.UUID, n Note) (Note, error) {
	if !s.CanEditSpace(ctx, userID, n.SpaceID) {
		return Note{}, pgx.ErrNoRows
	}
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
	err := s.Pool.QueryRow(ctx, `INSERT INTO notes(space_id,author_id,content,title,color,kind,source,ai_excluded,x,y,width,height,rotation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id,space_id,author_id,content,title,color,kind,source,ai_excluded,x,y,width,height,rotation,version,created_at,updated_at`, n.SpaceID, userID, n.Content, n.Title, n.Color, n.Kind, n.Source, n.AIExcluded, n.X, n.Y, n.Width, n.Height, n.Rotation).Scan(&n.ID, &n.SpaceID, &n.AuthorID, &n.Content, &n.Title, &n.Color, &n.Kind, &n.Source, &n.AIExcluded, &n.X, &n.Y, &n.Width, &n.Height, &n.Rotation, &n.Version, &n.CreatedAt, &n.UpdatedAt)
	if err == nil {
		_ = s.UpsertEmbedding(ctx, n.ID, n.Content, n.Version)
	}
	return n, err
}

func (s *Store) UpdateNote(ctx context.Context, userID uuid.UUID, n Note, aiExcluded *bool) (Note, error) {
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
	if err = tx.Commit(ctx); err != nil {
		return Note{}, err
	}
	_ = s.UpsertEmbedding(ctx, n.ID, n.Content, n.Version)
	return n, nil
}

func (s *Store) DeleteNote(ctx context.Context, userID, noteID uuid.UUID) error {
	cmd, err := s.Pool.Exec(ctx, `UPDATE notes SET deleted_at=now(),updated_at=now() WHERE id=$1 AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=$2 WHERE s.id=notes.space_id AND (s.owner_id=$2 OR m.permission IN ('edit','manage')))`, noteID, userID)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

func (s *Store) CreateEdge(ctx context.Context, userID uuid.UUID, e Edge) (Edge, error) {
	if !s.CanEditSpace(ctx, userID, e.SpaceID) {
		return Edge{}, pgx.ErrNoRows
	}
	if e.Relation == "" {
		e.Relation = "related"
	}
	err := s.Pool.QueryRow(ctx, `INSERT INTO note_edges(space_id,source_note_id,target_note_id,relation,created_by) SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM notes WHERE id=$2 AND space_id=$1 AND deleted_at IS NULL) AND EXISTS(SELECT 1 FROM notes WHERE id=$3 AND space_id=$1 AND deleted_at IS NULL) RETURNING id`, e.SpaceID, e.SourceID, e.TargetID, e.Relation, userID).Scan(&e.ID)
	return e, err
}

func (s *Store) Audit(ctx context.Context, actor *uuid.UUID, action, resourceType, resourceID string, metadata any) {
	raw, _ := json.Marshal(metadata)
	_, _ = s.Pool.Exec(ctx, `INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,$4,$5)`, actor, action, resourceType, resourceID, raw)
}

func (s *Store) UpsertEmbedding(ctx context.Context, noteID uuid.UUID, content string, version int) error {
	vector := intelligence.Embed(content)
	_, err := s.Pool.Exec(ctx, `INSERT INTO note_embeddings(note_id,dimensions,vector,content_version,updated_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(note_id) DO UPDATE SET dimensions=EXCLUDED.dimensions,vector=EXCLUDED.vector,content_version=EXCLUDED.content_version,updated_at=now() WHERE note_embeddings.content_version<EXCLUDED.content_version`, noteID, len(vector), vector, version)
	return err
}
func (s *Store) ensureEmbeddings(ctx context.Context, notes []Note) {
	for _, n := range notes {
		_ = s.UpsertEmbedding(ctx, n.ID, n.Content, n.Version)
	}
}
func (s *Store) loadEmbeddings(ctx context.Context, notes []Note) map[uuid.UUID][]float32 {
	out := map[uuid.UUID][]float32{}
	if len(notes) == 0 {
		return out
	}
	ids := make([]uuid.UUID, len(notes))
	for i, n := range notes {
		ids[i] = n.ID
	}
	rows, err := s.Pool.Query(ctx, `SELECT note_id,vector FROM note_embeddings WHERE note_id=ANY($1)`, ids)
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
	related := []RelatedNote{}
	for _, n := range notes {
		if n.ID == noteID {
			continue
		}
		score := intelligence.Cosine(baseVector, vectors[n.ID])
		if score >= .22 {
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
			if score >= .34 {
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
	var allowed bool
	_ = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM notes n JOIN spaces sp ON sp.id=n.space_id LEFT JOIN space_members sm ON sm.space_id=sp.id AND sm.user_id=$2 WHERE n.id=$1 AND (sp.owner_id=$2 OR sm.user_id=$2))`, noteID, userID).Scan(&allowed)
	if !allowed {
		return nil, pgx.ErrNoRows
	}
	rows, err := s.Pool.Query(ctx, `SELECT version,content,title,color,kind,x,y,width,height,rotation,created_at FROM note_revisions WHERE note_id=$1 ORDER BY version DESC LIMIT 50`, noteID)
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
	return out, rows.Err()
}
func (s *Store) RestoreNote(ctx context.Context, userID, noteID uuid.UUID, version int) (Note, error) {
	var n Note
	err := s.Pool.QueryRow(ctx, `SELECT n.id,n.space_id,n.author_id,r.content,r.title,r.color,r.kind,n.source,n.ai_excluded,r.x,r.y,r.width,r.height,r.rotation,n.version,n.created_at,n.updated_at FROM notes n JOIN note_revisions r ON r.note_id=n.id AND r.version=$2 WHERE n.id=$1 AND n.deleted_at IS NULL`, noteID, version).Scan(&n.ID, &n.SpaceID, &n.AuthorID, &n.Content, &n.Title, &n.Color, &n.Kind, &n.Source, &n.AIExcluded, &n.X, &n.Y, &n.Width, &n.Height, &n.Rotation, &n.Version, &n.CreatedAt, &n.UpdatedAt)
	if err != nil {
		return Note{}, err
	}
	return s.UpdateNote(ctx, userID, n, &n.AIExcluded)
}
