package store

import (
	"context"
	"log/slog"
	"strings"
	"time"
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
	}
	for _, statement := range statements {
		if _, err := s.Pool.Exec(ctx, statement); err != nil {
			slog.Warn("janitor sweep failed", "error", err, "statement", statement)
		}
	}
}
