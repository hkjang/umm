package httpapi

import (
	"net/http"
	"time"

	"github.com/google/uuid"
)

func (s *Server) listNotifications(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:read") {
		return
	}
	p := principal(r)
	offset, ok := decodeOffsetCursor(r.URL.Query().Get("cursor"))
	if !ok {
		writeError(w, 400, "알림 커서가 올바르지 않습니다.")
		return
	}
	limit := parsePageLimit(r, 30, 100)
	rows, err := s.Store.Pool.Query(r.Context(), `SELECT id,kind,title,body,resource_type,resource_id,resource_space_id,metadata,read_at,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`, p.User.ID, limit+1, offset)
	if err != nil {
		writeError(w, 500, "알림을 불러오지 못했습니다.")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	var unread int64
	if err := s.Store.Pool.QueryRow(r.Context(), `SELECT count(*) FROM notifications WHERE user_id=$1 AND read_at IS NULL`, p.User.ID).Scan(&unread); err != nil {
		writeError(w, 500, "읽지 않은 알림 수를 불러오지 못했습니다.")
		return
	}
	for rows.Next() {
		var id uuid.UUID
		var kind, title, body, resourceType string
		var resourceID, resourceSpaceID *uuid.UUID
		var metadata map[string]any
		var readAt *time.Time
		var created time.Time
		if err := rows.Scan(&id, &kind, &title, &body, &resourceType, &resourceID, &resourceSpaceID, &metadata, &readAt, &created); err != nil {
			writeError(w, 500, "알림을 읽지 못했습니다.")
			return
		}
		items = append(items, map[string]any{"id": id, "kind": kind, "title": title, "body": body, "resourceType": resourceType, "resourceId": resourceID, "resourceSpaceId": resourceSpaceID, "metadata": metadata, "readAt": readAt, "createdAt": created})
	}
	if err := rows.Err(); err != nil {
		writeError(w, 500, "알림을 불러오지 못했습니다.")
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = encodeOffsetCursor(offset + limit)
	}
	writeJSON(w, 200, map[string]any{"notifications": items, "unread": unread, "nextCursor": next})
}
func (s *Server) readNotification(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:read") {
		return
	}
	id, ok := parseID(w, r, "notificationID")
	if !ok {
		return
	}
	p := principal(r)
	cmd, err := s.Store.Pool.Exec(r.Context(), `UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2`, id, p.User.ID)
	if err != nil || cmd.RowsAffected() == 0 {
		writeError(w, 404, "알림을 찾을 수 없습니다.")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
