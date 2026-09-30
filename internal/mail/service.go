package mail

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Source is where the service reads its configuration: the settings row,
// with the password already decrypted and the public URL filled in.
type Source interface {
	MailConfig(ctx context.Context) (Config, error)
}

// Directory turns account ids into addresses. umm already knows its users;
// the mail feature borrows that one lookup and keeps no list of its own.
type Directory interface {
	LookupEmails(ctx context.Context, ids []uuid.UUID) (map[uuid.UUID]string, error)
}

// Ledger keeps what left the building. One row per attempt, no body.
type Ledger interface {
	RecordMailDelivery(ctx context.Context, delivery Delivery) (uuid.UUID, error)
	CompleteMailDelivery(ctx context.Context, id uuid.UUID, status string, attempts int, errorMessage string) error
}

// Delivery is one mail to one address, as the ledger keeps it.
type Delivery struct {
	ID           uuid.UUID `json:"id"`
	Event        string    `json:"event"`
	Recipient    string    `json:"recipient"`
	Subject      string    `json:"subject"`
	SpaceID      uuid.UUID `json:"spaceId,omitempty"`
	ActorID      uuid.UUID `json:"actorId,omitempty"`
	Status       string    `json:"status"`
	Attempts     int       `json:"attempts"`
	ErrorMessage string    `json:"errorMessage,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

const (
	StatusQueued = "queued"
	StatusSent   = "sent"
	StatusFailed = "failed"
)

// Service sends notifications without ever making a request wait for the
// relay.
type Service struct {
	source    Source
	directory Directory
	ledger    Ledger
	logger    *slog.Logger
	send      func(context.Context, Config, Message) error
	inflight  sync.WaitGroup
}

func NewService(source Source, directory Directory, ledger Ledger, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{source: source, directory: directory, ledger: ledger, logger: logger, send: Deliver}
}

// SetSender swaps the transport so tests can drive the service without a
// relay.
func (s *Service) SetSender(send func(context.Context, Config, Message) error) { s.send = send }

// Wait blocks until every background delivery has finished. Tests need it;
// shutdown may use it.
func (s *Service) Wait() { s.inflight.Wait() }

// Notify resolves the recipients and sends in the background. The actor is
// dropped from the recipients — nobody is told about their own action — and
// a recipient without an address is skipped without a record, because there
// was nothing to attempt. Nothing about this is reported to the caller: a
// relay problem is the administrator's to see in the ledger, not the user's
// to see on a comment.
func (s *Service) Notify(ctx context.Context, notification Notification, actor uuid.UUID, recipients []uuid.UUID) {
	if s == nil || len(recipients) == 0 {
		return
	}
	config, err := s.source.MailConfig(ctx)
	if err != nil {
		s.logger.Warn("mail settings were not read", "error", err)
		return
	}
	if !config.Enabled || !config.Allows(notification.Event) {
		return
	}
	addresses := s.resolve(ctx, recipients, actor)
	if len(addresses) == 0 {
		return
	}
	body := notification.Render(config)
	for _, address := range addresses {
		id := s.record(ctx, Delivery{Event: notification.Event, Recipient: address, Subject: notification.Subject, SpaceID: notification.SpaceID, ActorID: actor})
		s.inflight.Add(1)
		go func(address string) {
			defer s.inflight.Done()
			s.deliver(id, config, Message{To: address, Subject: notification.Subject, Body: body})
		}(address)
	}
}

// SendNow sends one mail on the caller's time and reports the outcome. This
// is the administrator's test button, where waiting for the answer is the
// point. It does not check the enabled switch: proving the relay before
// turning notifications on is the right order, and this is how it is done.
func (s *Service) SendNow(ctx context.Context, notification Notification, actor uuid.UUID, recipient string) error {
	config, err := s.source.MailConfig(ctx)
	if err != nil {
		return err
	}
	recipient = strings.TrimSpace(recipient)
	id := s.record(ctx, Delivery{Event: notification.Event, Recipient: recipient, Subject: notification.Subject, ActorID: actor})
	sendCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), config.Timeout+5*time.Second)
	defer cancel()
	err = s.send(sendCtx, config, Message{To: recipient, Subject: notification.Subject, Body: notification.Render(config)})
	s.complete(sendCtx, id, 1, err)
	return err
}

// deliver tries twice with a short pause. A relay that refuses one connection
// and accepts the next is ordinary; losing the notification over it is not.
func (s *Service) deliver(id uuid.UUID, config Config, message Message) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*config.Timeout+15*time.Second)
	defer cancel()
	var err error
	attempts := 0
	for attempts < 2 {
		attempts++
		if err = s.send(ctx, config, message); err == nil {
			break
		}
		if attempts == 1 {
			select {
			case <-ctx.Done():
			case <-time.After(2 * time.Second):
			}
		}
	}
	s.complete(ctx, id, attempts, err)
}

func (s *Service) record(ctx context.Context, delivery Delivery) uuid.UUID {
	delivery.Status = StatusQueued
	id, err := s.ledger.RecordMailDelivery(ctx, delivery)
	if err != nil {
		s.logger.Warn("mail delivery was not recorded", "event", delivery.Event, "error", err)
	}
	return id
}

func (s *Service) complete(ctx context.Context, id uuid.UUID, attempts int, cause error) {
	status, message := StatusSent, ""
	if cause != nil {
		status, message = StatusFailed, cause.Error()
		s.logger.Warn("notification mail failed", "delivery", id, "error", cause)
	}
	if id == uuid.Nil {
		return
	}
	if err := s.ledger.CompleteMailDelivery(ctx, id, status, attempts, message); err != nil {
		s.logger.Warn("mail delivery outcome was not recorded", "delivery", id, "error", err)
	}
}

// resolve turns account ids into distinct addresses, without the actor.
func (s *Service) resolve(ctx context.Context, recipients []uuid.UUID, actor uuid.UUID) []string {
	wanted := make([]uuid.UUID, 0, len(recipients))
	seen := map[uuid.UUID]bool{}
	for _, id := range recipients {
		if id == uuid.Nil || id == actor || seen[id] {
			continue
		}
		seen[id] = true
		wanted = append(wanted, id)
	}
	if len(wanted) == 0 {
		return nil
	}
	emails, err := s.directory.LookupEmails(ctx, wanted)
	if err != nil {
		s.logger.Warn("mail recipients were not resolved", "error", err)
		return nil
	}
	addresses := make([]string, 0, len(wanted))
	taken := map[string]bool{}
	for _, id := range wanted {
		address := strings.TrimSpace(emails[id])
		if !looksLikeAddress(address) {
			continue
		}
		if key := strings.ToLower(address); !taken[key] {
			taken[key] = true
			addresses = append(addresses, address)
		}
	}
	return addresses
}
