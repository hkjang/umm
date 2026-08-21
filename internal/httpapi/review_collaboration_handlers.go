package httpapi

import (
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/store"
	"github.com/jackc/pgx/v5"
)

func encodeOffsetCursor(offset int) string {
	if offset <= 0 {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString([]byte("offset:" + strconv.Itoa(offset)))
}

func decodeOffsetCursor(raw string) (int, bool) {
	if raw == "" {
		return 0, true
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || !strings.HasPrefix(string(decoded), "offset:") {
		return 0, false
	}
	offset, err := strconv.Atoi(strings.TrimPrefix(string(decoded), "offset:"))
	return offset, err == nil && offset >= 0 && offset <= 1_000_000
}

func parsePageLimit(r *http.Request, fallback, maximum int) int {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit < 1 {
		limit = fallback
	}
	return min(limit, maximum)
}

func (s *Server) todayReview(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:read") {
		return
	}
	p := principal(r)
	result, err := s.Store.TodayReview(r.Context(), p.User.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "오늘의 리뷰를 준비하지 못했습니다.")
		return
	}
	redactTodayDreams(&result, hasScope(r, "dreams:read"))
	s.Store.Track(r.Context(), &p.User.ID, "today.opened", "user", &p.User.ID, map[string]any{"reviewCount": result.Counts["review"]})
	writeJSON(w, http.StatusOK, result)
}

func redactTodayDreams(result *store.TodayReview, allowed bool) {
	if allowed {
		return
	}
	result.Dreams = []store.ReviewDream{}
	if result.Counts != nil {
		result.Counts["dreams"] = 0
	}
}

func (s *Server) reviewNote(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:write") {
		return
	}
	noteID, ok := parseID(w, r, "noteID")
	if !ok {
		return
	}
	var body struct {
		SnoozeDays *int  `json:"snoozeDays"`
		Pinned     *bool `json:"pinned"`
		Complete   *bool `json:"complete"`
	}
	if decodeJSON(w, r, &body) != nil {
		writeError(w, http.StatusBadRequest, "검토 설정 형식이 올바르지 않습니다.")
		return
	}
	if body.SnoozeDays != nil && (*body.SnoozeDays < 1 || *body.SnoozeDays > 365) {
		writeError(w, http.StatusBadRequest, "다시 볼 날짜는 1~365일 뒤로 지정해 주세요.")
		return
	}
	complete := body.Complete == nil || *body.Complete
	if !complete && (body.Pinned == nil || body.SnoozeDays != nil) {
		writeError(w, http.StatusBadRequest, "검토를 완료하지 않을 때는 고정 상태만 변경할 수 있습니다.")
		return
	}
	p := principal(r)
	item, err := s.Store.UpdateReview(r.Context(), p.User.ID, noteID, body.SnoozeDays, body.Pinned, complete)
	if err != nil {
		if err == pgx.ErrNoRows {
			writeError(w, http.StatusNotFound, "검토할 생각을 찾을 수 없습니다.")
			return
		}
		writeError(w, http.StatusInternalServerError, "검토 상태를 저장하지 못했습니다.")
		return
	}
	event := "review.pinned"
	if complete {
		event = "review.completed"
	}
	s.Store.Track(r.Context(), &p.User.ID, event, "note", &noteID, map[string]any{"snoozeDays": body.SnoozeDays, "pinned": body.Pinned})
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) onboardingProgress(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:read") {
		return
	}
	result, err := s.Store.TodayReview(r.Context(), principal(r).User.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "시작 안내 상태를 불러오지 못했습니다.")
		return
	}
	writeJSON(w, http.StatusOK, result.Onboarding)
}

func (s *Server) completeOnboarding(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:write") {
		return
	}
	p := principal(r)
	if err := s.Store.CompleteOnboarding(r.Context(), p.User.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "시작 안내 상태를 저장하지 못했습니다.")
		return
	}
	s.Store.Track(r.Context(), &p.User.ID, "onboarding.completed", "user", &p.User.ID, map[string]any{})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) noteBacklinks(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:read") {
		return
	}
	noteID, ok := parseID(w, r, "noteID")
	if !ok {
		return
	}
	links, err := s.Store.Backlinks(r.Context(), principal(r).User.ID, noteID)
	if err != nil {
		writeError(w, http.StatusNotFound, "연결된 생각을 찾을 수 없습니다.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"backlinks": links})
}

func mentionedUsernameTokens(body string) []string {
	runes := []rune(body)
	seen := map[string]bool{}
	out := []string{}
	for index := 0; index < len(runes); index++ {
		if runes[index] != '@' || (index > 0 && !unicode.IsSpace(runes[index-1]) && !strings.ContainsRune("([{", runes[index-1])) {
			continue
		}
		end := index + 1
		for end < len(runes) && !unicode.IsSpace(runes[end]) {
			end++
		}
		name := strings.ToLower(string(runes[index+1 : end]))
		if name == "" {
			continue
		}
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
		index = end - 1
	}
	return out
}

func commentCreateError(err error) (int, string) {
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return http.StatusNotFound, "댓글을 남길 수 있는 생각을 찾지 못했습니다."
	case errors.Is(err, store.ErrInvalidParentComment):
		return http.StatusBadRequest, "답글을 연결할 댓글을 찾지 못했습니다."
	default:
		return http.StatusInternalServerError, "댓글을 저장하지 못했습니다."
	}
}

func (s *Server) listComments(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:read") {
		return
	}
	noteID, ok := parseID(w, r, "noteID")
	if !ok {
		return
	}
	comments, err := s.Store.ListComments(r.Context(), principal(r).User.ID, noteID)
	if err != nil {
		writeError(w, http.StatusNotFound, "댓글을 볼 수 있는 생각을 찾지 못했습니다.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"comments": comments})
}

func (s *Server) createComment(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:write") {
		return
	}
	noteID, ok := parseID(w, r, "noteID")
	if !ok {
		return
	}
	var body struct {
		Body     string     `json:"body"`
		ParentID *uuid.UUID `json:"parentId"`
	}
	if decodeJSON(w, r, &body) != nil {
		writeError(w, http.StatusBadRequest, "댓글 형식이 올바르지 않습니다.")
		return
	}
	body.Body = strings.TrimSpace(body.Body)
	if utf8.RuneCountInString(body.Body) < 1 || utf8.RuneCountInString(body.Body) > 4000 {
		writeError(w, http.StatusBadRequest, "댓글은 1~4,000자로 입력해 주세요.")
		return
	}
	p := principal(r)
	comment, _, err := s.Store.CreateComment(r.Context(), p.User.ID, noteID, body.ParentID, body.Body, mentionedUsernameTokens(body.Body))
	if err != nil {
		status, message := commentCreateError(err)
		if status >= http.StatusInternalServerError {
			slog.Warn("comment create failed", "note_id", noteID, "user_id", p.User.ID, "error", err)
		}
		writeError(w, status, message)
		return
	}
	s.Store.Audit(r.Context(), &p.User.ID, "comment.create", "comment", comment.ID.String(), map[string]any{"noteId": noteID})
	writeJSON(w, http.StatusCreated, comment)
}

func (s *Server) resolveComment(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:write") {
		return
	}
	commentID, ok := parseID(w, r, "commentID")
	if !ok {
		return
	}
	var body struct {
		Resolved bool `json:"resolved"`
	}
	if decodeJSON(w, r, &body) != nil {
		writeError(w, http.StatusBadRequest, "댓글 상태 형식이 올바르지 않습니다.")
		return
	}
	p := principal(r)
	comment, _, err := s.Store.ResolveComment(r.Context(), p.User.ID, commentID, body.Resolved)
	if err != nil {
		writeError(w, http.StatusForbidden, "댓글 상태를 변경할 권한이 없습니다.")
		return
	}
	writeJSON(w, http.StatusOK, comment)
}

func (s *Server) deleteComment(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:write") {
		return
	}
	commentID, ok := parseID(w, r, "commentID")
	if !ok {
		return
	}
	p := principal(r)
	_, err := s.Store.DeleteComment(r.Context(), p.User.ID, commentID)
	if err != nil {
		writeError(w, http.StatusForbidden, "댓글을 삭제할 권한이 없습니다.")
		return
	}
	s.Store.Audit(r.Context(), &p.User.ID, "comment.delete", "comment", commentID.String(), map[string]any{})
	w.WriteHeader(http.StatusNoContent)
}

func parseOptionalTime(value string) (*time.Time, bool) {
	if value == "" {
		return nil, true
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return nil, false
	}
	return &parsed, true
}

func parseOptionalUUID(value string) (*uuid.UUID, bool) {
	if value == "" {
		return nil, true
	}
	parsed, err := uuid.Parse(value)
	if err != nil {
		return nil, false
	}
	return &parsed, true
}

func noteIDFromPath(r *http.Request) string { return chi.URLParam(r, "noteID") }

var _ = store.Comment{}
