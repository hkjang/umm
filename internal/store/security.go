package store

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
)

// LoginIdentities returns the throttle keys a login attempt counts against.
//
// The per-address key stops credential stuffing from one source at the
// configured threshold. The per-account key is deliberately looser (see
// usernameFailureMultiplier) because an attacker who knows a username could
// otherwise lock a colleague out on demand.
func LoginIdentities(username, clientIP string) []string {
	identities := []string{}
	if ip := strings.TrimSpace(clientIP); ip != "" {
		identities = append(identities, "ip:"+ip)
	}
	if name := strings.ToLower(strings.TrimSpace(username)); name != "" {
		identities = append(identities, "user:"+name)
	}
	return identities
}

// usernameFailureMultiplier raises the per-account threshold above the
// per-address one so account lockout cannot be weaponised as a denial of
// service against a known user.
const usernameFailureMultiplier = 3

// NormalizeAIDailyLimit applies the same guardrails to callers in the HTTP and
// background-worker paths. Zero deliberately disables the daily limit.
func NormalizeAIDailyLimit(limit int) int {
	if limit < 0 || limit > 100000 {
		return 80
	}
	return limit
}

func failureBudget(identity string, maxFailures int) int {
	if strings.HasPrefix(identity, "user:") {
		return maxFailures * usernameFailureMultiplier
	}
	return maxFailures
}

// LoginLocked reports the remaining lockout for a set of identities. A database
// error is reported as unlocked: an unavailable throttle table must never lock
// everyone out of the service.
func (s *Store) LoginLocked(ctx context.Context, identities []string) (bool, time.Duration) {
	if len(identities) == 0 {
		return false, 0
	}
	var until *time.Time
	err := s.Pool.QueryRow(ctx, `SELECT max(locked_until) FROM login_attempts WHERE identity=ANY($1) AND locked_until>now()`, identities).Scan(&until)
	if err != nil || until == nil {
		return false, 0
	}
	remaining := time.Until(*until)
	if remaining <= 0 {
		return false, 0
	}
	return true, remaining
}

// RegisterLoginFailure records one failed attempt and locks the identity once it
// crosses its budget. Counting happens in the database so every instance of a
// horizontally scaled deployment shares the same view.
func (s *Store) RegisterLoginFailure(ctx context.Context, identities []string, maxFailures int, lockout time.Duration) {
	if maxFailures < 1 || lockout <= 0 {
		return
	}
	for _, identity := range identities {
		budget := failureBudget(identity, maxFailures)
		_, err := s.Pool.Exec(ctx, `
			INSERT INTO login_attempts(identity,failure_count,first_failed_at,last_failed_at)
			VALUES($1,1,now(),now())
			ON CONFLICT(identity) DO UPDATE SET
			  -- A window that has gone quiet starts over rather than accumulating
			  -- unrelated typos into a lockout hours later.
			  failure_count = CASE WHEN login_attempts.last_failed_at < now()-$3::interval THEN 1
			                       ELSE login_attempts.failure_count+1 END,
			  first_failed_at = CASE WHEN login_attempts.last_failed_at < now()-$3::interval THEN now()
			                         ELSE login_attempts.first_failed_at END,
			  last_failed_at = now(),
			  locked_until = CASE WHEN (CASE WHEN login_attempts.last_failed_at < now()-$3::interval THEN 1
			                                 ELSE login_attempts.failure_count+1 END) >= $2 THEN now()+$3::interval
			                      ELSE login_attempts.locked_until END`,
			identity, budget, lockout)
		if err != nil {
			slog.Warn("login throttle update failed", "error", err)
		}
	}
}

// ClearLoginFailures resets the counters after a successful authentication.
func (s *Store) ClearLoginFailures(ctx context.Context, identities []string) {
	if len(identities) == 0 {
		return
	}
	_, _ = s.Pool.Exec(ctx, `DELETE FROM login_attempts WHERE identity=ANY($1)`, identities)
}

// aiQuotaReservationTTL bounds an abandoned claim between reservation and
// durable consumption. A consumed claim is extended to the full 24-hour window
// before the gateway can spend tokens.
const aiQuotaReservationTTL = 35 * time.Minute

// AIDailyLimit reads the shared policy used by both interactive and scheduled
// AI generation.
func (s *Store) AIDailyLimit(ctx context.Context) (int, error) {
	var policy struct {
		Limit int `json:"ai_daily_limit"`
	}
	if err := s.GetSetting(ctx, "security", &policy); err != nil {
		return 0, err
	}
	return NormalizeAIDailyLimit(policy.Limit), nil
}

// ReserveAIDailyQuota atomically claims one AI request slot for a user. The
// per-user advisory lock is shared by every application instance, closing the
// count-then-act race that could otherwise overspend the configured daily cap.
func (s *Store) ReserveAIDailyQuota(ctx context.Context, userID uuid.UUID, limit int) (uuid.UUID, int, bool, error) {
	if limit <= 0 {
		return uuid.Nil, 0, true, nil
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return uuid.Nil, 0, false, fmt.Errorf("begin AI quota reservation: %w", err)
	}
	defer tx.Rollback(context.Background())

	lockKey := "umm:ai-daily:" + userID.String()
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, lockKey); err != nil {
		return uuid.Nil, 0, false, fmt.Errorf("lock AI quota: %w", err)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM ai_quota_reservations WHERE user_id=$1 AND expires_at<=now()`, userID); err != nil {
		return uuid.Nil, 0, false, fmt.Errorf("expire AI quota reservations: %w", err)
	}

	var used int
	err = tx.QueryRow(ctx, `SELECT count(*) FROM ai_quota_reservations WHERE user_id=$1 AND expires_at>now()`, userID).Scan(&used)
	if err != nil {
		return uuid.Nil, 0, false, fmt.Errorf("count AI quota usage: %w", err)
	}
	if used >= limit {
		if err = tx.Commit(ctx); err != nil {
			return uuid.Nil, used, false, fmt.Errorf("commit AI quota check: %w", err)
		}
		return uuid.Nil, used, false, nil
	}

	reservationID := uuid.New()
	if _, err = tx.Exec(ctx, `
		INSERT INTO ai_quota_reservations(id,user_id,expires_at)
		VALUES($1,$2,now()+($3 * interval '1 second'))`,
		reservationID, userID, int(aiQuotaReservationTTL/time.Second)); err != nil {
		return uuid.Nil, used, false, fmt.Errorf("insert AI quota reservation: %w", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return uuid.Nil, used, false, fmt.Errorf("commit AI quota reservation: %w", err)
	}
	return reservationID, used + 1, true, nil
}

// ConsumeAIDailyQuota converts a pending claim into the durable 24-hour usage
// record before an external gateway can spend tokens. Enforcement therefore
// does not depend on the best-effort ai_calls observability log.
func (s *Store) ConsumeAIDailyQuota(ctx context.Context, reservationID uuid.UUID) error {
	if reservationID == uuid.Nil {
		return nil
	}
	command, err := s.Pool.Exec(ctx, `
		UPDATE ai_quota_reservations
		SET consumed_at=COALESCE(consumed_at,now()),
		    expires_at=CASE WHEN consumed_at IS NULL THEN now()+interval '24 hours' ELSE expires_at END
		WHERE id=$1 AND expires_at>now()`, reservationID)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return errors.New("AI quota reservation is missing or expired")
	}
	return nil
}

// ReleaseAIDailyQuota removes a claim when generation is abandoned before the
// gateway is contacted. Consumed claims are never released by this method.
func (s *Store) ReleaseAIDailyQuota(ctx context.Context, reservationID uuid.UUID) error {
	if reservationID == uuid.Nil {
		return nil
	}
	_, err := s.Pool.Exec(ctx, `DELETE FROM ai_quota_reservations WHERE id=$1 AND consumed_at IS NULL`, reservationID)
	return err
}

// StartJanitor removes rows whose lifetime has expired. Before v0.8.0 expired
// sessions and OAuth states were never deleted, so both tables grew for the life
// of the deployment.
func (s *Store) StartJanitor(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(15 * time.Minute)
		defer ticker.Stop()
		s.Sweep(ctx)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.Sweep(ctx)
			}
		}
	}()
}

// Sweep deletes expired rows once. It is safe to run concurrently on every
// instance of a horizontally scaled deployment.
func (s *Store) Sweep(ctx context.Context) {
	statements := []string{
		`DELETE FROM sessions WHERE expires_at<now()-interval '1 day'`,
		`DELETE FROM oauth_states WHERE expires_at<now()`,
		`DELETE FROM idempotency_records WHERE expires_at<=now()`,
		`DELETE FROM login_attempts WHERE last_failed_at<now()-interval '1 day' AND (locked_until IS NULL OR locked_until<now())`,
		`DELETE FROM ai_quota_reservations WHERE expires_at<=now()`,
	}
	for _, statement := range statements {
		if _, err := s.Pool.Exec(ctx, statement); err != nil {
			slog.Warn("janitor sweep failed", "error", err, "statement", statement)
		}
	}
}
