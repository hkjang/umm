package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/auth"
	"github.com/hkjang/umm/internal/cryptoutil"
	"github.com/hkjang/umm/internal/mail"
	"github.com/hkjang/umm/internal/store"
)

// The mail standard walked through the real router: off by default and
// nothing sent, the password never handed back, the reviewers told and the
// requester not, the decision reaching the requester, a dead relay costing
// the request nothing, and every attempt in the ledger.

type outbox struct {
	mu   sync.Mutex
	sent []mail.Message
	fail error
}

func (o *outbox) send(_ context.Context, _ mail.Config, message mail.Message) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.fail != nil {
		return o.fail
	}
	o.sent = append(o.sent, message)
	return nil
}

func (o *outbox) recipients() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	out := []string{}
	for _, message := range o.sent {
		out = append(out, message.To)
	}
	return out
}

func (o *outbox) reset() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.sent = nil
}

func TestMailNotificationsReachThePeopleWaitingAndNobodyElseIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db := isolatedHTTPStore(t, dsn)

	var teamID uuid.UUID
	if err := db.Pool.QueryRow(ctx, `INSERT INTO teams(name) VALUES($1) RETURNING id`, "mail-team-"+uuid.NewString()).Scan(&teamID); err != nil {
		t.Fatal(err)
	}
	newUser := func(prefix, role, email string, team *uuid.UUID) uuid.UUID {
		t.Helper()
		id := uuid.New()
		username := prefix + strings.ReplaceAll(id.String(), "-", "")
		if _, err := db.Pool.Exec(ctx, `INSERT INTO users(id,username,display_name,role,email,team_id) VALUES($1,$2::citext,$3,$4,NULLIF($5,'')::citext,$6)`, id, username, prefix, role, email, team); err != nil {
			t.Fatal(err)
		}
		return id
	}
	requesterID := newUser("요청자", "user", "requester@example.test", &teamID)
	leadID := newUser("팀장", "team_lead", "lead@example.test", &teamID)
	otherLeadID := newUser("다른팀장", "team_lead", "other-lead@example.test", nil)
	adminID := newUser("관리자", "admin", "admin@example.test", nil)
	silentAdminID := newUser("메일없는관리자", "admin", "", nil)
	_ = otherLeadID
	_ = silentAdminID

	cipher, err := cryptoutil.New([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	db.Cipher = cipher
	authService := &auth.Service{Store: db}
	sent := &outbox{}
	mailer := mail.NewService(db, db, db, nil)
	mailer.SetSender(sent.send)
	server := &Server{Store: db, Auth: authService, Cipher: cipher, Mail: mailer, OIDC: &auth.OIDCService{Store: db, Cipher: cipher, Sessions: authService}}
	handler := server.router()
	cookieFor := func(userID uuid.UUID) *http.Cookie {
		t.Helper()
		session, err := authService.CreateSession(ctx, userID, auth.SessionOrigin{UserAgent: "integration-test", ClientIP: "127.0.0.1"})
		if err != nil {
			t.Fatal(err)
		}
		return &http.Cookie{Name: auth.CookieName, Value: session}
	}
	requester, lead, admin := cookieFor(requesterID), cookieFor(leadID), cookieFor(adminID)
	call := func(method, target, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, target, strings.NewReader(body))
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		if cookie != nil {
			request.AddCookie(cookie)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	settings := func() map[string]any {
		t.Helper()
		response := call(http.MethodGet, "/api/v1/admin/settings", "", admin)
		if response.Code != http.StatusOK {
			t.Fatalf("settings: %d %s", response.Code, response.Body.String())
		}
		var all map[string]map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &all); err != nil {
			t.Fatal(err)
		}
		return all["mail"]
	}
	saveMail := func(patch map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		current := settings()
		for key, value := range patch {
			current[key] = value
		}
		raw, _ := json.Marshal(current)
		return call(http.MethodPut, "/api/v1/admin/settings/mail", string(raw), admin)
	}
	ledger := func(status string) []mail.Delivery {
		t.Helper()
		response := call(http.MethodGet, "/api/v1/admin/mail/deliveries?status="+status, "", admin)
		if response.Code != http.StatusOK {
			t.Fatalf("deliveries: %d %s", response.Code, response.Body.String())
		}
		var page struct {
			Deliveries []mail.Delivery `json:"deliveries"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		return page.Deliveries
	}
	// The workflow that makes a request wait on a reviewer.
	if err := db.PutSetting(ctx, "workflow", map[string]any{"enabled": true, "actions": []string{"export", "space_share"}}, adminID); err != nil {
		t.Fatal(err)
	}
	space, err := db.CreateSpace(ctx, requesterID, "2026 개편안")
	if err != nil {
		t.Fatal(err)
	}
	requestExport := func() uuid.UUID {
		t.Helper()
		response := call(http.MethodPost, "/api/v1/approvals", `{"resourceType":"space","resourceId":"`+space.ID.String()+`","action":"export","comment":"이사회 자료로 씁니다"}`, requester)
		if response.Code != http.StatusCreated {
			t.Fatalf("approval: %d %s", response.Code, response.Body.String())
		}
		var out struct {
			ID uuid.UUID `json:"id"`
		}
		_ = json.Unmarshal(response.Body.Bytes(), &out)
		mailer.Wait()
		return out.ID
	}

	// 1. Fresh: seeded off, nothing sent, nothing recorded.
	initial := settings()
	if initial == nil || initial["enabled"] != false || initial["smtp_port"] != float64(25) || initial["security"] != "auto" {
		t.Fatalf("seeded mail row = %v, want off with the internal-relay defaults", initial)
	}
	if _, present := initial["password_configured"]; present {
		t.Error("no password saved, yet password_configured is reported")
	}
	requestExport()
	if len(sent.sent) != 0 || len(ledger("")) != 0 {
		t.Fatalf("mail is off, yet %d sent and %d recorded", len(sent.sent), len(ledger("")))
	}

	// 2. Turning it on without a relay is refused; the password never comes back.
	if response := saveMail(map[string]any{"enabled": true}); response.Code != http.StatusBadRequest {
		t.Errorf("enabled without a host: %d, want 400", response.Code)
	}
	if response := saveMail(map[string]any{"enabled": true, "smtp_host": "relay.intra", "username": "umm", "password": "hunter2", "from_address": "umm@company.test", "base_url": "https://umm.intra"}); response.Code != http.StatusOK {
		t.Fatalf("save: %d %s", response.Code, response.Body.String())
	}
	saved := settings()
	if saved["password"] != secretMask || saved["password_configured"] != true {
		t.Errorf("password after save = %v (configured %v), want the mask and configured=true", saved["password"], saved["password_configured"])
	}
	var storedRaw string
	if err := db.Pool.QueryRow(ctx, `SELECT value->>'password' FROM app_settings WHERE key='mail'`).Scan(&storedRaw); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(storedRaw, "enc:") || strings.Contains(storedRaw, "hunter2") {
		t.Errorf("stored password = %q, want ciphertext", storedRaw)
	}
	config, err := db.MailConfig(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if config.Password != "hunter2" || config.Host != "relay.intra" || !config.Enabled {
		t.Errorf("config read back = host %q enabled %v password ok %v", config.Host, config.Enabled, config.Password == "hunter2")
	}
	// A masked save keeps the stored secret.
	if response := saveMail(map[string]any{"from_name": "umm 알림"}); response.Code != http.StatusOK {
		t.Fatalf("masked save: %d %s", response.Code, response.Body.String())
	}
	if config, _ = db.MailConfig(ctx); config.Password != "hunter2" {
		t.Error("saving the section with the mask erased the password")
	}

	// 3. A request reaches the lead of that team and the administrators with an
	// address — not the requester, not another team's lead, not an
	// administrator without an address.
	requestID := requestExport()
	got := sent.recipients()
	if len(got) != 2 || !containsAddress(got, "lead@example.test") || !containsAddress(got, "admin@example.test") {
		t.Fatalf("approval request reached %v, want the team lead and the administrator only", got)
	}
	if body := sent.sent[0].Body; !strings.Contains(body, "요청자 님이 외부 내보내기 검토를 요청했습니다.") || !strings.Contains(body, "대상: 2026 개편안") || !strings.Contains(body, "> 이사회 자료로 씁니다") || !strings.Contains(body, "https://umm.intra/approvals") {
		t.Errorf("request mail body = %q", body)
	}
	if rows := ledger("sent"); len(rows) != 2 || rows[0].Event != mail.EventApprovalRequested || rows[0].Attempts != 1 || rows[0].ActorID != requesterID {
		t.Errorf("ledger = %+v, want two sent rows for the request", rows)
	}
	for _, row := range ledger("") {
		if strings.Contains(row.Subject, "이사회") || row.ErrorMessage != "" {
			t.Errorf("ledger row carries more than it should: %+v", row)
		}
	}

	// 4. The decision reaches the requester; the reviewer is not told about
	// their own decision.
	sent.reset()
	if response := call(http.MethodPost, "/api/v1/approvals/"+requestID.String()+"/decision", `{"decision":"rejected","comment":"다음 분기에"}`, lead); response.Code != http.StatusOK {
		t.Fatalf("decision: %d %s", response.Code, response.Body.String())
	}
	mailer.Wait()
	if got := sent.recipients(); len(got) != 1 || got[0] != "requester@example.test" {
		t.Fatalf("decision reached %v, want the requester only", got)
	}
	if subject, body := sent.sent[0].Subject, sent.sent[0].Body; subject != "[umm] 검토 결과: 외부 내보내기 · 반려" || !strings.Contains(body, "(검토: 팀장)") || !strings.Contains(body, "> 다음 분기에") {
		t.Errorf("decision mail = %q / %q", subject, body)
	}

	// 5. One switch silences one event and nothing else.
	sent.reset()
	if response := saveMail(map[string]any{"notify_approval_request": false}); response.Code != http.StatusOK {
		t.Fatalf("switch save: %d %s", response.Code, response.Body.String())
	}
	silenced := requestExport()
	if len(sent.sent) != 0 {
		t.Fatalf("notify_approval_request is off, yet %v were mailed", sent.recipients())
	}
	if response := call(http.MethodPost, "/api/v1/approvals/"+silenced.String()+"/decision", `{"decision":"approved"}`, admin); response.Code != http.StatusOK {
		t.Fatalf("decision: %d %s", response.Code, response.Body.String())
	}
	mailer.Wait()
	if got := sent.recipients(); len(got) != 1 || got[0] != "requester@example.test" {
		t.Errorf("with requests silenced, the decision reached %v, want the requester still", got)
	}
	if response := saveMail(map[string]any{"notify_approval_request": true}); response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}

	// 6. Sharing a space tells the person it was shared with — through the
	// workflow, both the reviewer (request) and then the target (approval).
	sent.reset()
	var leadName string
	_ = db.Pool.QueryRow(ctx, `SELECT username FROM users WHERE id=$1`, leadID).Scan(&leadName)
	if response := call(http.MethodPost, "/api/v1/spaces/"+space.ID.String()+"/members", `{"username":"`+leadName+`","permission":"edit"}`, requester); response.Code != http.StatusAccepted {
		t.Fatalf("share: %d %s", response.Code, response.Body.String())
	}
	mailer.Wait()
	if got := sent.recipients(); len(got) != 2 || !containsAddress(got, "lead@example.test") || !containsAddress(got, "admin@example.test") {
		t.Fatalf("share request reached %v, want the reviewers", got)
	}
	if subject := sent.sent[0].Subject; !strings.Contains(subject, "팀 공간 공유") {
		t.Errorf("share request subject = %q", subject)
	}
	var shareRequest uuid.UUID
	if err := db.Pool.QueryRow(ctx, `SELECT id FROM approval_requests WHERE action='space_share' AND status='pending' ORDER BY created_at DESC LIMIT 1`).Scan(&shareRequest); err != nil {
		t.Fatal(err)
	}
	sent.reset()
	if response := call(http.MethodPost, "/api/v1/approvals/"+shareRequest.String()+"/decision", `{"decision":"approved"}`, admin); response.Code != http.StatusOK {
		t.Fatalf("approve share: %d %s", response.Code, response.Body.String())
	}
	mailer.Wait()
	got = sent.recipients()
	if len(got) != 2 || !containsAddress(got, "requester@example.test") || !containsAddress(got, "lead@example.test") {
		t.Fatalf("approved share reached %v, want the requester (decision) and the lead (shared)", got)
	}
	for _, message := range sent.sent {
		if message.To == "lead@example.test" && (!strings.Contains(message.Subject, "'2026 개편안' 공간을 공유했습니다") || !strings.Contains(message.Body, "권한: 편집") || !strings.Contains(message.Body, "https://umm.intra/space/"+space.ID.String())) {
			t.Errorf("shared mail = %q / %q", message.Subject, message.Body)
		}
	}

	// 7. A comment: the person named gets the mention, the author of the
	// thought gets the comment, the commenter gets nothing.
	note, err := db.CreateNote(ctx, requesterID, store.Note{SpaceID: space.ID, AuthorID: requesterID, Content: "조직을 셋으로 나눈다"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO space_members(space_id,user_id,permission) VALUES($1,$2,'edit') ON CONFLICT DO NOTHING`, space.ID, adminID); err != nil {
		t.Fatal(err)
	}
	var adminName string
	_ = db.Pool.QueryRow(ctx, `SELECT username FROM users WHERE id=$1`, adminID).Scan(&adminName)
	sent.reset()
	if response := call(http.MethodPost, "/api/v1/notes/"+note.ID.String()+"/comments", `{"body":"@`+adminName+` 근거를 더 보태 주세요"}`, lead); response.Code != http.StatusCreated {
		t.Fatalf("comment: %d %s", response.Code, response.Body.String())
	}
	mailer.Wait()
	got = sent.recipients()
	if len(got) != 2 || !containsAddress(got, "admin@example.test") || !containsAddress(got, "requester@example.test") {
		t.Fatalf("comment reached %v, want the mentioned administrator and the thought's author", got)
	}
	for _, message := range sent.sent {
		switch message.To {
		case "admin@example.test":
			if !strings.Contains(message.Subject, "언급했습니다") || !strings.Contains(message.Body, "?note="+note.ID.String()) {
				t.Errorf("mention mail = %q / %q", message.Subject, message.Body)
			}
		case "requester@example.test":
			if !strings.Contains(message.Subject, "댓글을 남겼습니다") || !strings.Contains(message.Body, "> @"+adminName+" 근거를 더 보태 주세요") {
				t.Errorf("comment mail = %q / %q", message.Subject, message.Body)
			}
		}
	}

	// 8. The test button: what the relay said, on the caller's time, recorded.
	sent.reset()
	if response := call(http.MethodPost, "/api/v1/admin/mail/test", `{}`, admin); response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"recipient":"admin@example.test"`) {
		t.Errorf("test send: %d %s, want 200 to the administrator's own address", response.Code, response.Body.String())
	}
	if rows := ledger(""); len(rows) == 0 || rows[0].Event != mail.EventTest || rows[0].Status != mail.StatusSent {
		t.Errorf("ledger after test = %+v, want a sent test row first", rows)
	}
	sent.fail = errors.New("STARTTLS 실패: tls: handshake failure")
	if response := call(http.MethodPost, "/api/v1/admin/mail/test", `{"recipient":"ops@example.test"}`, admin); response.Code != http.StatusBadGateway || !strings.Contains(response.Body.String(), "STARTTLS") {
		t.Errorf("failed test send: %d %s, want 502 with the relay's words", response.Code, response.Body.String())
	}
	if rows := ledger("failed"); len(rows) != 1 || rows[0].Recipient != "ops@example.test" || !strings.Contains(rows[0].ErrorMessage, "STARTTLS") {
		t.Errorf("failed ledger = %+v", rows)
	}
	sent.fail = nil
	if response := call(http.MethodPost, "/api/v1/admin/mail/test", `{}`, requester); response.Code != http.StatusForbidden {
		t.Errorf("a user sending the test mail: %d, want 403", response.Code)
	}

	// 9. The relay is dead, for real: the request finishes as it always did
	// and the ledger says why the mail did not.
	mailer.SetSender(mail.Deliver)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	_ = listener.Close()
	number, _ := strconv.Atoi(port)
	if response := saveMail(map[string]any{"smtp_host": "127.0.0.1", "smtp_port": number, "timeout_seconds": 1}); response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	before := len(ledger("failed"))
	requestExport()
	failed := ledger("failed")
	if len(failed) != before+2 {
		t.Fatalf("dead relay: %d failed rows, want %d", len(failed), before+2)
	}
	if failed[0].Attempts != 2 || !strings.Contains(failed[0].ErrorMessage, "연결하지 못함") {
		t.Errorf("dead relay row = %+v, want two attempts and the connection error", failed[0])
	}
}

func containsAddress(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
