package httpapi

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/store"
	"github.com/jackc/pgx/v5"
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
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, 404, "공간을 찾을 수 없습니다.")
			return
		}
		writeError(w, 500, "내보낼 생각을 불러오지 못했습니다.")
		return
	}
	var spaceName string
	if err := s.Store.Pool.QueryRow(r.Context(), `
		SELECT sp.name FROM spaces sp
		LEFT JOIN space_members sm ON sm.space_id=sp.id AND sm.user_id=$2
		WHERE sp.id=$1 AND (sp.owner_id=$2 OR sm.user_id=$2)`, spaceID, p.User.ID).Scan(&spaceName); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, 404, "공간을 찾을 수 없습니다.")
			return
		}
		slog.Warn("export space access recheck failed", "space_id", spaceID, "user_id", p.User.ID, "error", err)
		writeError(w, 500, "내보낼 공간을 확인하지 못했습니다.")
		return
	}
	// Lines of thinking travel with the export for the same reason edge origins
	// do. A thought that was tried and set aside reads exactly like a current one
	// once the label is gone, and the reason it was set aside is the half people
	// lose first — losing it at the moment someone takes their record elsewhere
	// is the worst possible time.
	branches, err := s.Store.ListBranches(r.Context(), p.User.ID, spaceID)
	if err != nil {
		slog.Warn("export could not read lines of thinking", "space_id", spaceID, "error", err)
		writeError(w, 500, "내보낼 갈래를 불러오지 못했습니다.")
		return
	}
	assignments, err := s.Store.BranchAssignments(r.Context(), p.User.ID, spaceID)
	if err != nil {
		slog.Warn("export could not read line membership", "space_id", spaceID, "error", err)
		writeError(w, 500, "내보낼 갈래를 불러오지 못했습니다.")
		return
	}
	byID := make(map[uuid.UUID]store.Branch, len(branches))
	for _, branch := range branches {
		byID[branch.ID] = branch
	}

	var out strings.Builder
	fmt.Fprintf(&out, "# %s\n\nExported from umm at %s.\n\n", spaceName, time.Now().Format(time.RFC3339))
	for _, n := range notes {
		title := strings.TrimSpace(n.Title)
		if title == "" {
			title = "Thought"
		}
		fmt.Fprintf(&out, "## %s\n\n%s\n\n- id: `%s`\n- type: `%s`\n- source: `%s`\n- color: `%s`\n- canvas: `%.0f, %.0f`\n", title, n.Content, n.ID, n.Kind, n.Source, n.Color, n.X, n.Y)
		if branch, ok := byID[assignments[n.ID]]; ok {
			fmt.Fprintf(&out, "- line: `%s` (%s)\n", branch.Name, branch.Status)
		}
		out.WriteString("\n")
	}
	if len(edges) > 0 {
		out.WriteString("## Connections\n\n")
		for _, e := range edges {
			// An export is what someone keeps when umm is gone, so it has to say
			// which connections a person drew and which the software produced.
			// Without the origin the two are indistinguishable on the page.
			origin := ""
			if e.Origin != store.OriginManual {
				origin = fmt.Sprintf(" (%s)", e.Origin)
			}
			// The why goes with the line. It is the part that disappears first
			// from anybody's memory, so an export that kept the connection and
			// dropped the reason would keep the half that can be reconstructed
			// and lose the half that cannot.
			reason := ""
			if e.Reason != "" {
				reason = " — " + strings.ReplaceAll(e.Reason, "\n", " ")
			}
			fmt.Fprintf(&out, "- `%s` --%s--> `%s`%s%s\n", e.SourceID, e.Relation, e.TargetID, origin, reason)
		}
	}
	if len(branches) > 0 {
		out.WriteString("## Lines of thinking\n\n")
		for _, branch := range branches {
			fmt.Fprintf(&out, "- **%s** — %s", branch.Name, branch.Status)
			if strings.TrimSpace(branch.Resolution) != "" {
				fmt.Fprintf(&out, ": %s", branch.Resolution)
			}
			out.WriteString("\n")
		}
		out.WriteString("\n")
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
