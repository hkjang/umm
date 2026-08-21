package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/auth"
	"github.com/hkjang/umm/internal/dream"
	"github.com/hkjang/umm/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// noteWriteRequest contains only client-editable note fields. Server-managed
// fields remain accepted as arbitrary JSON for compatibility with clients that
// send a previously returned Note object, but they are never trusted or used.
type noteWriteRequest struct {
	ID           json.RawMessage `json:"id"`
	SpaceID      json.RawMessage `json:"spaceId"`
	AuthorID     json.RawMessage `json:"authorId"`
	Content      string          `json:"content"`
	Title        string          `json:"title"`
	Color        string          `json:"color"`
	Kind         string          `json:"kind"`
	Source       string          `json:"source"`
	AIExcluded   *bool           `json:"aiExcluded"`
	X            float64         `json:"x"`
	Y            float64         `json:"y"`
	Width        float64         `json:"width"`
	Height       float64         `json:"height"`
	Rotation     float64         `json:"rotation"`
	Version      int             `json:"version"`
	CreatedAt    json.RawMessage `json:"createdAt"`
	UpdatedAt    json.RawMessage `json:"updatedAt"`
	RelatedCount int             `json:"relatedCount"`
}

func (v noteWriteRequest) note() store.Note {
	aiExcluded := v.AIExcluded != nil && *v.AIExcluded
	return store.Note{
		Content: v.Content, Title: v.Title, Color: v.Color, Kind: v.Kind,
		AIExcluded: aiExcluded,
		X:          v.X, Y: v.Y, Width: v.Width, Height: v.Height, Rotation: v.Rotation,
		Version: v.Version,
	}
}

type edgeWriteRequest struct {
	ID       json.RawMessage `json:"id"`
	SpaceID  json.RawMessage `json:"spaceId"`
	SourceID uuid.UUID       `json:"source"`
	TargetID uuid.UUID       `json:"target"`
	Relation string          `json:"relation"`
}

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
	if decodeJSON(w, r, &body) != nil || strings.TrimSpace(body.Name) == "" || utf8.RuneCountInString(strings.TrimSpace(body.Name)) > 200 {
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

func (s *Server) updateSpace(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:write") {
		return
	}
	spaceID, ok := parseID(w, r, "spaceID")
	if !ok {
		return
	}
	var body struct {
		Name       string `json:"name"`
		AIExcluded *bool  `json:"aiExcluded"`
	}
	name := ""
	if decodeJSON(w, r, &body) == nil {
		name = strings.TrimSpace(body.Name)
	}
	if name == "" || utf8.RuneCountInString(name) > 200 {
		writeError(w, 400, "공간 이름은 1~200자로 입력해 주세요.")
		return
	}
	p := principal(r)
	updated, err := s.Store.UpdateSpace(r.Context(), p.User.ID, spaceID, name, body.AIExcluded)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, 404, "이름을 변경할 수 있는 공간을 찾지 못했습니다.")
			return
		}
		writeError(w, 500, "공간 이름을 변경하지 못했습니다.")
		return
	}
	s.Store.Audit(r.Context(), &p.User.ID, "space.update", "space", spaceID.String(), map[string]any{"name": name, "aiExcluded": body.AIExcluded})
	writeJSON(w, 200, updated)
}

func (s *Server) deleteSpace(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:write") {
		return
	}
	spaceID, ok := parseID(w, r, "spaceID")
	if !ok {
		return
	}
	p := principal(r)
	if err := s.Store.DeleteSpace(r.Context(), p.User.ID, spaceID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, 403, "소유한 공간만 삭제할 수 있습니다.")
			return
		}
		writeError(w, 500, "공간을 삭제하지 못했습니다.")
		return
	}
	s.Store.Audit(r.Context(), &p.User.ID, "space.delete", "space", spaceID.String(), map[string]any{})
	w.WriteHeader(http.StatusNoContent)
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

func (s *Server) searchNotes(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:read") {
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		writeJSON(w, 200, map[string]any{"notes": []store.NoteSearchResult{}, "nextCursor": ""})
		return
	}
	if utf8.RuneCountInString(query) > 200 {
		writeError(w, 400, "검색어는 200자 이내로 입력해 주세요.")
		return
	}
	offset, ok := decodeOffsetCursor(r.URL.Query().Get("cursor"))
	if !ok {
		writeError(w, 400, "검색 커서가 올바르지 않습니다.")
		return
	}
	spaceID, ok := parseOptionalUUID(r.URL.Query().Get("spaceId"))
	if !ok {
		writeError(w, 400, "검색 공간 ID가 올바르지 않습니다.")
		return
	}
	updatedFrom, ok := parseOptionalTime(r.URL.Query().Get("updatedFrom"))
	if !ok {
		writeError(w, 400, "검색 시작 시각은 RFC 3339 형식이어야 합니다.")
		return
	}
	updatedTo, ok := parseOptionalTime(r.URL.Query().Get("updatedTo"))
	if !ok {
		writeError(w, 400, "검색 종료 시각은 RFC 3339 형식이어야 합니다.")
		return
	}
	page, err := s.Store.SearchNotesHybrid(r.Context(), principal(r).User.ID, store.SearchOptions{
		Query: query, SpaceID: spaceID, Kind: strings.TrimSpace(r.URL.Query().Get("kind")),
		UpdatedFrom: updatedFrom, UpdatedTo: updatedTo, Offset: offset, Limit: parsePageLimit(r, 20, 50),
	})
	if err != nil {
		writeError(w, 500, "메모 바로가기를 검색하지 못했습니다.")
		return
	}
	next := ""
	if page.HasMore {
		next = encodeOffsetCursor(page.NextOffset)
	}
	writeJSON(w, 200, map[string]any{"notes": page.Notes, "nextCursor": next})
}

func (s *Server) createNote(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:write") {
		return
	}
	spaceID, ok := parseID(w, r, "spaceID")
	if !ok {
		return
	}
	var body noteWriteRequest
	if decodeJSON(w, r, &body) != nil {
		writeError(w, 400, "메모 형식이 올바르지 않습니다.")
		return
	}
	n := body.note()
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
	var body noteWriteRequest
	if decodeJSON(w, r, &body) != nil {
		writeError(w, 400, "메모 형식이 올바르지 않습니다.")
		return
	}
	n := body.note()
	n.ID = noteID
	p := principal(r)
	updated, err := s.Store.UpdateNote(r.Context(), p.User.ID, n, body.AIExcluded)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			latest, latestErr := s.Store.NoteByID(r.Context(), p.User.ID, noteID)
			if latestErr == nil {
				writeProblem(w, r, http.StatusConflict, "note-version-conflict", "메모 버전 충돌", "다른 위치에서 메모가 변경되었습니다. 두 버전을 비교해 선택해 주세요.", map[string]any{"clientVersion": n.Version, "latest": latest})
				return
			}
			if updateNoteLookupFailureStatus(latestErr) == http.StatusNotFound {
				writeProblem(w, r, http.StatusNotFound, "note-not-found", "메모를 찾을 수 없음", "메모가 삭제되었거나 더 이상 접근할 수 없어 오프라인 변경을 적용할 수 없습니다.", nil)
				return
			}
			writeError(w, http.StatusInternalServerError, "최신 메모를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.")
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
	var dreamID uuid.UUID
	_ = s.Store.Pool.QueryRow(r.Context(), `SELECT dream_id FROM dream_notes WHERE note_id=$1 AND user_id=$2`, id, p.User.ID).Scan(&dreamID)
	if err := s.Store.DeleteNote(r.Context(), p.User.ID, id); err != nil {
		status := deleteNoteErrorStatus(err)
		message := "삭제할 수 없는 메모입니다."
		if status == http.StatusInternalServerError {
			message = "메모 삭제를 저장하지 못했습니다."
			slog.Warn("note delete failed", "note_id", id, "user_id", p.User.ID, "error", err)
		}
		writeError(w, status, message)
		return
	}
	if dreamID != uuid.Nil {
		_ = s.Dreams.Feedback(r.Context(), p.User.ID, dreamID, "deleted")
	}
	s.Store.Audit(r.Context(), &p.User.ID, "note.delete", "note", id.String(), map[string]any{})
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
	var body edgeWriteRequest
	if decodeJSON(w, r, &body) != nil {
		writeError(w, 400, "연결 정보가 올바르지 않습니다.")
		return
	}
	e := store.Edge{SourceID: body.SourceID, TargetID: body.TargetID, Relation: body.Relation}
	e.ID = uuid.Nil
	e.SpaceID = spaceID
	p := principal(r)
	created, err := s.Store.CreateEdge(r.Context(), p.User.ID, e)
	if err != nil {
		status := createEdgeErrorStatus(err)
		message := "생각을 연결할 수 없습니다."
		if status == http.StatusInternalServerError {
			message = "생각 연결을 저장하지 못했습니다."
			slog.Warn("edge create failed", "space_id", spaceID, "user_id", p.User.ID, "error", err)
		}
		writeError(w, status, message)
		return
	}
	var dreamID uuid.UUID
	if s.Store.Pool.QueryRow(r.Context(), `SELECT dream_id FROM dream_notes WHERE note_id IN ($1,$2) AND user_id=$3 LIMIT 1`, e.SourceID, e.TargetID, p.User.ID).Scan(&dreamID) == nil {
		_ = s.Dreams.Feedback(r.Context(), p.User.ID, dreamID, "connected")
	}
	writeJSON(w, 201, created)
}

func deleteNoteErrorStatus(err error) int {
	if errors.Is(err, pgx.ErrNoRows) {
		return http.StatusNotFound
	}
	return http.StatusInternalServerError
}

func updateNoteLookupFailureStatus(err error) int {
	if errors.Is(err, pgx.ErrNoRows) {
		return http.StatusNotFound
	}
	return http.StatusInternalServerError
}

func createEdgeErrorStatus(err error) int {
	if errors.Is(err, pgx.ErrNoRows) {
		return http.StatusBadRequest
	}
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) && strings.HasPrefix(databaseError.Code, "23") {
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
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
		slog.Warn("AI assist failed", "user_id", p.User.ID, "mode", body.Mode, "error", err)
		if errors.Is(err, dream.ErrAIResponseTokenLimit) {
			writeError(w, http.StatusBadGateway, "AI 모델이 최종 답변을 만들기 전에 Token Limit에 도달했습니다. 관리자에게 Dream Layer의 응답 Token Limit을 높여 달라고 요청해 주세요.")
			return
		}
		writeError(w, http.StatusBadGateway, "AI 응답을 받지 못했습니다. 잠시 후 다시 시도하거나 관리자에게 AI 연결 설정을 확인해 달라고 요청해 주세요.")
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
	s.Store.Audit(r.Context(), &p.User.ID, "note.restore", "note", id.String(), map[string]any{"fromVersion": version})
	writeJSON(w, 200, restored)
}
