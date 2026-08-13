package httpapi

import (
	"net/http"
	"time"

	"github.com/google/uuid"
)

func (s *Server) listNotifications(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	rows, err := s.Store.Pool.Query(r.Context(), `SELECT id,kind,title,body,resource_type,resource_id,read_at,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, p.User.ID)
	if err != nil {
		writeError(w, 500, "알림을 불러오지 못했습니다.")
		return
	}
	defer rows.Close()
	items := []map[string]any{}
	unread := 0
	for rows.Next() {
		var id uuid.UUID
		var kind, title, body, resourceType string
		var resourceID *uuid.UUID
		var readAt *time.Time
		var created time.Time
		if rows.Scan(&id, &kind, &title, &body, &resourceType, &resourceID, &readAt, &created) != nil {
			continue
		}
		if readAt == nil {
			unread++
		}
		items = append(items, map[string]any{"id": id, "kind": kind, "title": title, "body": body, "resourceType": resourceType, "resourceId": resourceID, "readAt": readAt, "createdAt": created})
	}
	writeJSON(w, 200, map[string]any{"notifications": items, "unread": unread})
}
func (s *Server) readNotification(w http.ResponseWriter, r *http.Request) {
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
