package webhook

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/cryptoutil"
	"github.com/hkjang/umm/internal/store"
)

var SupportedEvents = []string{
	"space.updated",
	"note.created", "note.updated", "note.deleted", "note.restored",
	"edge.created", "comment.created", "comment.resolved", "comment.deleted",
	"member.updated", "member.removed", "dream.accepted", "*",
}

type Event struct {
	ID         uuid.UUID `json:"id"`
	Type       string    `json:"type"`
	SpaceID    uuid.UUID `json:"spaceId"`
	ResourceID uuid.UUID `json:"resourceId,omitempty"`
	ActorID    uuid.UUID `json:"actorId"`
	Data       any       `json:"data"`
	CreatedAt  time.Time `json:"createdAt"`
}

type subscription struct {
	ID         uuid.UUID
	URL        string
	Ciphertext string
}

type queuedEvent struct {
	event          Event
	subscriptionID *uuid.UUID
}

type Service struct {
	Store  *store.Store
	Cipher *cryptoutil.Cipher
	queue  chan queuedEvent
	client *http.Client
}

func New(store *store.Store, cipher *cryptoutil.Cipher) *Service {
	service := &Service{Store: store, Cipher: cipher, queue: make(chan queuedEvent, 256)}
	transport := &http.Transport{
		// A proxy could resolve the target after our public-IP check and reopen
		// the SSRF path. Webhooks always use the guarded direct dialer instead.
		Proxy:                 nil,
		DialContext:           safeDialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          20,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 8 * time.Second,
	}
	service.client = &http.Client{Timeout: 12 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error {
		return errors.New("webhook redirects are not allowed")
	}}
	return service
}

func (s *Service) Start(ctx context.Context) {
	for range 3 {
		go s.worker(ctx)
	}
}

func (s *Service) Enqueue(event Event) bool {
	if event.ID == uuid.Nil {
		event.ID = uuid.New()
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now().UTC()
	}
	select {
	case s.queue <- queuedEvent{event: event}:
		return true
	default:
		return false
	}
}

func (s *Service) Test(ctx context.Context, subscriptionID, actorID uuid.UUID) error {
	event := Event{ID: uuid.New(), Type: "webhook.test", ActorID: actorID, Data: map[string]any{"message": "umm webhook connection test"}, CreatedAt: time.Now().UTC()}
	return s.deliverOne(ctx, subscriptionID, event)
}

func (s *Service) worker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case item := <-s.queue:
			if item.subscriptionID != nil {
				_ = s.deliverOne(ctx, *item.subscriptionID, item.event)
				continue
			}
			s.deliverEvent(ctx, item.event)
		}
	}
}

func (s *Service) deliverEvent(ctx context.Context, event Event) {
	rows, err := s.Store.Pool.Query(ctx, `
		SELECT ws.id FROM webhook_subscriptions ws
		WHERE ws.active AND ($1=ANY(ws.events) OR '*'=ANY(ws.events))
		  AND ($2::uuid IS NULL OR EXISTS(
		    SELECT 1 FROM spaces sp LEFT JOIN space_members sm ON sm.space_id=sp.id AND sm.user_id=ws.owner_id
		    WHERE sp.id=$2 AND (sp.owner_id=ws.owner_id OR sm.user_id=ws.owner_id)))`, event.Type, nullableUUID(event.SpaceID))
	if err != nil {
		return
	}
	defer rows.Close()
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return
	}
	for _, id := range ids {
		_ = s.deliverOne(ctx, id, event)
	}
}

func (s *Service) deliverOne(ctx context.Context, subscriptionID uuid.UUID, event Event) error {
	var sub subscription
	err := s.Store.Pool.QueryRow(ctx, `SELECT id,url,secret_ciphertext FROM webhook_subscriptions WHERE id=$1 AND active`, subscriptionID).Scan(&sub.ID, &sub.URL, &sub.Ciphertext)
	if err != nil {
		return err
	}
	if err = ValidateEndpoint(ctx, sub.URL); err != nil {
		s.recordFailure(ctx, sub.ID, event, 0, err)
		return err
	}
	secret, err := s.Cipher.Decrypt(sub.Ciphertext)
	if err != nil {
		s.recordFailure(ctx, sub.ID, event, 0, err)
		return err
	}
	payload, err := json.Marshal(event)
	if err != nil {
		s.recordFailure(ctx, sub.ID, event, 0, err)
		return err
	}
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	signed := timestamp + "." + string(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(signed))
	signature := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	var lastErr error
	lastStatus := 0
	for attempt := 0; attempt < 3; attempt++ {
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodPost, sub.URL, bytes.NewReader(payload))
		if requestErr != nil {
			lastErr = requestErr
			break
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("User-Agent", "umm-webhooks/0.7")
		request.Header.Set("X-Umm-Event", event.Type)
		request.Header.Set("X-Umm-Delivery", event.ID.String())
		request.Header.Set("X-Umm-Timestamp", timestamp)
		request.Header.Set("X-Umm-Signature-256", signature)
		response, responseErr := s.client.Do(request)
		if responseErr == nil {
			lastStatus = response.StatusCode
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
			response.Body.Close()
			if response.StatusCode >= 200 && response.StatusCode < 300 {
				_, _ = s.Store.Pool.Exec(ctx, `INSERT INTO webhook_deliveries(subscription_id,event_id,event_type,status,response_status,delivered_at) VALUES($1,$2,$3,'delivered',$4,now())`, sub.ID, event.ID, event.Type, response.StatusCode)
				_, _ = s.Store.Pool.Exec(ctx, `UPDATE webhook_subscriptions SET failure_count=0,last_error='',last_delivered_at=now(),updated_at=now() WHERE id=$1`, sub.ID)
				return nil
			}
			lastErr = fmt.Errorf("webhook returned HTTP %d", response.StatusCode)
			if response.StatusCode < 500 && response.StatusCode != http.StatusTooManyRequests {
				break
			}
		} else {
			lastErr = responseErr
		}
		if attempt < 2 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(attempt+1) * 250 * time.Millisecond):
			}
		}
	}
	s.recordFailure(ctx, sub.ID, event, lastStatus, lastErr)
	return lastErr
}

func (s *Service) recordFailure(ctx context.Context, subscriptionID uuid.UUID, event Event, status int, err error) {
	message := "delivery failed"
	if err != nil {
		message = err.Error()
	}
	if len(message) > 500 {
		message = message[:500]
	}
	var responseStatus any
	if status > 0 {
		responseStatus = status
	}
	_, _ = s.Store.Pool.Exec(ctx, `INSERT INTO webhook_deliveries(subscription_id,event_id,event_type,status,response_status,error) VALUES($1,$2,$3,'failed',$4,$5)`, subscriptionID, event.ID, event.Type, responseStatus, message)
	_, _ = s.Store.Pool.Exec(ctx, `UPDATE webhook_subscriptions SET failure_count=failure_count+1,last_error=$2,active=CASE WHEN failure_count+1>=10 THEN false ELSE active END,updated_at=now() WHERE id=$1`, subscriptionID, message)
}

func ValidateEvents(events []string) bool {
	if len(events) == 0 || len(events) > len(SupportedEvents) {
		return false
	}
	for _, event := range events {
		if !slices.Contains(SupportedEvents, event) {
			return false
		}
	}
	return true
}

func ValidateEndpoint(ctx context.Context, raw string) error {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.Fragment != "" {
		return errors.New("webhook URL must be an HTTPS URL without credentials or fragments")
	}
	if parsed.Port() != "" && parsed.Port() != "443" {
		return errors.New("webhook URL must use the default HTTPS port")
	}
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, parsed.Hostname())
	if err != nil || len(addresses) == 0 {
		return errors.New("webhook hostname could not be resolved")
	}
	for _, address := range addresses {
		if !publicIP(address.IP) {
			return errors.New("webhook URL resolves to a private or reserved address")
		}
	}
	return nil
}

func safeDialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	dialer := net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	for _, candidate := range addresses {
		if !publicIP(candidate.IP) {
			continue
		}
		connection, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(candidate.IP.String(), port))
		if dialErr == nil {
			return connection, nil
		}
		err = dialErr
	}
	if err == nil {
		err = errors.New("target has no public address")
	}
	return nil, err
}

func publicIP(ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	for _, network := range reservedNetworks {
		if network.Contains(ip) {
			return false
		}
	}
	return true
}

var reservedNetworks = func() []*net.IPNet {
	blocks := []string{
		"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24",
		"198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4",
		"100::/64", "2001::/23", "2001:db8::/32",
	}
	networks := make([]*net.IPNet, 0, len(blocks))
	for _, block := range blocks {
		_, network, err := net.ParseCIDR(block)
		if err != nil {
			panic(err)
		}
		networks = append(networks, network)
	}
	return networks
}()

func nullableUUID(id uuid.UUID) any {
	if id == uuid.Nil {
		return nil
	}
	return id
}
