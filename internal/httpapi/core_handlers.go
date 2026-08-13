package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/auth"
	"github.com/hkjang/umm/internal/store"
	"github.com/jackc/pgx/v5"
)

func (s *Server) meta(w http.ResponseWriter, r *http.Request) {
	var general struct {
		ServiceName string `json:"service_name"`
	}
	_ = s.Store.GetSetting(r.Context(), "general", &general)
	if general.ServiceName == "" {
		general.ServiceName = "umm"
	}
	var dreamConfig struct {
		Enabled          bool `json:"enabled"`
		AllowUserDisable bool `json:"allow_user_disable"`
	}
	_ = s.Store.GetSetting(r.Context(), "dream", &dreamConfig)
	writeJSON(w, 200, map[string]any{"serviceName": general.ServiceName, "version": s.Version, "oidcEnabled": s.OIDC.Enabled(r.Context()), "dreamEnabled": dreamConfig.Enabled, "dreamAllowUserDisable": dreamConfig.AllowUserDisable, "mcpProtocol": "2026-07-28"})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if decodeJSON(w, r, &body) != nil {
		writeError(w, 400, "아이디와 비밀번호를 확인해 주세요.")
		return
	}
	u, token, err := s.Auth.PasswordLogin(r.Context(), body.Username, body.Password)
	if err != nil {
		s.Store.Audit(r.Context(), nil, "auth.local.failed", "user", strings.TrimSpace(body.Username), map[string]any{})
		writeError(w, 401, "아이디 또는 비밀번호가 올바르지 않습니다.")
		return
	}
	auth.SetSessionCookie(w, r, token)
	s.Store.Audit(r.Context(), &u.ID, "auth.local.login", "user", u.ID.String(), map[string]any{})
	writeJSON(w, 200, u)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(auth.CookieName); err == nil {
		s.Auth.DeleteSession(r.Context(), cookie.Value)
	}
	auth.ClearSessionCookie(w, r)
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (s *Server) me(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, principal(r).User) }

func hasScope(r *http.Request, scope string) bool {
	p := principal(r)
	return p.Scopes["*"] || p.Scopes[scope]
}
func requireScope(w http.ResponseWriter, r *http.Request, scope string) bool {
	if !hasScope(r, scope) {
		writeError(w, 403, "권한이 없습니다: "+scope)
		return false
	}
	return true
}

func (s *Server) listSpaces(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "spaces:read") {
		return
	}
	p := principal(r)
	_, _ = s.Store.EnsureDefaultSpace(r.Context(), p.User.ID)
	v, err := s.Store.ListSpaces(r.Context(), p.User.ID)
	if err != nil {
		writeError(w, 500, "공간을 불러오지 못했습니다.")
		return
	}
	writeJSON(w, 200, map[string]any{"spaces": v})
}
func (s *Server) createSpace(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:write") {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if decodeJSON(w, r, &body) != nil {
		writeError(w, 400, "올바른 이름을 입력해 주세요.")
		return
	}
	p := principal(r)
	v, err := s.Store.CreateSpace(r.Context(), p.User.ID, body.Name)
	if err != nil {
		writeError(w, 500, "공간을 만들지 못했습니다.")
		return
	}
	s.Store.Audit(r.Context(), &p.User.ID, "space.create", "space", v.ID.String(), map[string]any{"name": v.Name})
	writeJSON(w, 201, v)
}

func parseID(w http.ResponseWriter, r *http.Request, param string) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, param))
	if err != nil {
		writeError(w, 400, "올바르지 않은 ID입니다.")
		return uuid.Nil, false
	}
	return id, true
}

func (s *Server) listNotes(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:read") {
		return
	}
	spaceID, ok := parseID(w, r, "spaceID")
	if !ok {
		return
	}
	notes, edges, err := s.Store.ListNotes(r.Context(), principal(r).User.ID, spaceID, r.URL.Query().Get("q"))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, 404, "공간을 찾을 수 없습니다.")
			return
		}
		writeError(w, 500, "생각을 불러오지 못했습니다.")
		return
	}
	writeJSON(w, 200, map[string]any{"notes": notes, "edges": edges})
}

func (s *Server) createNote(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:write") {
		return
	}
	spaceID, ok := parseID(w, r, "spaceID")
	if !ok {
		return
	}
	var n store.Note
	if decodeJSON(w, r, &n) != nil {
		writeError(w, 400, "메모 형식이 올바르지 않습니다.")
		return
	}
	n.ID = uuid.Nil
	n.SpaceID = spaceID
	n.Source = "user"
	p := principal(r)
	created, err := s.Store.CreateNote(r.Context(), p.User.ID, n)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, 404, "편집할 수 없는 공간입니다.")
			return
		}
		writeError(w, 500, "생각을 붙이지 못했습니다.")
		return
	}
	s.Store.Audit(r.Context(), &p.User.ID, "note.create", "note", created.ID.String(), map[string]any{"spaceId": spaceID})
	s.publishSpaceEvent(r, spaceID, "note.created", created.ID, created)
	writeJSON(w, 201, created)
}

func (s *Server) updateNote(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:write") {
		return
	}
	noteID, ok := parseID(w, r, "noteID")
	if !ok {
		return
	}
	var n store.Note
	if decodeJSON(w, r, &n) != nil {
		writeError(w, 400, "메모 형식이 올바르지 않습니다.")
		return
	}
	n.ID = noteID
	p := principal(r)
	updated, err := s.Store.UpdateNote(r.Context(), p.User.ID, n)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, 409, "다른 위치에서 메모가 변경되었습니다. 새로고침 후 다시 시도해 주세요.")
			return
		}
		writeError(w, 500, "생각을 저장하지 못했습니다.")
		return
	}
	if updated.Source == "dream" {
		var dreamID uuid.UUID
		if s.Store.Pool.QueryRow(r.Context(), `SELECT dream_id FROM dream_notes WHERE note_id=$1`, updated.ID).Scan(&dreamID) == nil {
			_ = s.Dreams.Feedback(r.Context(), p.User.ID, dreamID, "edited")
		}
	}
	s.publishSpaceEvent(r, updated.SpaceID, "note.updated", updated.ID, updated)
	writeJSON(w, 200, updated)
}

func (s *Server) deleteNote(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:write") {
		return
	}
	id, ok := parseID(w, r, "noteID")
	if !ok {
		return
	}
	p := principal(r)
	var spaceID uuid.UUID
	_ = s.Store.Pool.QueryRow(r.Context(), `SELECT space_id FROM notes WHERE id=$1`, id).Scan(&spaceID)
	var dreamID uuid.UUID
	_ = s.Store.Pool.QueryRow(r.Context(), `SELECT dream_id FROM dream_notes WHERE note_id=$1 AND user_id=$2`, id, p.User.ID).Scan(&dreamID)
	if err := s.Store.DeleteNote(r.Context(), p.User.ID, id); err != nil {
		writeError(w, 404, "삭제할 수 없는 메모입니다.")
		return
	}
	if dreamID != uuid.Nil {
		_ = s.Dreams.Feedback(r.Context(), p.User.ID, dreamID, "deleted")
	}
	s.Store.Audit(r.Context(), &p.User.ID, "note.delete", "note", id.String(), map[string]any{})
	if spaceID != uuid.Nil {
		s.publishSpaceEvent(r, spaceID, "note.deleted", id, map[string]any{})
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) createEdge(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:write") {
		return
	}
	spaceID, ok := parseID(w, r, "spaceID")
	if !ok {
		return
	}
	var e store.Edge
	if decodeJSON(w, r, &e) != nil {
		writeError(w, 400, "연결 정보가 올바르지 않습니다.")
		return
	}
	e.ID = uuid.Nil
	e.SpaceID = spaceID
	p := principal(r)
	created, err := s.Store.CreateEdge(r.Context(), p.User.ID, e)
	if err != nil {
		writeError(w, 400, "생각을 연결하지 못했습니다.")
		return
	}
	var dreamID uuid.UUID
	if s.Store.Pool.QueryRow(r.Context(), `SELECT dream_id FROM dream_notes WHERE note_id IN ($1,$2) AND user_id=$3 LIMIT 1`, e.SourceID, e.TargetID, p.User.ID).Scan(&dreamID) == nil {
		_ = s.Dreams.Feedback(r.Context(), p.User.ID, dreamID, "connected")
	}
	s.publishSpaceEvent(r, spaceID, "edge.created", created.ID, created)
	writeJSON(w, 201, created)
}

func (s *Server) relatedNotes(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:read") {
		return
	}
	id, ok := parseID(w, r, "noteID")
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	related, err := s.Store.RelatedNotes(r.Context(), principal(r).User.ID, id, limit)
	if err != nil {
		writeError(w, 404, "관련 생각을 찾을 수 없습니다.")
		return
	}
	writeJSON(w, 200, map[string]any{"related": related})
}

func (s *Server) thoughtClusters(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:read") {
		return
	}
	spaceID, ok := parseID(w, r, "spaceID")
	if !ok {
		return
	}
	clusters, err := s.Store.Clusters(r.Context(), principal(r).User.ID, spaceID)
	if err != nil {
		writeError(w, 404, "생각 군집을 찾을 수 없습니다.")
		return
	}
	writeJSON(w, 200, map[string]any{"clusters": clusters})
}

func (s *Server) aiAssist(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:read") {
		return
	}
	var body struct {
		NoteIDs []uuid.UUID `json:"noteIds"`
		Mode    string      `json:"mode"`
	}
	if decodeJSON(w, r, &body) != nil {
		writeError(w, 400, "AI 요청 형식이 올바르지 않습니다.")
		return
	}
	p := principal(r)
	result, err := s.Dreams.Assist(r.Context(), p.User.ID, body.NoteIDs, body.Mode)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	s.Store.Audit(r.Context(), &p.User.ID, "ai.assist", "notes", strings.Join(func() []string {
		ids := make([]string, len(body.NoteIDs))
		for i, id := range body.NoteIDs {
			ids[i] = id.String()
		}
		return ids
	}(), ","), map[string]any{"mode": body.Mode})
	writeJSON(w, 200, result)
}

func (s *Server) noteHistory(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:read") {
		return
	}
	id, ok := parseID(w, r, "noteID")
	if !ok {
		return
	}
	history, err := s.Store.NoteHistory(r.Context(), principal(r).User.ID, id)
	if err != nil {
		writeError(w, 404, "메모 기록을 찾을 수 없습니다.")
		return
	}
	writeJSON(w, 200, map[string]any{"history": history})
}
func (s *Server) restoreNote(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:write") {
		return
	}
	id, ok := parseID(w, r, "noteID")
	if !ok {
		return
	}
	version, err := strconv.Atoi(chi.URLParam(r, "version"))
	if err != nil || version < 1 {
		writeError(w, 400, "복원할 버전이 올바르지 않습니다.")
		return
	}
	p := principal(r)
	restored, err := s.Store.RestoreNote(r.Context(), p.User.ID, id, version)
	if err != nil {
		writeError(w, 404, "복원할 기록을 찾을 수 없습니다.")
		return
	}
	s.publishSpaceEvent(r, restored.SpaceID, "note.restored", restored.ID, restored)
	s.Store.Audit(r.Context(), &p.User.ID, "note.restore", "note", id.String(), map[string]any{"fromVersion": version})
	writeJSON(w, 200, restored)
}
