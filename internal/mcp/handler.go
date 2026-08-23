package mcp

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/auth"
	"github.com/hkjang/umm/internal/dream"
	"github.com/hkjang/umm/internal/store"
)

const CurrentProtocol = "2026-07-28"

type Handler struct {
	Store   *store.Store
	Dreams  *dream.Service
	Version string
}
type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}
type callParams struct {
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
}
type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("MCP-Protocol-Version", CurrentProtocol)
	if r.Method != http.MethodPost {
		writeRPC(w, response{JSONRPC: "2.0", Error: &rpcError{Code: -32600, Message: "POST required"}})
		return
	}
	p, ok := auth.PrincipalFrom(r.Context())
	if !ok || p.AuthType != "api_key" {
		w.WriteHeader(http.StatusUnauthorized)
		writeRPC(w, response{JSONRPC: "2.0", Error: &rpcError{Code: -32001, Message: "Bearer API key required"}})
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && !h.validOrigin(r, origin) {
		w.WriteHeader(http.StatusForbidden)
		writeRPC(w, response{JSONRPC: "2.0", Error: &rpcError{Code: -32002, Message: "invalid Origin"}})
		return
	}
	var req request
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeRPC(w, response{JSONRPC: "2.0", Error: &rpcError{Code: -32700, Message: "parse error"}})
		return
	}
	if req.JSONRPC != "2.0" {
		writeRPC(w, response{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: -32600, Message: "invalid JSON-RPC version"}})
		return
	}
	protocol := r.Header.Get("MCP-Protocol-Version")
	if protocol == CurrentProtocol {
		if r.Header.Get("Mcp-Method") != req.Method {
			writeRPC(w, response{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: -32600, Message: "Mcp-Method header mismatch"}})
			return
		}
	}
	var result any
	var err error
	switch req.Method {
	case "server/discover":
		result = map[string]any{"protocolVersion": CurrentProtocol, "serverInfo": map[string]string{"name": "umm", "version": h.Version}, "capabilities": map[string]any{"tools": map[string]any{"listChanged": false}}}
	case "initialize":
		result = map[string]any{"protocolVersion": "2025-11-25", "serverInfo": map[string]string{"name": "umm", "version": h.Version}, "capabilities": map[string]any{"tools": map[string]any{"listChanged": false}}}
	case "notifications/initialized":
		w.WriteHeader(http.StatusAccepted)
		return
	case "ping":
		result = map[string]any{}
	case "tools/list":
		result = map[string]any{"tools": toolDefinitions()}
	case "tools/call":
		var params callParams
		if json.Unmarshal(req.Params, &params) != nil {
			err = errors.New("invalid tool arguments")
		} else if protocol == CurrentProtocol && r.Header.Get("Mcp-Name") != params.Name {
			err = errors.New("Mcp-Name header mismatch")
		} else {
			result, err = h.call(r, p, params)
		}
	default:
		writeRPC(w, response{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: -32601, Message: "method not found"}})
		return
	}
	if err != nil {
		writeRPC(w, response{JSONRPC: "2.0", ID: req.ID, Result: map[string]any{"content": []map[string]string{{"type": "text", "text": err.Error()}}, "isError": true}})
		return
	}
	writeRPC(w, response{JSONRPC: "2.0", ID: req.ID, Result: result})
}

func (h *Handler) validOrigin(r *http.Request, origin string) bool {
	var general struct {
		PublicURL string `json:"public_url"`
	}
	if h.Store.GetSetting(r.Context(), "general", &general) != nil {
		return false
	}
	a, err1 := url.Parse(origin)
	b, err2 := url.Parse(general.PublicURL)
	return err1 == nil && err2 == nil && strings.EqualFold(a.Scheme, b.Scheme) && strings.EqualFold(a.Host, b.Host)
}

func toolDefinitions() []map[string]any {
	return []map[string]any{
		{"name": "capture_thought", "title": "Capture a thought", "description": "Write a thought down without deciding where it belongs. It lands in the owner's inbox, ready to be filed later. Use this when you have something worth keeping but no reason to choose a space — create_note is for when you do.", "inputSchema": schema(map[string]any{"content": str("Thought text")}, "content")},
		{"name": "connect_notes", "title": "Connect thoughts", "description": "Connect two notes in the same space. The connection is recorded as written by an agent, which the owner can see; it cannot be presented as one they drew themselves.", "inputSchema": schema(map[string]any{"space_id": str("Space UUID"), "source_note_id": str("Source note UUID"), "target_note_id": str("Target note UUID"), "relation": str("What the connection asserts: related (default), supports, contradicts, refines, expands or follows. Anything else is rejected.")}, "space_id", "source_note_id", "target_note_id")},
		{"name": "create_note", "title": "Drop a thought", "description": "Create a post-it in a space.", "inputSchema": schema(map[string]any{"space_id": str("Space UUID"), "content": str("Thought text"), "x": num("Canvas x"), "y": num("Canvas y"), "color": str("Semantic color")}, "space_id", "content")},
		{"name": "find_contradictions", "title": "Find recorded disagreements", "description": "List thoughts that were recorded as contradicting each other. These are connections a person or an agent drew, not something umm inferred: an empty result means nobody has marked any disagreement, not that the workspace is free of them. Pass space_id to narrow to one space.", "inputSchema": schema(map[string]any{"space_id": str("Space UUID; omit for every space you can read")})},
		{"name": "find_open_questions", "title": "Find unanswered questions", "description": "List thoughts marked as questions that nothing has been recorded as answering. Both halves are marked by a person or an agent, not inferred: umm does not read a note and decide it is asking something. An empty result means nothing is marked open, not that everything has been answered. Pass space_id to narrow to one space.", "inputSchema": schema(map[string]any{"space_id": str("Space UUID; omit for every space you can read")})},
		{"name": "get_connections", "title": "Walk the memory graph", "description": "List the connections attached to a note: what it points at, what points at it, what each connection asserts, and who made it. get_related_notes finds thoughts that merely resemble each other; this returns the connections that were actually recorded, including ones umm inferred, which are marked as such and carry a confidence.", "inputSchema": schema(map[string]any{"note_id": str("Note UUID")}, "note_id")},
		{"name": "get_related_notes", "title": "Discover related thoughts", "description": "Find related notes using the offline similarity embedding.", "inputSchema": schema(map[string]any{"note_id": str("Source note UUID")}, "note_id")},
		{"name": "list_clusters", "title": "List thought clusters", "description": "Discover coherent groups of notes in a space.", "inputSchema": schema(map[string]any{"space_id": str("Space UUID")}, "space_id")},
		{"name": "list_dreams", "title": "List Dream notes", "description": "List the user's recent Dream notes.", "inputSchema": schema(map[string]any{})},
		{"name": "list_notes", "title": "List thoughts", "description": "List notes and connections in one space.", "inputSchema": schema(map[string]any{"space_id": str("Space UUID")}, "space_id")},
		{"name": "list_spaces", "title": "List spaces", "description": "List spaces available to this user.", "inputSchema": schema(map[string]any{})},
		{"name": "search_notes", "title": "Search thoughts", "description": "Search notes in one space.", "inputSchema": schema(map[string]any{"space_id": str("Space UUID"), "query": str("Search text")}, "space_id", "query")},
	}
}
func str(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}
func num(description string) map[string]any {
	return map[string]any{"type": "number", "description": description}
}
func schema(properties map[string]any, required ...string) map[string]any {
	return map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}
}

func (h *Handler) call(r *http.Request, p auth.Principal, params callParams) (any, error) {
	ctx := r.Context()
	args := params.Arguments
	success := func(v any) (any, error) {
		raw, _ := json.Marshal(v)
		return map[string]any{"content": []map[string]string{{"type": "text", "text": string(raw)}}, "structuredContent": v, "isError": false}, nil
	}
	require := func(scope string) error {
		if !p.Scopes["*"] && !p.Scopes[scope] {
			return fmt.Errorf("API key requires %s scope", scope)
		}
		return nil
	}
	spaceID := func() (uuid.UUID, error) { return uuid.Parse(fmt.Sprint(args["space_id"])) }
	switch params.Name {
	case "list_spaces":
		if err := require("spaces:read"); err != nil {
			return nil, err
		}
		v, err := h.Store.ListSpaces(ctx, p.User.ID)
		if err != nil {
			return nil, err
		}
		return success(map[string]any{"spaces": v})
	case "list_notes", "search_notes":
		if err := require("notes:read"); err != nil {
			return nil, err
		}
		sid, err := spaceID()
		if err != nil {
			return nil, errors.New("valid space_id required")
		}
		query := ""
		if params.Name == "search_notes" {
			query = fmt.Sprint(args["query"])
		}
		notes, edges, err := h.Store.ListNotes(ctx, p.User.ID, sid, query)
		if err != nil {
			return nil, err
		}
		return success(map[string]any{"notes": notes, "edges": edges})
	case "get_related_notes":
		if err := require("notes:read"); err != nil {
			return nil, err
		}
		noteID, err := uuid.Parse(fmt.Sprint(args["note_id"]))
		if err != nil {
			return nil, errors.New("valid note_id required")
		}
		related, err := h.Store.RelatedNotes(ctx, p.User.ID, noteID, 8)
		if err != nil {
			return nil, err
		}
		return success(map[string]any{"related": related})
	case "list_clusters":
		if err := require("notes:read"); err != nil {
			return nil, err
		}
		sid, err := spaceID()
		if err != nil {
			return nil, errors.New("valid space_id required")
		}
		clusters, err := h.Store.Clusters(ctx, p.User.ID, sid)
		if err != nil {
			return nil, err
		}
		return success(map[string]any{"clusters": clusters})
	case "create_note":
		if err := require("notes:write"); err != nil {
			return nil, err
		}
		sid, err := spaceID()
		if err != nil {
			return nil, errors.New("valid space_id required")
		}
		content := strings.TrimSpace(fmt.Sprint(args["content"]))
		if content == "" {
			return nil, errors.New("content required")
		}
		n := store.Note{SpaceID: sid, Content: content, Source: "mcp", Color: valueString(args, "color", "yellow"), X: valueFloat(args, "x"), Y: valueFloat(args, "y")}
		n, err = h.Store.CreateNote(ctx, p.User.ID, n)
		if err != nil {
			return nil, err
		}
		h.Store.Audit(ctx, &p.User.ID, "mcp.note.create", "note", n.ID.String(), map[string]any{"key": true})
		return success(n)
	case "capture_thought":
		if err := require("notes:write"); err != nil {
			return nil, err
		}
		content := valueString(args, "content", "")
		if strings.TrimSpace(content) == "" {
			return nil, errors.New("content required")
		}
		n, err := h.Store.CaptureThought(ctx, p.User.ID, content)
		if err != nil {
			return nil, err
		}
		h.Store.Audit(ctx, &p.User.ID, "mcp.thought.capture", "note", n.ID.String(), map[string]any{"key": true})
		return success(n)
	case "connect_notes":
		if err := require("notes:write"); err != nil {
			return nil, err
		}
		sid, err := spaceID()
		if err != nil {
			return nil, errors.New("valid space_id required")
		}
		source, err := uuid.Parse(fmt.Sprint(args["source_note_id"]))
		if err != nil {
			return nil, errors.New("valid source_note_id required")
		}
		target, err := uuid.Parse(fmt.Sprint(args["target_note_id"]))
		if err != nil {
			return nil, errors.New("valid target_note_id required")
		}
		e, err := h.Store.CreateAgentEdge(ctx, p.User.ID, store.Edge{SpaceID: sid, SourceID: source, TargetID: target,
			Relation: store.Relation(valueString(args, "relation", string(store.RelationRelated)))})
		if err != nil {
			return nil, err
		}
		return success(e)
	case "find_contradictions":
		if err := require("notes:read"); err != nil {
			return nil, err
		}
		var scope *uuid.UUID
		if raw := valueString(args, "space_id", ""); strings.TrimSpace(raw) != "" {
			parsed, parseErr := uuid.Parse(raw)
			if parseErr != nil {
				return nil, errors.New("valid space_id required")
			}
			scope = &parsed
		}
		items, err := h.Store.Contradictions(ctx, p.User.ID, scope)
		if err != nil {
			return nil, err
		}
		found := make([]map[string]any, 0, len(items))
		for _, item := range items {
			found = append(found, map[string]any{
				"space":           item.Space,
				"recorded_by":     item.Origin,
				"claim_note_id":   item.Claim.ID,
				"claim":           item.Claim.Content,
				"counter_note_id": item.Counter.ID,
				"counter":         item.Counter.Content,
			})
		}
		return success(map[string]any{"contradictions": found})
	case "find_open_questions":
		if err := require("notes:read"); err != nil {
			return nil, err
		}
		var scope *uuid.UUID
		if raw := valueString(args, "space_id", ""); strings.TrimSpace(raw) != "" {
			parsed, parseErr := uuid.Parse(raw)
			if parseErr != nil {
				return nil, errors.New("valid space_id required")
			}
			scope = &parsed
		}
		questions, err := h.Store.OpenQuestions(ctx, p.User.ID, scope)
		if err != nil {
			return nil, err
		}
		open := make([]map[string]any, 0, len(questions))
		for _, item := range questions {
			open = append(open, map[string]any{
				"note_id":  item.Note.ID,
				"question": item.Note.Content,
				"space":    item.Space,
				// Connections that circle the question without settling it.
				"attempts": item.Attempts,
			})
		}
		return success(map[string]any{"open_questions": open})
	case "get_connections":
		if err := require("notes:read"); err != nil {
			return nil, err
		}
		noteID, err := uuid.Parse(fmt.Sprint(args["note_id"]))
		if err != nil {
			return nil, errors.New("valid note_id required")
		}
		links, err := h.Store.Backlinks(ctx, p.User.ID, noteID)
		if err != nil {
			return nil, err
		}
		// Flattened deliberately: an agent reading this needs the assertion and
		// its provenance next to the thought, not a nested edge object to unpack.
		connections := make([]map[string]any, 0, len(links))
		for _, link := range links {
			connection := map[string]any{
				"direction": link.Direction,
				"relation":  link.Edge.Relation,
				"origin":    link.Edge.Origin,
				"inferred":  link.Edge.Origin.Inferred(),
				"note_id":   link.Note.ID,
				"content":   link.Note.Content,
			}
			if link.Edge.Confidence != nil {
				connection["confidence"] = *link.Edge.Confidence
			}
			connections = append(connections, connection)
		}
		return success(map[string]any{"connections": connections})
	case "list_dreams":
		if err := require("dreams:read"); err != nil {
			return nil, err
		}
		v, err := h.Dreams.History(ctx, p.User.ID)
		if err != nil {
			return nil, err
		}
		return success(map[string]any{"dreams": v})
	default:
		return nil, errors.New("unknown tool")
	}
}

func valueString(m map[string]any, key, fallback string) string {
	v := strings.TrimSpace(fmt.Sprint(m[key]))
	if v == "" || v == "<nil>" {
		return fallback
	}
	return v
}
func valueFloat(m map[string]any, key string) float64 { v, _ := m[key].(float64); return v }
func writeRPC(w http.ResponseWriter, v response)      { _ = json.NewEncoder(w).Encode(v) }
