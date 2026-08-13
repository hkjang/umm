package httpapi

import (
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
)

func (s *Server) exportAllowed(r *http.Request, spaceID, userID uuid.UUID) bool {
	var cfg workflowConfig
	_ = s.Store.GetSetting(r.Context(), "workflow", &cfg)
	if !cfg.Enabled || !slices.Contains(cfg.Actions, "export") {
		return true
	}
	var allowed bool
	_ = s.Store.Pool.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM approval_requests WHERE requester_id=$1 AND resource_type='space' AND resource_id=$2 AND action='export' AND status='approved' AND reviewed_at>now()-interval '24 hours')`, userID, spaceID).Scan(&allowed)
	return allowed
}

func (s *Server) authorizeExport(w http.ResponseWriter, r *http.Request) {
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
	if !s.exportAllowed(r, spaceID, p.User.ID) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "팀장 승인이 필요합니다.", "code": "approval_required"})
		return
	}
	format := r.URL.Query().Get("format")
	if format == "" {
		format = "unknown"
	}
	s.Store.Audit(r.Context(), &p.User.ID, "space.export.authorize", "space", spaceID.String(), map[string]any{"format": format})
	writeJSON(w, 200, map[string]bool{"allowed": true})
}

func (s *Server) exportMarkdown(w http.ResponseWriter, r *http.Request) {
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
	if !s.exportAllowed(r, spaceID, p.User.ID) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "팀장 승인이 필요합니다.", "code": "approval_required"})
		return
	}
	notes, edges, err := s.Store.ListNotes(r.Context(), p.User.ID, spaceID, "")
	if err != nil {
		writeError(w, 500, "내보낼 생각을 불러오지 못했습니다.")
		return
	}
	var spaceName string
	_ = s.Store.Pool.QueryRow(r.Context(), `SELECT name FROM spaces WHERE id=$1`, spaceID).Scan(&spaceName)
	var out strings.Builder
	fmt.Fprintf(&out, "# %s\n\nExported from umm at %s.\n\n", spaceName, time.Now().Format(time.RFC3339))
	for _, n := range notes {
		title := strings.TrimSpace(n.Title)
		if title == "" {
			title = "Thought"
		}
		fmt.Fprintf(&out, "## %s\n\n%s\n\n- id: `%s`\n- type: `%s`\n- source: `%s`\n- canvas: `%.0f, %.0f`\n\n", title, n.Content, n.ID, n.Kind, n.Source, n.X, n.Y)
	}
	if len(edges) > 0 {
		out.WriteString("## Connections\n\n")
		for _, e := range edges {
			fmt.Fprintf(&out, "- `%s` --%s--> `%s`\n", e.SourceID, e.Relation, e.TargetID)
		}
	}
	filename := strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == '\n' || r == '\r' {
			return '-'
		}
		return r
	}, spaceName)
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="umm-%s.md"`, filename))
	s.Store.Audit(r.Context(), &p.User.ID, "space.export", "space", spaceID.String(), map[string]any{"format": "markdown"})
	_, _ = w.Write([]byte(out.String()))
}
