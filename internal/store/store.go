package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
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
	ID      uuid.UUID `json:"id"`
	OwnerID uuid.UUID `json:"ownerId"`
	Name    string    `json:"name"`
	Color   string    `json:"color"`
}

type Note struct {
	ID        uuid.UUID `json:"id"`
	SpaceID   uuid.UUID `json:"spaceId"`
	AuthorID  uuid.UUID `json:"authorId"`
	Content   string    `json:"content"`
	Title     string    `json:"title"`
	Color     string    `json:"color"`
	Kind      string    `json:"kind"`
	Source    string    `json:"source"`
	X         float64   `json:"x"`
	Y         float64   `json:"y"`
	Width     float64   `json:"width"`
	Height    float64   `json:"height"`
	Rotation  float64   `json:"rotation"`
	Version   int       `json:"version"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Edge struct {
	ID       uuid.UUID `json:"id"`
	SpaceID  uuid.UUID `json:"spaceId"`
	SourceID uuid.UUID `json:"source"`
	TargetID uuid.UUID `json:"target"`
	Relation string    `json:"relation"`
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
	initialSchema, err := migrations.FS.ReadFile("001_init.sql")
	if err != nil {
		return fmt.Errorf("read embedded schema: %w", err)
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, string(initialSchema)); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO schema_migrations(version) VALUES('001_init') ON CONFLICT DO NOTHING`)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
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
	err := s.Pool.QueryRow(ctx, `SELECT id,owner_id,name,color FROM spaces WHERE owner_id=$1 ORDER BY created_at LIMIT 1`, userID).Scan(&sp.ID, &sp.OwnerID, &sp.Name, &sp.Color)
	if err == nil {
		return sp, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return sp, err
	}
	err = s.Pool.QueryRow(ctx, `INSERT INTO spaces(owner_id,name) VALUES($1,'My Space') RETURNING id,owner_id,name,color`, userID).Scan(&sp.ID, &sp.OwnerID, &sp.Name, &sp.Color)
	return sp, err
}

func (s *Store) ListSpaces(ctx context.Context, userID uuid.UUID) ([]Space, error) {
	rows, err := s.Pool.Query(ctx, `SELECT DISTINCT s.id,s.owner_id,s.name,s.color FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id WHERE s.owner_id=$1 OR m.user_id=$1 ORDER BY s.name`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Space{}
	for rows.Next() {
		var v Space
		if err := rows.Scan(&v.ID, &v.OwnerID, &v.Name, &v.Color); err != nil {
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
	err := s.Pool.QueryRow(ctx, `INSERT INTO spaces(owner_id,name) VALUES($1,$2) RETURNING id,owner_id,name,color`, userID, name).Scan(&v.ID, &v.OwnerID, &v.Name, &v.Color)
	return v, err
}

func (s *Store) CanEditSpace(ctx context.Context, userID, spaceID uuid.UUID) bool {
	var ok bool
	_ = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=$1 WHERE s.id=$2 AND (s.owner_id=$1 OR m.permission IN ('edit','manage')))`, userID, spaceID).Scan(&ok)
	return ok
}

func (s *Store) ListNotes(ctx context.Context, userID, spaceID uuid.UUID, query string) ([]Note, []Edge, error) {
	if !s.CanViewSpace(ctx, userID, spaceID) {
		return nil, nil, pgx.ErrNoRows
	}
	pattern := "%" + strings.ReplaceAll(query, "%", "\\%") + "%"
	rows, err := s.Pool.Query(ctx, `SELECT id,space_id,author_id,content,title,color,kind,source,x,y,width,height,rotation,version,created_at,updated_at FROM notes WHERE space_id=$1 AND deleted_at IS NULL AND ($2='' OR content ILIKE $3 OR title ILIKE $3) ORDER BY created_at`, spaceID, query, pattern)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	notes := []Note{}
	for rows.Next() {
		var n Note
		if err := rows.Scan(&n.ID, &n.SpaceID, &n.AuthorID, &n.Content, &n.Title, &n.Color, &n.Kind, &n.Source, &n.X, &n.Y, &n.Width, &n.Height, &n.Rotation, &n.Version, &n.CreatedAt, &n.UpdatedAt); err != nil {
			return nil, nil, err
		}
		notes = append(notes, n)
	}
	edgeRows, err := s.Pool.Query(ctx, `SELECT id,space_id,source_note_id,target_note_id,relation FROM note_edges WHERE space_id=$1`, spaceID)
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
	err := s.Pool.QueryRow(ctx, `INSERT INTO notes(space_id,author_id,content,title,color,kind,source,x,y,width,height,rotation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,space_id,author_id,content,title,color,kind,source,x,y,width,height,rotation,version,created_at,updated_at`, n.SpaceID, userID, n.Content, n.Title, n.Color, n.Kind, n.Source, n.X, n.Y, n.Width, n.Height, n.Rotation).Scan(&n.ID, &n.SpaceID, &n.AuthorID, &n.Content, &n.Title, &n.Color, &n.Kind, &n.Source, &n.X, &n.Y, &n.Width, &n.Height, &n.Rotation, &n.Version, &n.CreatedAt, &n.UpdatedAt)
	return n, err
}

func (s *Store) UpdateNote(ctx context.Context, userID uuid.UUID, n Note) (Note, error) {
	err := s.Pool.QueryRow(ctx, `UPDATE notes SET content=$3,title=$4,color=$5,kind=$6,x=$7,y=$8,width=$9,height=$10,rotation=$11,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM spaces s LEFT JOIN space_members m ON m.space_id=s.id AND m.user_id=$12 WHERE s.id=notes.space_id AND (s.owner_id=$12 OR m.permission IN ('edit','manage'))) RETURNING id,space_id,author_id,content,title,color,kind,source,x,y,width,height,rotation,version,created_at,updated_at`, n.ID, n.Version, n.Content, n.Title, n.Color, n.Kind, n.X, n.Y, n.Width, n.Height, n.Rotation, userID).Scan(&n.ID, &n.SpaceID, &n.AuthorID, &n.Content, &n.Title, &n.Color, &n.Kind, &n.Source, &n.X, &n.Y, &n.Width, &n.Height, &n.Rotation, &n.Version, &n.CreatedAt, &n.UpdatedAt)
	return n, err
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
	err := s.Pool.QueryRow(ctx, `INSERT INTO note_edges(space_id,source_note_id,target_note_id,relation,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id`, e.SpaceID, e.SourceID, e.TargetID, e.Relation, userID).Scan(&e.ID)
	return e, err
}

func (s *Store) Audit(ctx context.Context, actor *uuid.UUID, action, resourceType, resourceID string, metadata any) {
	raw, _ := json.Marshal(metadata)
	_, _ = s.Pool.Exec(ctx, `INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,$4,$5)`, actor, action, resourceType, resourceID, raw)
}
