package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/mail"
	"github.com/jackc/pgx/v5"
)

/*
Mail notifications: what the store lends the mail service.

Three things, and deliberately no more. The configuration, read from the same
settings row the administrator's screen writes, with the password decrypted
here and nowhere else. The one lookup from account id to address — the mail
feature keeps no list of people; it asks the users table like everything else.
And the ledger of what was sent.
*/

// mailDeliveryRetention is how long the ledger keeps a row. Long enough to
// answer "it never arrived" about last month; not a permanent record of who
// was told what.
const mailDeliveryRetention = 90 * 24 * time.Hour

// MailConfig reads the `mail` row into a ready-to-send configuration. A
// missing row is the off state, not an error: an installation that has not
// run migration 030 yet must behave exactly as before.
func (s *Store) MailConfig(ctx context.Context) (mail.Config, error) {
	var settings mail.Settings
	if err := s.GetSetting(ctx, mail.SettingKey, &settings); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return mail.Settings{}.Config("", ""), nil
		}
		return mail.Config{}, err
	}
	var general struct {
		PublicURL string `json:"public_url"`
	}
	_ = s.GetSetting(ctx, "general", &general)
	return settings.Config(s.DecryptSetting(settings.Password), general.PublicURL), nil
}

// LookupEmails is the one directory question mail asks. Deactivated accounts
// are left out: nobody who has been switched off should keep receiving.
func (s *Store) LookupEmails(ctx context.Context, ids []uuid.UUID) (map[uuid.UUID]string, error) {
	out := map[uuid.UUID]string{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.Pool.Query(ctx, `SELECT id,email::text FROM users WHERE id=ANY($1) AND active AND email IS NOT NULL AND email<>''`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var email string
		if err := rows.Scan(&id, &email); err != nil {
			return nil, err
		}
		out[id] = strings.TrimSpace(email)
	}
	return out, rows.Err()
}

// ApprovalReviewers is everyone who may decide a request from the given team:
// every administrator, and the leads of that team. It mirrors the rule
// decideApproval enforces, so the people told are the people who can act.
func (s *Store) ApprovalReviewers(ctx context.Context, teamID *uuid.UUID) ([]uuid.UUID, error) {
	rows, err := s.Pool.Query(ctx, `
		SELECT id FROM users
		WHERE active AND (role='admin' OR (role='team_lead' AND $1::uuid IS NOT NULL AND team_id=$1))
		ORDER BY id`, teamID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// RecordMailDelivery writes the queued row before the attempt is made, so a
// crash between the two leaves a row that says "queued" rather than nothing.
// Old rows are swept here because recording is the only moment the table
// grows.
func (s *Store) RecordMailDelivery(ctx context.Context, delivery mail.Delivery) (uuid.UUID, error) {
	_, _ = s.Pool.Exec(ctx, `DELETE FROM mail_deliveries WHERE created_at < now() - $1::interval`, mailDeliveryRetention)
	var id uuid.UUID
	err := s.Pool.QueryRow(ctx, `
		INSERT INTO mail_deliveries(event,recipient,subject,space_id,actor_id,status,attempts)
		VALUES($1,$2,left($3,300),$4,$5,'queued',0) RETURNING id`,
		delivery.Event, delivery.Recipient, delivery.Subject, nullableUUID(delivery.SpaceID), nullableUUID(delivery.ActorID)).Scan(&id)
	return id, err
}

// CompleteMailDelivery records the outcome. The error message is cut so a
// verbose relay cannot fill the table, and it never carries the body.
func (s *Store) CompleteMailDelivery(ctx context.Context, id uuid.UUID, status string, attempts int, errorMessage string) error {
	_, err := s.Pool.Exec(ctx, `UPDATE mail_deliveries SET status=$2,attempts=GREATEST(attempts,$3),error_message=left($4,1000),updated_at=now() WHERE id=$1`,
		id, status, attempts, errorMessage)
	return err
}

// MailDeliveryPage is what the administrator's screen shows: the newest rows,
// and a count by status over everything kept.
type MailDeliveryPage struct {
	Deliveries []mail.Delivery `json:"deliveries"`
	Total      int             `json:"total"`
	ByStatus   map[string]int  `json:"byStatus"`
}

// ListMailDeliveries lists what was sent, newest first, optionally one status.
func (s *Store) ListMailDeliveries(ctx context.Context, status string, limit int) (MailDeliveryPage, error) {
	if limit < 1 || limit > 200 {
		limit = 50
	}
	page := MailDeliveryPage{Deliveries: []mail.Delivery{}, ByStatus: map[string]int{}}
	query := `SELECT id,event,recipient,subject,COALESCE(space_id,'00000000-0000-0000-0000-000000000000'),COALESCE(actor_id,'00000000-0000-0000-0000-000000000000'),status,attempts,error_message,created_at,updated_at FROM mail_deliveries`
	args := []any{limit}
	if status = strings.TrimSpace(status); status != "" {
		query += ` WHERE status=$2`
		args = append(args, status)
	}
	rows, err := s.Pool.Query(ctx, query+` ORDER BY created_at DESC,id DESC LIMIT $1`, args...)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		var item mail.Delivery
		if err := rows.Scan(&item.ID, &item.Event, &item.Recipient, &item.Subject, &item.SpaceID, &item.ActorID, &item.Status, &item.Attempts, &item.ErrorMessage, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return page, err
		}
		page.Deliveries = append(page.Deliveries, item)
	}
	if err := rows.Err(); err != nil {
		return page, err
	}
	counts, err := s.Pool.Query(ctx, `SELECT status,count(*) FROM mail_deliveries GROUP BY 1`)
	if err != nil {
		return page, err
	}
	defer counts.Close()
	for counts.Next() {
		var key string
		var count int
		if err := counts.Scan(&key, &count); err != nil {
			return page, err
		}
		page.ByStatus[key] = count
		page.Total += count
	}
	return page, counts.Err()
}

func nullableUUID(id uuid.UUID) any {
	if id == uuid.Nil {
		return nil
	}
	return id
}
