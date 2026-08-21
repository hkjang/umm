package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type webhookOutboxEvent struct {
	ID         uuid.UUID       `json:"id"`
	Type       string          `json:"type"`
	SpaceID    uuid.UUID       `json:"spaceId"`
	ResourceID uuid.UUID       `json:"resourceId,omitempty"`
	ActorID    uuid.UUID       `json:"actorId"`
	Data       json.RawMessage `json:"data"`
	CreatedAt  time.Time       `json:"createdAt"`
}

// AppendSpaceEvent writes the collaboration log and every currently eligible
// webhook delivery into the caller's mutation transaction. Callers must not
// commit their domain change when this returns an error.
func (s *Store) AppendSpaceEvent(ctx context.Context, tx pgx.Tx, actorID, spaceID uuid.UUID, eventType string, resourceID uuid.UUID, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	var resource any = resourceID
	if resourceID == uuid.Nil {
		resource = nil
	}
	if _, err = tx.Exec(ctx, `INSERT INTO space_events(space_id,actor_id,event_type,resource_id,payload) VALUES($1,$2,$3,$4,$5)`, spaceID, actorID, eventType, resource, raw); err != nil {
		return err
	}
	event := webhookOutboxEvent{
		ID: uuid.New(), Type: eventType, SpaceID: spaceID, ResourceID: resourceID,
		ActorID: actorID, Data: raw, CreatedAt: time.Now().UTC(),
	}
	eventRaw, err := json.Marshal(event)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO webhook_deliveries(subscription_id,event_id,event_type,payload,status,next_attempt_at)
		SELECT ws.id,$2,$3,$4,'queued',now() FROM webhook_subscriptions ws
		JOIN users owner_user ON owner_user.id=ws.owner_id AND owner_user.active
		WHERE ws.active AND ($3=ANY(ws.events) OR '*'=ANY(ws.events))
		  AND EXISTS(
		    SELECT 1 FROM spaces sp LEFT JOIN space_members sm ON sm.space_id=sp.id AND sm.user_id=ws.owner_id
		    WHERE sp.id=$1 AND (sp.owner_id=ws.owner_id OR sm.user_id=ws.owner_id))
		ON CONFLICT(subscription_id,event_id) DO NOTHING`, spaceID, event.ID, eventType, json.RawMessage(eventRaw))
	return err
}
