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
		for _, field := range []string{"client_secret", "api_key"} {
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
	if !slices.Contains([]string{"general", "oidc", "security", "workflow", "dream", "ai_gateway"}, section) {
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
	if field := secretField(section); field != "" {
		var existing map[string]any
		_ = s.Store.GetSetting(r.Context(), section, &existing)
		raw, _ := incoming[field].(string)
		if raw == "" || raw == secretMask {
			incoming[field] = existing[field]
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
	s.Store.Audit(r.Context(), &p.User.ID, "settings.update", "settings", section, map[string]any{})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func secretField(section string) string {
	if section == "oidc" {
		return "client_secret"
	}
	if section == "ai_gateway" {
		return "api_key"
	}
	return ""
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
	case "security":
		scopes, ok := v["api_key_scopes"].([]any)
		if !ok || len(scopes) == 0 {
			return errors.New("하나 이상의 API 키 권한이 필요합니다")
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
