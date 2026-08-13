package httpapi

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

func (s *Server) publishSpaceEvent(r *http.Request, spaceID uuid.UUID, eventType string, resourceID uuid.UUID, payload any) {
	p := principal(r)
	raw, _ := json.Marshal(payload)
	var resource any = resourceID
	if resourceID == uuid.Nil {
		resource = nil
	}
	tag, err := s.Store.Pool.Exec(r.Context(), `INSERT INTO space_events(space_id,actor_id,event_type,resource_id,payload) VALUES($1,$2,$3,$4,$5)`, spaceID, p.User.ID, eventType, resource, raw)
	if err != nil {
		slog.Warn("space event publish failed", "space_id", spaceID, "event_type", eventType, "error", err)
	} else if tag.RowsAffected() != 1 {
		slog.Warn("space event was not stored", "space_id", spaceID, "event_type", eventType)
	}
}

func (s *Server) spaceEvents(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:read") {
		return
	}
	spaceID, ok := parseID(w, r, "spaceID")
	if !ok {
		return
	}
	p := principal(r)
	if !s.Store.CanViewSpace(r.Context(), p.User.ID, spaceID) {
		writeError(w, 404, "공간을 찾을 수 없습니다.")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, 500, "실시간 전송을 지원하지 않습니다.")
		return
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Time{})
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	last, _ := strconv.ParseInt(r.Header.Get("Last-Event-ID"), 10, 64)
	if queryLast, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64); queryLast > last {
		last = queryLast
	}
	if last == 0 && r.Header.Get("Last-Event-ID") == "" && r.URL.Query().Get("after") == "" {
		_ = s.Store.Pool.QueryRow(r.Context(), `SELECT COALESCE(max(sequence),0) FROM space_events WHERE space_id=$1`, spaceID).Scan(&last)
	}
	ticker := time.NewTicker(time.Second)
	heartbeat := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	defer heartbeat.Stop()
	fmt.Fprint(w, ": umm collaboration stream\n\n")
	flusher.Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		case <-ticker.C:
			rows, err := s.Store.Pool.Query(r.Context(), `SELECT sequence,event_type,resource_id,payload,actor_id,created_at FROM space_events WHERE space_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 100`, spaceID, last)
			if err != nil {
				continue
			}
			for rows.Next() {
				var sequence int64
				var typ string
				var resource, actor *uuid.UUID
				var payload json.RawMessage
				var created time.Time
				if rows.Scan(&sequence, &typ, &resource, &payload, &actor, &created) != nil {
					continue
				}
				event, _ := json.Marshal(map[string]any{"sequence": sequence, "type": typ, "resourceId": resource, "actorId": actor, "payload": payload, "createdAt": created})
				fmt.Fprintf(w, "id: %d\nevent: space-change\ndata: %s\n\n", sequence, event)
				last = sequence
			}
			rows.Close()
			flusher.Flush()
		}
	}
}

func (s *Server) listSpaceMembers(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "spaces:read") {
		return
	}
	spaceID, ok := parseID(w, r, "spaceID")
	if !ok {
		return
	}
	p := principal(r)
	if !s.Store.CanViewSpace(r.Context(), p.User.ID, spaceID) {
		writeError(w, 404, "공간을 찾을 수 없습니다.")
		return
	}
	rows, err := s.Store.Pool.Query(r.Context(), `SELECT u.id,u.username,u.display_name,COALESCE(u.email,''),'owner'::text FROM spaces sp JOIN users u ON u.id=sp.owner_id WHERE sp.id=$1 UNION ALL SELECT u.id,u.username,u.display_name,COALESCE(u.email,''),sm.permission FROM space_members sm JOIN users u ON u.id=sm.user_id WHERE sm.space_id=$1 ORDER BY 5,3`, spaceID)
	if err != nil {
		writeError(w, 500, "공유 사용자를 불러오지 못했습니다.")
		return
	}
	defer rows.Close()
	members := []map[string]any{}
	for rows.Next() {
		var id uuid.UUID
		var username, name, email, permission string
		if rows.Scan(&id, &username, &name, &email, &permission) == nil {
			members = append(members, map[string]any{"id": id, "username": username, "displayName": name, "email": email, "permission": permission})
		}
	}
	writeJSON(w, 200, map[string]any{"members": members, "canManage": s.canManageSpace(r, p.User.ID, spaceID)})
}

func (s *Server) canManageSpace(r *http.Request, userID, spaceID uuid.UUID) bool {
	var ok bool
	_ = s.Store.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM spaces sp LEFT JOIN space_members sm ON sm.space_id=sp.id AND sm.user_id=$1 WHERE sp.id=$2 AND (sp.owner_id=$1 OR sm.permission='manage'))`, userID, spaceID).Scan(&ok)
	return ok
}

func (s *Server) shareSpace(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:write") {
		return
	}
	spaceID, ok := parseID(w, r, "spaceID")
	if !ok {
		return
	}
	p := principal(r)
	if !s.canManageSpace(r, p.User.ID, spaceID) {
		writeError(w, 403, "공간 공유를 관리할 권한이 없습니다.")
		return
	}
	var body struct {
		Username   string `json:"username"`
		Permission string `json:"permission"`
	}
	if decodeJSON(w, r, &body) != nil || !slices.Contains([]string{"view", "edit", "manage"}, body.Permission) {
		writeError(w, 400, "공유 설정이 올바르지 않습니다.")
		return
	}
	var targetID uuid.UUID
	var targetName string
	if err := s.Store.Pool.QueryRow(r.Context(), `SELECT id,display_name FROM users WHERE username=$1 AND active`, strings.TrimSpace(body.Username)).Scan(&targetID, &targetName); err != nil {
		writeError(w, 404, "활성 사용자를 찾을 수 없습니다.")
		return
	}
	if targetID == p.User.ID {
		writeError(w, 400, "자기 자신을 공유 사용자로 추가할 수 없습니다.")
		return
	}
	payload := map[string]any{"targetUserId": targetID, "permission": body.Permission, "targetName": targetName}
	var cfg workflowConfig
	_ = s.Store.GetSetting(r.Context(), "workflow", &cfg)
	if cfg.Enabled && slices.Contains(cfg.Actions, "space_share") {
		raw, _ := json.Marshal(payload)
		var requestID uuid.UUID
		err := s.Store.Pool.QueryRow(r.Context(), `INSERT INTO approval_requests(requester_id,team_id,resource_type,resource_id,action,comment,payload) VALUES($1,$2,'space',$3,'space_share',$4,$5) RETURNING id`, p.User.ID, p.User.TeamID, spaceID, "공간 공유: "+targetName+" ("+body.Permission+")", raw).Scan(&requestID)
		if err != nil {
			writeError(w, 500, "공유 승인 요청을 만들지 못했습니다.")
			return
		}
		s.Store.Audit(r.Context(), &p.User.ID, "space.share.request", "approval", requestID.String(), payload)
		writeJSON(w, 202, map[string]any{"required": true, "requestId": requestID, "status": "pending"})
		return
	}
	if err := s.applySpaceShare(r, spaceID, targetID, body.Permission); err != nil {
		writeError(w, 500, "공간을 공유하지 못했습니다.")
		return
	}
	s.Store.Audit(r.Context(), &p.User.ID, "space.share", "space", spaceID.String(), payload)
	s.publishSpaceEvent(r, spaceID, "member.updated", targetID, payload)
	writeJSON(w, 201, map[string]any{"required": false, "status": "shared"})
}

func (s *Server) applySpaceShare(r *http.Request, spaceID, targetID uuid.UUID, permission string) error {
	_, err := s.Store.Pool.Exec(r.Context(), `INSERT INTO space_members(space_id,user_id,permission) VALUES($1,$2,$3) ON CONFLICT(space_id,user_id) DO UPDATE SET permission=EXCLUDED.permission`, spaceID, targetID, permission)
	if err == nil {
		_, _ = s.Store.Pool.Exec(r.Context(), `INSERT INTO notifications(user_id,kind,title,body,resource_type,resource_id) VALUES($1,'space_shared','새 공간이 공유되었습니다','공유된 공간을 열어 생각을 함께 발전시켜 보세요.','space',$2)`, targetID, spaceID)
	}
	return err
}

func (s *Server) removeSpaceMember(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:write") {
		return
	}
	spaceID, ok := parseID(w, r, "spaceID")
	if !ok {
		return
	}
	memberID, ok := parseID(w, r, "memberID")
	if !ok {
		return
	}
	p := principal(r)
	if !s.canManageSpace(r, p.User.ID, spaceID) {
		writeError(w, 403, "공간 공유를 관리할 권한이 없습니다.")
		return
	}
	cmd, err := s.Store.Pool.Exec(r.Context(), `DELETE FROM space_members WHERE space_id=$1 AND user_id=$2`, spaceID, memberID)
	if err != nil || cmd.RowsAffected() == 0 {
		writeError(w, 404, "공유 사용자를 찾을 수 없습니다.")
		return
	}
	s.publishSpaceEvent(r, spaceID, "member.removed", memberID, map[string]any{})
	s.Store.Audit(r.Context(), &p.User.ID, "space.unshare", "space", spaceID.String(), map[string]any{"userId": memberID})
	w.WriteHeader(http.StatusNoContent)
}
