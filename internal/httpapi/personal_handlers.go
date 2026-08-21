package httpapi

import (
	"net/http"
	"slices"
	"time"

	"github.com/google/uuid"
)

type preferences struct {
	DreamEnabled       bool       `json:"dream_enabled"`
	DreamFrequency     string     `json:"dream_frequency"`
	DreamStyle         string     `json:"dream_style"`
	DreamNotifications bool       `json:"dream_notifications"`
	IncludeOldNotes    bool       `json:"include_old_notes"`
	DreamPauseUntil    *time.Time `json:"dream_pause_until"`
	Theme              string     `json:"theme"`
	Locale             string     `json:"locale"`
	EdgeStyle          string     `json:"edge_style"`
	ReviewDigest       bool       `json:"review_digest"`
}

func (s *Server) getPreferences(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var v preferences
	err := s.Store.Pool.QueryRow(r.Context(), `SELECT dream_enabled,dream_frequency,dream_style,dream_notifications,include_old_notes,dream_pause_until,theme,locale,edge_style,review_digest FROM user_preferences WHERE user_id=$1`, p.User.ID).Scan(&v.DreamEnabled, &v.DreamFrequency, &v.DreamStyle, &v.DreamNotifications, &v.IncludeOldNotes, &v.DreamPauseUntil, &v.Theme, &v.Locale, &v.EdgeStyle, &v.ReviewDigest)
	if err != nil {
		writeError(w, 500, "개인 설정을 불러오지 못했습니다.")
		return
	}
	writeJSON(w, 200, v)
}

func (s *Server) putPreferences(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	var v preferences
	_ = s.Store.Pool.QueryRow(r.Context(), `SELECT review_digest FROM user_preferences WHERE user_id=$1`, p.User.ID).Scan(&v.ReviewDigest)
	if decodeJSON(w, r, &v) != nil {
		writeError(w, 400, "개인 설정 형식이 올바르지 않습니다.")
		return
	}
	if !slices.Contains([]string{"daily", "three_week", "weekly"}, v.DreamFrequency) {
		writeError(w, 400, "Dream 빈도가 올바르지 않습니다.")
		return
	}
	if !slices.Contains([]string{"auto", "connection", "question", "expansion", "free"}, v.DreamStyle) {
		writeError(w, 400, "Dream 스타일이 올바르지 않습니다.")
		return
	}
	if !slices.Contains([]string{"light", "dark", "system"}, v.Theme) {
		writeError(w, 400, "테마가 올바르지 않습니다.")
		return
	}
	if v.EdgeStyle == "" {
		_ = s.Store.Pool.QueryRow(r.Context(), `SELECT edge_style FROM user_preferences WHERE user_id=$1`, p.User.ID).Scan(&v.EdgeStyle)
		if v.EdgeStyle == "" {
			v.EdgeStyle = "bezier"
		}
	}
	if !slices.Contains([]string{"bezier", "smoothstep", "straight"}, v.EdgeStyle) {
		writeError(w, 400, "연결선 형태가 올바르지 않습니다.")
		return
	}
	var dreamCfg struct {
		AllowUserDisable bool `json:"allow_user_disable"`
	}
	_ = s.Store.GetSetting(r.Context(), "dream", &dreamCfg)
	if !dreamCfg.AllowUserDisable {
		v.DreamEnabled = true
	}
	_, err := s.Store.Pool.Exec(r.Context(), `UPDATE user_preferences SET dream_enabled=$2,dream_frequency=$3,dream_style=$4,dream_notifications=$5,include_old_notes=$6,dream_pause_until=$7,theme=$8,locale=$9,edge_style=$10,review_digest=$11,updated_at=now() WHERE user_id=$1`, p.User.ID, v.DreamEnabled, v.DreamFrequency, v.DreamStyle, v.DreamNotifications, v.IncludeOldNotes, v.DreamPauseUntil, v.Theme, v.Locale, v.EdgeStyle, v.ReviewDigest)
	if err != nil {
		writeError(w, 500, "개인 설정을 저장하지 못했습니다.")
		return
	}
	writeJSON(w, 200, v)
}

type securityConfig struct {
	APIKeyScopes         []string `json:"api_key_scopes"`
	DefaultKeyDays       int      `json:"default_key_days"`
	RotationOverlapHours int      `json:"rotation_overlap_hours"`
}

func (s *Server) getSecurityConfig(r *http.Request) securityConfig {
	var cfg securityConfig
	_ = s.Store.GetSetting(r.Context(), "security", &cfg)
	if cfg.DefaultKeyDays <= 0 {
		cfg.DefaultKeyDays = 90
	}
	return cfg
}
func validateScopes(requested, allowed []string) bool {
	if len(requested) == 0 {
		return false
	}
	for _, v := range requested {
		if !slices.Contains(allowed, v) {
			return false
		}
	}
	return true
}

func (s *Server) listAPIKeys(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	keys, err := s.Auth.ListKeys(r.Context(), p.User.ID)
	if err != nil {
		writeError(w, 500, "키를 불러오지 못했습니다.")
		return
	}
	cfg := s.getSecurityConfig(r)
	writeJSON(w, 200, map[string]any{"keys": keys, "availableScopes": cfg.APIKeyScopes, "rotationOverlapHours": cfg.RotationOverlapHours})
}

func (s *Server) createAPIKey(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name        string   `json:"name"`
		Scopes      []string `json:"scopes"`
		ExpiresDays int      `json:"expiresDays"`
	}
	if decodeJSON(w, r, &body) != nil {
		writeError(w, 400, "키 설정 형식이 올바르지 않습니다.")
		return
	}
	cfg := s.getSecurityConfig(r)
	if !validateScopes(body.Scopes, cfg.APIKeyScopes) {
		writeError(w, 400, "허용되지 않은 키 권한입니다.")
		return
	}
	if body.ExpiresDays == 0 {
		body.ExpiresDays = cfg.DefaultKeyDays
	}
	if body.ExpiresDays < 1 || body.ExpiresDays > 3650 {
		writeError(w, 400, "키 만료 기간은 1~3650일이어야 합니다.")
		return
	}
	p := principal(r)
	key, secret, err := s.Auth.CreateKey(r.Context(), p.User.ID, body.Name, body.Scopes, body.ExpiresDays)
	if err != nil {
		writeError(w, 500, "키를 만들지 못했습니다.")
		return
	}
	s.Store.Audit(r.Context(), &p.User.ID, "api_key.create", "api_key", key.ID.String(), map[string]any{"scopes": body.Scopes})
	writeJSON(w, 201, map[string]any{"key": key, "secret": secret, "warning": "이 키는 다시 표시되지 않습니다."})
}

func (s *Server) updateAPIKey(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r, "keyID")
	if !ok {
		return
	}
	var body struct {
		Scopes []string `json:"scopes"`
	}
	if decodeJSON(w, r, &body) != nil {
		writeError(w, 400, "키 권한 형식이 올바르지 않습니다.")
		return
	}
	cfg := s.getSecurityConfig(r)
	if !validateScopes(body.Scopes, cfg.APIKeyScopes) {
		writeError(w, 400, "허용되지 않은 키 권한입니다.")
		return
	}
	p := principal(r)
	if err := s.Auth.UpdateKeyScopes(r.Context(), p.User.ID, id, body.Scopes); err != nil {
		writeError(w, 404, "활성 키를 찾을 수 없습니다.")
		return
	}
	s.Store.Audit(r.Context(), &p.User.ID, "api_key.permissions", "api_key", id.String(), map[string]any{"scopes": body.Scopes})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) rotateAPIKey(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r, "keyID")
	if !ok {
		return
	}
	cfg := s.getSecurityConfig(r)
	p := principal(r)
	key, secret, err := s.Auth.RotateKey(r.Context(), p.User.ID, id, cfg.RotationOverlapHours)
	if err != nil {
		writeError(w, 404, "회전할 활성 키를 찾을 수 없습니다.")
		return
	}
	s.Store.Audit(r.Context(), &p.User.ID, "api_key.rotate", "api_key", id.String(), map[string]any{"replacement": key.ID, "overlapHours": cfg.RotationOverlapHours})
	writeJSON(w, 201, map[string]any{"key": key, "secret": secret, "overlapHours": cfg.RotationOverlapHours, "warning": "새 키는 다시 표시되지 않습니다."})
}

func (s *Server) revokeAPIKey(w http.ResponseWriter, r *http.Request) {
	id, ok := parseID(w, r, "keyID")
	if !ok {
		return
	}
	p := principal(r)
	if err := s.Auth.RevokeKey(r.Context(), p.User.ID, id); err != nil {
		writeError(w, 404, "키를 찾을 수 없습니다.")
		return
	}
	s.Store.Audit(r.Context(), &p.User.ID, "api_key.revoke", "api_key", id.String(), map[string]any{})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) dreamHistory(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "dreams:read") {
		return
	}
	offset, ok := decodeOffsetCursor(r.URL.Query().Get("cursor"))
	if !ok {
		writeError(w, 400, "Dream 커서가 올바르지 않습니다.")
		return
	}
	limit := parsePageLimit(r, 30, 100)
	v, hasMore, err := s.Dreams.HistoryPage(r.Context(), principal(r).User.ID, limit, offset)
	if err != nil {
		writeError(w, 500, "Dream 기록을 불러오지 못했습니다.")
		return
	}
	next := ""
	if hasMore {
		next = encodeOffsetCursor(offset + limit)
	}
	writeJSON(w, 200, map[string]any{"dreams": v, "nextCursor": next})
}
func (s *Server) dreamFeedback(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "dreams:read") {
		return
	}
	id, ok := parseID(w, r, "dreamID")
	if !ok {
		return
	}
	var body struct {
		Action string `json:"action"`
		Reason string `json:"reason"`
	}
	if decodeJSON(w, r, &body) != nil {
		writeError(w, 400, "피드백 형식이 올바르지 않습니다.")
		return
	}
	if err := s.Dreams.FeedbackWithReason(r.Context(), principal(r).User.ID, id, body.Action, body.Reason); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) acceptDream(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "dreams:read") || !requireScope(w, r, "notes:write") {
		return
	}
	id, ok := parseID(w, r, "dreamID")
	if !ok {
		return
	}
	var body struct {
		Content string `json:"content"`
	}
	if decodeJSON(w, r, &body) != nil {
		writeError(w, 400, "Dream 채택 형식이 올바르지 않습니다.")
		return
	}
	p := principal(r)
	note, err := s.Dreams.Accept(r.Context(), p.User.ID, id, body.Content)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	s.Store.Audit(r.Context(), &p.User.ID, "dream.accept", "dream", id.String(), map[string]any{"noteId": note.ID, "spaceId": note.SpaceID})
	writeJSON(w, http.StatusCreated, note)
}

func (s *Server) regenerateDream(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "dreams:read") {
		return
	}
	id, ok := parseID(w, r, "dreamID")
	if !ok {
		return
	}
	p := principal(r)
	view, err := s.Dreams.Regenerate(r.Context(), p.User.ID, id)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	s.Store.Audit(r.Context(), &p.User.ID, "dream.regenerate", "dream", id.String(), map[string]any{"generation": view.Generation})
	writeJSON(w, 200, view)
}

func (s *Server) developDream(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "dreams:read") {
		return
	}
	id, ok := parseID(w, r, "dreamID")
	if !ok {
		return
	}
	var body struct {
		Mode string `json:"mode"`
	}
	if decodeJSON(w, r, &body) != nil {
		writeError(w, 400, "Dream 발전 형식이 올바르지 않습니다.")
		return
	}
	p := principal(r)
	result, err := s.Dreams.Develop(r.Context(), p.User.ID, id, body.Mode)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	s.Store.Audit(r.Context(), &p.User.ID, "dream.develop", "dream", id.String(), map[string]any{"mode": body.Mode})
	writeJSON(w, 200, result)
}

func (s *Server) saveDevelopedDream(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "dreams:read") || !requireScope(w, r, "notes:write") {
		return
	}
	id, ok := parseID(w, r, "dreamID")
	if !ok {
		return
	}
	var body struct {
		Content string `json:"content"`
	}
	if decodeJSON(w, r, &body) != nil {
		writeError(w, 400, "Dream 발전 결과 형식이 올바르지 않습니다.")
		return
	}
	p := principal(r)
	result, err := s.Dreams.MaterializeDevelopment(r.Context(), p.User.ID, id, body.Content)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	status := http.StatusOK
	if result.Created {
		status = http.StatusCreated
		s.Store.Audit(r.Context(), &p.User.ID, "dream.development.save", "dream", id.String(), map[string]any{"noteId": result.Note.ID, "spaceId": result.Note.SpaceID})
	}
	writeJSON(w, status, result)
}

var _ = uuid.Nil
