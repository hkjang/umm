package mail

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

// relay is the least SMTP server that lets a test read what umm said to it.
type relay struct {
	listener net.Listener
	mu       sync.Mutex
	commands []string
	body     string
}

func startRelay(t *testing.T) *relay {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	r := &relay{listener: listener}
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go r.talk(connection)
		}
	}()
	t.Cleanup(func() { _ = listener.Close() })
	return r
}

func (r *relay) config() Config {
	host, port, _ := net.SplitHostPort(r.listener.Addr().String())
	number, _ := strconv.Atoi(port)
	return Config{Enabled: true, Host: host, Port: number, Security: "auto", FromAddress: "umm@example.test", FromName: "umm 알림", Timeout: 2 * time.Second, Notify: map[string]bool{}}
}

func (r *relay) talk(connection net.Conn) {
	defer connection.Close()
	reader := bufio.NewReader(connection)
	say := func(line string) { _, _ = connection.Write([]byte(line + "\r\n")) }
	say("220 relay.test ESMTP")
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		command := strings.TrimSpace(line)
		r.mu.Lock()
		r.commands = append(r.commands, command)
		r.mu.Unlock()
		switch upper := strings.ToUpper(command); {
		case strings.HasPrefix(upper, "EHLO"):
			say("250-relay.test")
			say("250 SIZE 10485760")
		case strings.HasPrefix(upper, "MAIL FROM"), strings.HasPrefix(upper, "RCPT TO"):
			say("250 OK")
		case upper == "DATA":
			say("354 go ahead")
			var body strings.Builder
			for {
				dataLine, err := reader.ReadString('\n')
				if err != nil {
					return
				}
				if strings.TrimRight(dataLine, "\r\n") == "." {
					break
				}
				body.WriteString(dataLine)
			}
			r.mu.Lock()
			r.body = body.String()
			r.mu.Unlock()
			say("250 queued")
		case upper == "QUIT":
			say("221 bye")
			return
		default:
			say("250 OK")
		}
	}
}

func (r *relay) transcript() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.commands...)
}

func (r *relay) received() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.body
}

func TestSettingsReadTheStandardKeysAndFillTheRelayDefaults(t *testing.T) {
	var settings Settings
	raw := `{"enabled":true,"smtp_host":" relay.intra ","username":"","password":"enc:xyz","notify_mention":false,"notify_unknown":true,"notify_comment":"yes"}`
	if err := json.Unmarshal([]byte(raw), &settings); err != nil {
		t.Fatal(err)
	}
	config := settings.Config("secret", "https://umm.intra/")
	if config.Host != "relay.intra" || config.Port != 25 || config.Security != "auto" || config.Timeout != 10*time.Second {
		t.Errorf("defaults = host %q port %d security %q timeout %s, want the internal-relay defaults", config.Host, config.Port, config.Security, config.Timeout)
	}
	if config.Password != "secret" {
		t.Errorf("password = %q, want the decrypted value the store handed over", config.Password)
	}
	if config.FromAddress != "umm@relay.intra" || config.FromName != "umm" {
		t.Errorf("sender = %q, want a default sender derived from the relay", config.Sender())
	}
	if config.BaseURL != "https://umm.intra" {
		t.Errorf("base URL = %q, want the public URL without its trailing slash", config.BaseURL)
	}
	if config.Allows(EventMention) {
		t.Error("notify_mention=false, yet mentions are allowed")
	}
	for _, event := range []string{EventComment, EventApprovalRequested, EventTest, "something.new"} {
		if !config.Allows(event) {
			t.Errorf("%s is silenced, want on (a missing or non-boolean switch is on)", event)
		}
	}
	if !config.Allows(EventComment) {
		t.Error("a switch that is not a boolean silenced the event")
	}

	implicit := Settings{SMTPHost: "smtp.intra", SMTPPort: 465}.Config("", "")
	if implicit.Security != "tls" {
		t.Errorf("security on 465 = %q, want tls", implicit.Security)
	}
	explicit := Settings{SMTPHost: "smtp.intra", BaseURL: "https://mail-links.intra/"}.Config("", "https://umm.intra")
	if explicit.BaseURL != "https://mail-links.intra" {
		t.Errorf("base URL = %q, want the mail row's own value to win", explicit.BaseURL)
	}
}

func TestValidateStopsTheSettingsAnAdministratorWouldRegret(t *testing.T) {
	cases := []struct {
		name     string
		settings Settings
		wantErr  bool
	}{
		{"off and empty is fine", Settings{}, false},
		{"on without a host", Settings{Enabled: true}, true},
		{"on with a host", Settings{Enabled: true, SMTPHost: "relay.intra"}, false},
		{"host with a port inside", Settings{SMTPHost: "relay.intra:25"}, true},
		{"port out of range", Settings{SMTPHost: "relay.intra", SMTPPort: 70000}, true},
		{"unknown security", Settings{SMTPHost: "relay.intra", Security: "ssl"}, true},
		{"sender without @", Settings{SMTPHost: "relay.intra", FromAddress: "umm"}, true},
		{"timeout too long", Settings{SMTPHost: "relay.intra", TimeoutSeconds: 600}, true},
		{"base URL without scheme", Settings{SMTPHost: "relay.intra", BaseURL: "umm.intra"}, true},
	}
	for _, tc := range cases {
		if err := tc.settings.Validate(); (err != nil) != tc.wantErr {
			t.Errorf("%s: err = %v, want error %v", tc.name, err, tc.wantErr)
		}
	}
}

func TestDeliverSpeaksPlainSMTPToAnInternalRelay(t *testing.T) {
	relay := startRelay(t)
	config := relay.config()
	message := Message{To: "lead@example.test", Subject: "검토 요청", Body: "첫 줄\n.점으로 시작하는 줄\n마지막"}
	if err := Deliver(context.Background(), config, message); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	transcript := strings.Join(relay.transcript(), "\n")
	if !strings.Contains(transcript, "EHLO example.test") {
		t.Errorf("transcript lacks the EHLO with the sender domain:\n%s", transcript)
	}
	if strings.Contains(transcript, "AUTH") || strings.Contains(transcript, "STARTTLS") {
		t.Errorf("no username and no STARTTLS offered, yet umm tried to negotiate:\n%s", transcript)
	}
	if !strings.Contains(transcript, "MAIL FROM:<umm@example.test>") || !strings.Contains(transcript, "RCPT TO:<lead@example.test>") {
		t.Errorf("envelope is wrong:\n%s", transcript)
	}
	body := relay.received()
	for _, want := range []string{
		"From: =?utf-8?q?umm_=EC=95=8C=EB=A6=BC?= <umm@example.test>\r\n",
		"To: lead@example.test\r\n",
		"Subject: =?utf-8?q?=EA=B2=80=ED=86=A0_=EC=9A=94=EC=B2=AD?=\r\n",
		"Auto-Submitted: auto-generated\r\n",
		"\r\n첫 줄\r\n..점으로 시작하는 줄\r\n마지막\r\n",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("message lacks %q:\n%s", want, body)
		}
	}
}

func TestDeliverRefusesWhatTheRelayWouldNotUnderstand(t *testing.T) {
	relay := startRelay(t)
	config := relay.config()
	if err := Deliver(context.Background(), config, Message{To: "not an address"}); !errors.Is(err, ErrInvalid) {
		t.Errorf("recipient without @: err = %v, want ErrInvalid", err)
	}
	config.Host = ""
	if err := Deliver(context.Background(), config, Message{To: "a@b.test"}); !errors.Is(err, ErrInvalid) {
		t.Errorf("no host: err = %v, want ErrInvalid", err)
	}
	if len(relay.transcript()) != 0 {
		t.Error("an invalid configuration reached the relay")
	}
}

// memory is an in-process store for the service tests.
type memory struct {
	config  Config
	emails  map[uuid.UUID]string
	mu      sync.Mutex
	entries map[uuid.UUID]Delivery
}

func (m *memory) MailConfig(context.Context) (Config, error) { return m.config, nil }
func (m *memory) LookupEmails(_ context.Context, ids []uuid.UUID) (map[uuid.UUID]string, error) {
	out := map[uuid.UUID]string{}
	for _, id := range ids {
		if email, ok := m.emails[id]; ok {
			out[id] = email
		}
	}
	return out, nil
}
func (m *memory) RecordMailDelivery(_ context.Context, delivery Delivery) (uuid.UUID, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delivery.ID = uuid.New()
	if m.entries == nil {
		m.entries = map[uuid.UUID]Delivery{}
	}
	m.entries[delivery.ID] = delivery
	return delivery.ID, nil
}
func (m *memory) CompleteMailDelivery(_ context.Context, id uuid.UUID, status string, attempts int, message string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry := m.entries[id]
	entry.Status, entry.Attempts, entry.ErrorMessage = status, attempts, message
	m.entries[id] = entry
	return nil
}
func (m *memory) deliveries() []Delivery {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Delivery, 0, len(m.entries))
	for _, entry := range m.entries {
		out = append(out, entry)
	}
	return out
}

type sentMail struct {
	mu   sync.Mutex
	sent []Message
}

func (s *sentMail) send(_ context.Context, _ Config, message Message) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sent = append(s.sent, message)
	return nil
}

func TestNotifySendsToEveryoneButTheActorAndOnlyWhenOn(t *testing.T) {
	actor, lead, admin, noAddress := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	store := &memory{
		config: Config{Enabled: true, Host: "relay.intra", Port: 25, Security: "auto", FromAddress: "umm@relay.intra", Timeout: time.Second, Notify: map[string]bool{}},
		emails: map[uuid.UUID]string{actor: "actor@example.test", lead: "lead@example.test", admin: "Lead@Example.test"},
	}
	outbox := &sentMail{}
	service := NewService(store, store, store, nil)
	service.SetSender(outbox.send)

	notification := ApprovalRequested("김지원", "export", "2026 개편안", "")
	service.Notify(context.Background(), notification, actor, []uuid.UUID{actor, lead, admin, noAddress, lead})
	service.Wait()
	if len(outbox.sent) != 1 || outbox.sent[0].To != "lead@example.test" {
		t.Fatalf("sent = %+v, want exactly one mail to the lead (actor dropped, duplicate address folded, no address skipped)", outbox.sent)
	}
	if !strings.Contains(outbox.sent[0].Body, "김지원 님이 외부 내보내기 검토를 요청했습니다.") {
		t.Errorf("body = %q", outbox.sent[0].Body)
	}
	if strings.Contains(outbox.sent[0].Body, "바로 열기") {
		t.Error("no base URL, yet the mail carries a link")
	}
	entries := store.deliveries()
	if len(entries) != 1 || entries[0].Status != StatusSent || entries[0].Attempts != 1 || entries[0].Recipient != "lead@example.test" {
		t.Errorf("ledger = %+v, want one sent row for the lead", entries)
	}

	// The switch for one event silences that event and nothing else.
	store.config.Notify["approval_request"] = false
	service.Notify(context.Background(), notification, actor, []uuid.UUID{lead})
	service.Notify(context.Background(), SpaceShared("김지원", "회고", "edit", uuid.New()), actor, []uuid.UUID{lead})
	service.Wait()
	if len(outbox.sent) != 2 || outbox.sent[1].Event() != EventSpaceShared {
		t.Fatalf("after silencing approval requests, sent = %d, want the space share only", len(outbox.sent))
	}

	// Off means nothing, not even a ledger row.
	store.config.Enabled = false
	service.Notify(context.Background(), SpaceShared("김지원", "회고", "edit", uuid.New()), actor, []uuid.UUID{lead})
	service.Wait()
	if len(outbox.sent) != 2 || len(store.deliveries()) != 2 {
		t.Error("mail is off, yet something was sent or recorded")
	}
}

// Event reads the event back out of a rendered subject, which is enough for
// the test above to tell the two mails apart.
func (m Message) Event() string {
	if strings.Contains(m.Subject, "공간을 공유했습니다") {
		return EventSpaceShared
	}
	return ""
}

func TestNotifyRecordsAFailureWithItsReasonAndNeverBlocks(t *testing.T) {
	actor, lead := uuid.New(), uuid.New()
	// A port nothing listens on: the relay is down.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	host, port, _ := net.SplitHostPort(listener.Addr().String())
	_ = listener.Close()
	number, _ := strconv.Atoi(port)
	store := &memory{
		config: Config{Enabled: true, Host: host, Port: number, Security: "auto", FromAddress: "umm@example.test", Timeout: 500 * time.Millisecond, Notify: map[string]bool{}},
		emails: map[uuid.UUID]string{lead: "lead@example.test"},
	}
	service := NewService(store, store, store, nil)
	started := time.Now()
	service.Notify(context.Background(), Mentioned("김지원", "회고", uuid.New(), uuid.New(), "@lead 이 부분 봐 주세요"), actor, []uuid.UUID{lead})
	if elapsed := time.Since(started); elapsed > 200*time.Millisecond {
		t.Errorf("Notify took %s with the relay down, want it to return at once", elapsed)
	}
	service.Wait()
	entries := store.deliveries()
	if len(entries) != 1 || entries[0].Status != StatusFailed || entries[0].Attempts != 2 || !strings.Contains(entries[0].ErrorMessage, "연결하지 못함") {
		t.Errorf("ledger = %+v, want one failed row after two attempts with the connection error", entries)
	}

	// On, but without a host: nothing is sent, and the ledger says why.
	store.config.Host = ""
	service.Notify(context.Background(), TestMessage(), actor, []uuid.UUID{lead})
	service.Wait()
	entries = store.deliveries()
	var incomplete *Delivery
	for index := range entries {
		if strings.Contains(entries[index].ErrorMessage, "smtp_host") {
			incomplete = &entries[index]
		}
	}
	if incomplete == nil || incomplete.Status != StatusFailed {
		t.Errorf("ledger = %+v, want a failed row naming the missing host", entries)
	}
}

func TestSendNowReportsTheOutcomeAndRecordsIt(t *testing.T) {
	relay := startRelay(t)
	store := &memory{config: relay.config()}
	store.config.Enabled = false
	store.config.BaseURL = "https://umm.intra"
	service := NewService(store, store, store, nil)
	if err := service.SendNow(context.Background(), TestMessage(), uuid.New(), "admin@example.test"); err != nil {
		t.Fatalf("send now: %v", err)
	}
	entries := store.deliveries()
	if len(entries) != 1 || entries[0].Status != StatusSent || entries[0].Event != EventTest {
		t.Errorf("ledger = %+v, want one sent test row even while notifications are off", entries)
	}
	if body := relay.received(); strings.Contains(body, "바로 열기") {
		t.Error("the test message has no link, yet one was rendered")
	}
	relay.listener.Close()
	if err := service.SendNow(context.Background(), TestMessage(), uuid.New(), "admin@example.test"); err == nil {
		t.Error("relay closed, yet SendNow reported success")
	}
}

func TestNotificationsLinkIntoUmmWhenABaseIsKnown(t *testing.T) {
	config := Config{BaseURL: "https://umm.intra"}
	space, note := uuid.New(), uuid.New()
	body := CommentPosted("박서연", "제품 회고", space, note, "여기 근거가 더 필요해요").Render(config)
	if !strings.Contains(body, "바로 열기: https://umm.intra/space/"+space.String()+"?note="+note.String()) {
		t.Errorf("comment body = %q", body)
	}
	if !strings.Contains(body, "> 여기 근거가 더 필요해요") {
		t.Errorf("comment is not quoted: %q", body)
	}
	decided := ApprovalDecided("이팀장", "space_share", "제품 회고", "rejected", "다음 분기에")
	if decided.Subject != "[umm] 검토 결과: 팀 공간 공유 · 반려" || !strings.Contains(decided.Render(config), "https://umm.intra/approvals") {
		t.Errorf("decision = %q / %q", decided.Subject, decided.Render(config))
	}
	long := strings.Repeat("가", 600)
	if quoted := quote(long); len([]rune(quoted)) > 510 {
		t.Errorf("quote did not stop at 500 characters: %d", len([]rune(quoted)))
	}
}
