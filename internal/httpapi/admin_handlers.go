package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/dream"
	"github.com/hkjang/umm/internal/intelligence"
	"github.com/hkjang/umm/internal/store"
)

const secretMask = "••••••••"

func (s *Server) adminSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := s.Store.AllSettings(r.Context())
	if err != nil {
		writeError(w, 500, "설정을 불러오지 못했습니다.")
		return
	}
	out := map[string]any{}
	for key, raw := range settings {
		var value map[string]any
		if json.Unmarshal(raw, &value) != nil {
			continue
		}
		for _, field := range secretFields(key) {
			if secret, ok := value[field].(string); ok && secret != "" {
				value[field] = secretMask
				value[field+"_configured"] = true
			}
		}
		out[key] = value
	}
	writeJSON(w, 200, out)
}

func (s *Server) putAdminSetting(w http.ResponseWriter, r *http.Request) {
	section := chiParam(r, "section")
	// The store owns this list. Keeping a second copy here meant a new section
	// had to be added in two places, and forgetting one produced a 404 that looks
	// like the section does not exist rather than like a missed edit.
	if !store.AllowedSetting(section) {
		writeError(w, 404, "알 수 없는 설정 영역입니다.")
		return
	}
	var incoming map[string]any
	if decodeJSON(w, r, &incoming) != nil {
		writeError(w, 400, "설정 형식이 올바르지 않습니다.")
		return
	}
	if err := s.validateSetting(section, incoming); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	for _, field := range secretFields(section) {
		raw, _ := incoming[field].(string)
		if raw == "" || raw == secretMask {
			// Omit a masked secret so Store.PutSetting can merge the latest
			// ciphertext while holding the same lock as master-key rotation.
			delete(incoming, field)
		} else {
			encrypted, err := s.Cipher.Encrypt(raw)
			if err != nil {
				writeError(w, 500, "비밀 값을 암호화하지 못했습니다.")
				return
			}
			incoming[field] = "enc:" + encrypted
		}
		delete(incoming, field+"_configured")
	}
	p := principal(r)
	if err := s.Store.PutSetting(r.Context(), section, incoming, p.User.ID); err != nil {
		writeError(w, 500, "설정을 저장하지 못했습니다.")
		return
	}
	// Cached settings must not outlive the change that an administrator just
	// confirmed, so the derived caches are dropped immediately.
	if section == "ai_gateway" {
		s.Store.InvalidateEmbeddingProvider()
	}
	if section == "security" {
		s.invalidateSecurityPolicy()
	}
	if section == "intelligence" {
		s.Store.InvalidateIntelligenceSettings()
	}
	s.Store.Audit(r.Context(), &p.User.ID, "settings.update", "settings", section, map[string]any{})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// secretFields names every value in a section that must be masked when read and
// encrypted when written.
//
// One list, used by both the read and the write path. They used to name their
// fields separately, so adding a second secret to a section meant remembering
// two places — and forgetting the read side would return a key in plain text.
func secretFields(section string) []string {
	switch section {
	case "oidc":
		return []string{"client_secret"}
	case "ai_gateway":
		return []string{"api_key", "embedding_api_key"}
	}
	return nil
}

func (s *Server) validateSetting(section string, v map[string]any) error {
	switch section {
	case "general":
		raw := strings.TrimSpace(fmt.Sprint(v["public_url"]))
		u, err := url.Parse(raw)
		if err != nil || !(u.Scheme == "http" || u.Scheme == "https") || u.Host == "" {
			return errors.New("서비스 공개 URL은 http(s) 전체 주소여야 합니다")
		}
		if strings.TrimSpace(fmt.Sprint(v["service_name"])) == "" {
			return errors.New("서비스 이름이 필요합니다")
		}
		if zone := strings.TrimSpace(fmt.Sprint(v["timezone"])); zone == "" {
			return errors.New("서비스 시간대가 필요합니다")
		} else if _, err := time.LoadLocation(zone); err != nil {
			return errors.New("IANA 형식의 올바른 서비스 시간대가 필요합니다")
		}
	case "oidc":
		if enabled, _ := v["enabled"].(bool); enabled {
			raw := strings.TrimSpace(fmt.Sprint(v["issuer_url"]))
			u, err := url.Parse(raw)
			if err != nil || !(u.Scheme == "http" || u.Scheme == "https") || u.Host == "" {
				return errors.New("Keycloak Issuer URL이 올바르지 않습니다")
			}
			if strings.TrimSpace(fmt.Sprint(v["client_id"])) == "" {
				return errors.New("OIDC Client ID가 필요합니다")
			}
		}
	case "intelligence":
		// Clamping a bad value would hide the mistake: an administrator who typed
		// 40 into a standard-deviation field needs to be told it is not one,
		// rather than have umm quietly use 1.1 and behave unlike the screen says.
		for _, field := range []struct {
			key      string
			low, max float64
			unit     string
		}{
			{"related_band", 0, 4, "표준편차"},
			{"cluster_band", 0, 4, "표준편차"},
			{"strong_band", 0, 4, "표준편차"},
			{"autolink_band", 0, 4, "표준편차"},
			{"semantic_accuracy_bar", 0, 1, "0~1 비율"},
			{"semantic_purity_bar", 0, 1, "0~1 비율"},
			{"autolink_max_per_run", 1, 100, "개"},
			{"autolink_min_notes", 3, 1000, "개"},
			{"quality_cache_minutes", 1, 1440, "분"},
		} {
			raw, present := v[field.key]
			if !present {
				continue
			}
			number, ok := raw.(float64)
			if !ok || math.IsNaN(number) || number < field.low || number > field.max {
				return fmt.Errorf("%s은(는) %g~%g %s 범위여야 합니다", field.key, field.low, field.max, field.unit)
			}
		}
	case "security":
		scopes, ok := v["api_key_scopes"].([]any)
		if !ok || len(scopes) == 0 {
			return errors.New("하나 이상의 API 키 권한이 필요합니다")
		}
		// The abuse guards are optional in the payload so an older client can
		// still save this section, but a value that is present must be sane:
		// silently clamping one would hide a misconfiguration from the operator.
		for _, guard := range []struct {
			key     string
			low     float64
			high    float64
			message string
		}{
			{key: "login_max_failures", low: 3, high: 100, message: "로그인 실패 허용 횟수는 3~100회여야 합니다"},
			{key: "login_lockout_minutes", low: 1, high: 1440, message: "로그인 잠금 시간은 1~1440분이어야 합니다"},
			{key: "api_rate_per_minute", low: 30, high: 100000, message: "분당 API 요청 한도는 30~100000이어야 합니다"},
			{key: "ai_rate_per_minute", low: 1, high: 600, message: "분당 AI 요청 한도는 1~600이어야 합니다"},
			{key: "ai_daily_limit", low: 0, high: 100000, message: "하루 AI 생성 한도는 0~100000이어야 합니다"},
		} {
			raw, present := v[guard.key]
			if !present {
				continue
			}
			value, ok := raw.(float64)
			if !ok || math.Trunc(value) != value || value < guard.low || value > guard.high {
				return errors.New(guard.message)
			}
		}
	case "workflow":
		actions, ok := v["actions"].([]any)
		if !ok {
			return errors.New("검토 작업 목록이 올바르지 않습니다")
		}
		for _, action := range actions {
			if !slices.Contains([]string{"space_share", "export"}, fmt.Sprint(action)) {
				return errors.New("지원하지 않는 검토 작업입니다")
			}
		}
	case "dream":
		threshold, ok := v["quality_threshold"].(float64)
		if !ok || threshold < 0 || threshold > 1 {
			return errors.New("Dream 품질 기준은 0~1이어야 합니다")
		}
		schedule := fmt.Sprint(v["schedule"])
		if _, err := time.Parse("15:04", schedule); err != nil {
			return errors.New("Dream 생성 시간은 HH:MM 형식이어야 합니다")
		}
		frequency := fmt.Sprint(v["frequency"])
		if !slices.Contains([]string{"daily", "weekdays", "weekends", "custom", "interval"}, frequency) {
			return errors.New("Dream 생성 주기가 올바르지 않습니다")
		}
		if frequency == "custom" {
			days, ok := v["custom_days"].([]any)
			if !ok || len(days) == 0 {
				return errors.New("Dream 생성 요일을 하나 이상 선택해 주세요")
			}
			for _, day := range days {
				n, ok := day.(float64)
				if !ok || n < 1 || n > 7 {
					return errors.New("Dream 생성 요일이 올바르지 않습니다")
				}
			}
		}
		if frequency == "interval" {
			days, ok := v["interval_days"].(float64)
			if !ok || days < 2 || days > 365 {
				return errors.New("Dream N일 간격은 2~365일이어야 합니다")
			}
		}
		tokenLimit, ok := v["token_limit"].(float64)
		if !ok || math.Trunc(tokenLimit) != tokenLimit || tokenLimit < dream.MinTokenLimit || tokenLimit > dream.MaxTokenLimit {
			return fmt.Errorf("AI 응답 Token Limit은 %d~%s 사이의 정수여야 합니다", dream.MinTokenLimit, "262,144")
		}
	case "ai_gateway":
		raw := strings.TrimSpace(fmt.Sprint(v["base_url"]))
		if raw != "" {
			u, err := url.Parse(raw)
			if err != nil || !(u.Scheme == "http" || u.Scheme == "https") || u.Host == "" {
				return errors.New("AI Gateway URL이 올바르지 않습니다")
			}
		}
		embedURL := strings.TrimSpace(fmt.Sprint(v["embedding_base_url"]))
		if embedURL == "<nil>" {
			embedURL = ""
		}
		if embedURL != "" {
			// Refused rather than ignored. A malformed address here would leave
			// embeddings quietly falling back to the offline algorithm, and the
			// person who typed it would be looking at a saved setting that does
			// nothing.
			u, err := url.Parse(embedURL)
			if err != nil || !(u.Scheme == "http" || u.Scheme == "https") || u.Host == "" {
				return errors.New("임베딩 Gateway URL이 올바르지 않습니다")
			}
		}
		retention, ok := v["log_retention_days"].(float64)
		if !ok || retention < 1 || retention > 3650 {
			return errors.New("AI 로그 보존 기간은 1~3650일이어야 합니다")
		}
		timeout, ok := v["timeout_seconds"].(float64)
		if !ok || math.Trunc(timeout) != timeout || timeout < dream.MinGatewayTimeoutSeconds || timeout > dream.MaxGatewayTimeoutSeconds {
			return fmt.Errorf("AI Gateway Timeout은 %d~%d초 사이의 정수여야 합니다", dream.MinGatewayTimeoutSeconds, dream.MaxGatewayTimeoutSeconds)
		}
		retries, ok := v["max_retries"].(float64)
		if !ok || math.Trunc(retries) != retries || retries < 0 || retries > dream.MaxGatewayRetries {
			return fmt.Errorf("AI Gateway 재시도는 0~%d 사이의 정수여야 합니다", dream.MaxGatewayRetries)
		}
		if model := strings.TrimSpace(fmt.Sprint(v["embedding_model"])); model != "" && model != "<nil>" {
			if raw == "" && embedURL == "" {
				return errors.New("임베딩 모델을 사용하려면 AI Gateway 주소 또는 임베딩 Gateway 주소가 필요합니다")
			}
			if len(model) > 200 {
				return errors.New("임베딩 모델 이름은 200자 이내여야 합니다")
			}
		}
	}
	return nil
}

func chiParam(r *http.Request, key string) string { return strings.TrimSpace(chi.URLParam(r, key)) }

func (s *Server) testOIDC(w http.ResponseWriter, r *http.Request) {
	if err := s.OIDC.Test(r.Context()); err != nil {
		writeError(w, 400, "OIDC 연결 실패: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "message": "Keycloak Discovery와 클라이언트 설정을 확인했습니다."})
}

func (s *Server) adminUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := s.Store.Pool.Query(r.Context(), `SELECT u.id,u.username,u.display_name,COALESCE(u.email,''),u.role,u.team_id,u.active,COALESCE(t.name,''),u.created_at FROM users u LEFT JOIN teams t ON t.id=u.team_id ORDER BY u.created_at`)
	if err != nil {
		writeError(w, 500, "사용자 목록을 불러오지 못했습니다.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id uuid.UUID
		var username, display, email, role, teamName string
		var teamID *uuid.UUID
		var active bool
		var created time.Time
		if err := rows.Scan(&id, &username, &display, &email, &role, &teamID, &active, &teamName, &created); err != nil {
			writeError(w, 500, "사용자 목록을 읽지 못했습니다.")
			return
		}
		out = append(out, map[string]any{"id": id, "username": username, "displayName": display, "email": email, "role": role, "teamId": teamID, "teamName": teamName, "active": active, "createdAt": created})
	}
	writeJSON(w, 200, map[string]any{"users": out})
}

func (s *Server) updateUser(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r, "userID")
	if !ok {
		return
	}
	var body struct {
		Role     string `json:"role"`
		Active   bool   `json:"active"`
		TeamName string `json:"teamName"`
	}
	if decodeJSON(w, r, &body) != nil {
		writeError(w, 400, "사용자 설정 형식이 올바르지 않습니다.")
		return
	}
	if !slices.Contains([]string{"user", "team_lead", "admin"}, body.Role) {
		writeError(w, 400, "역할이 올바르지 않습니다.")
		return
	}
	p := principal(r)
	if id == p.User.ID && (!body.Active || body.Role != "admin") {
		writeError(w, 400, "현재 관리자 계정의 관리자 권한을 제거할 수 없습니다.")
		return
	}
	var teamID *uuid.UUID
	if strings.TrimSpace(body.TeamName) != "" {
		var t uuid.UUID
		if err := s.Store.Pool.QueryRow(r.Context(), `INSERT INTO teams(name) VALUES($1) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, strings.TrimSpace(body.TeamName)).Scan(&t); err != nil {
			writeError(w, 500, "팀을 저장하지 못했습니다.")
			return
		}
		teamID = &t
	}
	cmd, err := s.Store.Pool.Exec(r.Context(), `UPDATE users SET role=$2,active=$3,team_id=$4,updated_at=now() WHERE id=$1`, id, body.Role, body.Active, teamID)
	if err != nil || cmd.RowsAffected() == 0 {
		writeError(w, 404, "사용자를 찾을 수 없습니다.")
		return
	}
	s.Store.Audit(r.Context(), &p.User.ID, "user.update", "user", id.String(), map[string]any{"role": body.Role, "active": body.Active})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) adminMetrics(w http.ResponseWriter, r *http.Request) {
	var users, active, notes, spaces, pending, comments, onboarded, webhookFailures int64
	err := s.Store.Pool.QueryRow(r.Context(), `SELECT (SELECT count(*) FROM users),(SELECT count(*) FROM users WHERE active),(SELECT count(*) FROM notes WHERE deleted_at IS NULL),(SELECT count(*) FROM spaces),(SELECT count(*) FROM approval_requests WHERE status='pending'),(SELECT count(*) FROM note_comments WHERE deleted_at IS NULL),(SELECT count(*) FROM user_preferences WHERE onboarding_completed_at IS NOT NULL),(SELECT count(*) FROM webhook_deliveries WHERE status='failed' AND attempted_at>=now()-interval '24 hours')`).Scan(&users, &active, &notes, &spaces, &pending, &comments, &onboarded, &webhookFailures)
	if err != nil {
		writeError(w, 500, "운영 지표를 불러오지 못했습니다.")
		return
	}
	dreamMetrics, err := s.Dreams.Metrics(r.Context())
	if err != nil {
		writeError(w, 500, "Dream 운영 지표를 불러오지 못했습니다.")
		return
	}
	var evalRuns, evalPassed int64
	if err := s.Store.Pool.QueryRow(r.Context(), `SELECT count(*),count(*) FILTER (WHERE status='passed') FROM ai_eval_runs WHERE created_at>=now()-interval '30 days'`).Scan(&evalRuns, &evalPassed); err != nil {
		writeError(w, 500, "AI 평가 지표를 불러오지 못했습니다.")
		return
	}
	out := map[string]any{"users": users, "activeUsers": active, "notes": notes, "spaces": spaces, "pendingApprovals": pending, "comments": comments, "onboardedUsers": onboarded, "webhookFailures24h": webhookFailures, "aiEvalRuns30d": evalRuns, "aiEvalPassed30d": evalPassed, "dream": dreamMetrics}
	if s.Metrics != nil {
		out["http"] = s.Metrics.Snapshot()
	}
	if s.Events != nil {
		subscribers, spaces, delivered, listening := s.Events.Stats()
		out["realtime"] = map[string]any{
			"subscribers": subscribers, "spaces": spaces, "delivered": delivered, "listening": listening,
		}
	}
	writeJSON(w, 200, out)
}

func (s *Server) runDreams(w http.ResponseWriter, r *http.Request) {
	if err := s.Dreams.Trigger(r.Context()); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	p := principal(r)
	s.Store.Audit(r.Context(), &p.User.ID, "dream.run", "dream", "manual", map[string]any{})
	writeJSON(w, 202, map[string]string{"status": "queued"})
}

func (s *Server) adminAudit(w http.ResponseWriter, r *http.Request) {
	offset, ok := decodeOffsetCursor(r.URL.Query().Get("cursor"))
	if !ok {
		writeError(w, 400, "감사 로그 커서가 올바르지 않습니다.")
		return
	}
	limit := parsePageLimit(r, 100, 300)
	rows, err := s.Store.Pool.Query(r.Context(), `SELECT a.id,a.action,a.resource_type,a.resource_id,a.metadata,a.created_at,COALESCE(u.username,'system') FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC,a.id DESC LIMIT $1 OFFSET $2`, limit+1, offset)
	if err != nil {
		writeError(w, 500, "감사 로그를 불러오지 못했습니다.")
		return
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id int64
		var action, resourceType, resourceID, actor string
		var metadata json.RawMessage
		var at time.Time
		if err := rows.Scan(&id, &action, &resourceType, &resourceID, &metadata, &at, &actor); err != nil {
			writeError(w, 500, "감사 로그를 읽지 못했습니다.")
			return
		}
		out = append(out, map[string]any{"id": id, "action": action, "resourceType": resourceType, "resourceId": resourceID, "metadata": metadata, "createdAt": at, "actor": actor})
	}
	if err := rows.Err(); err != nil {
		writeError(w, 500, "감사 로그를 불러오지 못했습니다.")
		return
	}
	next := ""
	if len(out) > limit {
		out = out[:limit]
		next = encodeOffsetCursor(offset + limit)
	}
	writeJSON(w, 200, map[string]any{"audit": out, "nextCursor": next})
}

// embeddingQuality reports what the configured embedding backend actually
// measures, so an administrator can tell a semantic model from a lexical
// fallback without reading the source.
//
// The measurement runs against the gateway they configured, which means it costs
// one embedding request. The store caches the result per backend; ?refresh=true
// forces a fresh run after a settings change.
func (s *Server) embeddingQuality(w http.ResponseWriter, r *http.Request) {
	refresh := r.URL.Query().Get("refresh") == "true"
	report, err := s.Store.MeasureEmbeddingQuality(r.Context(), refresh)
	if err != nil {
		writeError(w, 502, "임베딩 백엔드를 측정하지 못했습니다.")
		return
	}
	classes := make([]map[string]any, 0, len(report.Classes))
	for _, class := range report.Classes {
		classes = append(classes, map[string]any{
			"class": string(class.Class),
			"mean":  math.Round(class.Mean*1000) / 1000,
			"min":   math.Round(class.Min*1000) / 1000,
			"max":   math.Round(class.Max*1000) / 1000,
			"count": class.Count,
		})
	}
	// fellBack tells the operator the difference that matters most: a model is
	// configured, but these numbers came from the offline algorithm instead.
	fellBack := report.Model != "" && report.Algorithm == intelligence.LocalAlgorithm
	writeJSON(w, 200, map[string]any{
		"algorithm":        report.Algorithm,
		"model":            report.Model,
		"classes":          classes,
		"discrimination":   math.Round(report.Discrimination*1000) / 1000,
		"pairwiseAccuracy": math.Round(report.PairwiseAccuracy*1000) / 1000,
		"pairs":            report.Pairs,
		"topicSeparation":  math.Round(report.TopicSeparation*1000) / 1000,
		// The thresholds this verdict was reached against, so the screen shows
		// what "semantic" meant on this deployment rather than the shipped
		// defaults an administrator may have changed.
		"accuracyBar":     report.AccuracyBar,
		"purityBar":       report.PurityBar,
		"neighbourPurity": math.Round(report.NeighbourPurity*1000) / 1000,
		"sentences":       report.Sentences,
		"semantic":        report.Semantic,
		"fellBack":        fellBack,
	})
}

// testEmbeddingGateway probes the configured embedding backend and says what
// actually happened.
//
// Until now the only way to find out whether a gateway worked was to save it and
// read the quality report, which conflates three different failures: the address
// is wrong, the model name is wrong, or the model works but is not semantic.
// This separates the first two, which are the ones an administrator can fix from
// this screen.
func (s *Server) testEmbeddingGateway(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BaseURL string `json:"base_url"`
		APIKey  string `json:"api_key"`
		Model   string `json:"embedding_model"`
	}
	if decodeJSON(w, r, &body) != nil {
		writeError(w, 400, "게이트웨이 정보가 올바르지 않습니다.")
		return
	}
	if strings.TrimSpace(body.BaseURL) == "" || strings.TrimSpace(body.Model) == "" {
		writeError(w, 400, "주소와 임베딩 모델 이름이 모두 필요합니다.")
		return
	}
	// A saved key arrives masked, because the settings screen never sends the
	// stored secret back. Fall back to the stored one so testing an unchanged
	// gateway does not require retyping it.
	key := body.APIKey
	if key == "" || key == secretMask {
		var stored struct {
			APIKey string `json:"api_key"`
		}
		if s.Store.GetSetting(r.Context(), "ai_gateway", &stored) == nil {
			key = s.Store.DecryptSetting(stored.APIKey)
		}
	}

	ctx, cancel := contextWithTimeout(r, 30*time.Second)
	defer cancel()
	provider := intelligence.Provider{Remote: &intelligence.RemoteConfig{
		BaseURL: body.BaseURL, APIKey: key, Model: body.Model, Timeout: 25 * time.Second,
	}}
	vectors, err := provider.EmbedStrict(ctx, []string{"연결 확인", "connection check"})
	if err != nil {
		writeJSON(w, 200, map[string]any{
			"ok":     false,
			"detail": err.Error(),
		})
		return
	}
	dimensions := 0
	if len(vectors) > 0 {
		dimensions = len(vectors[0])
	}
	writeJSON(w, 200, map[string]any{
		"ok":         true,
		"model":      body.Model,
		"dimensions": dimensions,
	})
}

// discoverEmbeddingGateways looks for an embedding gateway at the addresses umm
// itself documents, so setting one up does not require knowing what the model is
// called.
//
// The addresses are compiled in and never read from the request: probing a
// supplied address would make this screen a way of reaching whatever the server
// can reach, and finding umm's own sidecar needs nothing of the sort.
func (s *Server) discoverEmbeddingGateways(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, 10*time.Second)
	defer cancel()
	found := intelligence.DiscoverGateways(ctx, &http.Client{Timeout: 4 * time.Second})
	writeJSON(w, 200, map[string]any{"gateways": found})
}
