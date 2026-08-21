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

// SpaceEvent is the access-scoped collaboration record sent over SSE.
type SpaceEvent struct {
	Sequence   int64           `json:"sequence"`
	Type       string          `json:"type"`
	ResourceID *uuid.UUID      `json:"resourceId"`
	ActorID    *uuid.UUID      `json:"actorId"`
	Payload    json.RawMessage `json:"payload"`
	CreatedAt  time.Time       `json:"createdAt"`
}

// SpaceEvents reads one bounded event batch and checks membership in the same
// PostgreSQL statement. A stream therefore cannot observe an event batch from
// a snapshot in which its caller no longer has access to the space.
func (s *Store) SpaceEvents(ctx context.Context, userID, spaceID uuid.UUID, after int64, limit int) ([]SpaceEvent, bool, error) {
	if limit < 1 || limit > 100 {
		limit = 100
	}
	var allowed bool
	var raw json.RawMessage
	err := s.Pool.QueryRow(ctx, `
		WITH access AS (
		  SELECT EXISTS(
		    SELECT 1 FROM spaces sp
		    LEFT JOIN space_members sm ON sm.space_id=sp.id AND sm.user_id=$1
		    WHERE sp.id=$2 AND (sp.owner_id=$1 OR sm.user_id=$1)
		  ) AS allowed
		), pending AS (
		  SELECT e.sequence,e.event_type,e.resource_id,e.payload,e.actor_id,e.created_at
		  FROM space_events e CROSS JOIN access a
		  WHERE a.allowed AND e.space_id=$2 AND e.sequence>$3
		  ORDER BY e.sequence
		  LIMIT $4
		)
		SELECT a.allowed,COALESCE(
		  jsonb_agg(jsonb_build_object(
		    'sequence',p.sequence,'type',p.event_type,'resourceId',p.resource_id,
		    'payload',p.payload,'actorId',p.actor_id,'createdAt',p.created_at
		  ) ORDER BY p.sequence) FILTER (WHERE p.sequence IS NOT NULL),
		  '[]'::jsonb
		)
		FROM access a LEFT JOIN pending p ON true
		GROUP BY a.allowed`, userID, spaceID, after, limit).Scan(&allowed, &raw)
	if err != nil {
		return nil, false, err
	}
	events := []SpaceEvent{}
	if err = json.Unmarshal(raw, &events); err != nil {
		return nil, false, err
	}
	return events, allowed, nil
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
