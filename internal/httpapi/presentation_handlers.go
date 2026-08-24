package httpapi

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/presentation"
	"github.com/hkjang/umm/internal/store"
	"github.com/jackc/pgx/v5"
)

// Turning a space into a talk.
//
// Three things a person does: see what their space would become, make the
// deck, and later ask where a slide's sentences came from. The first must
// change nothing, which is why it is a GET and reaches neither Ptium's
// database nor umm's.

// presentations returns the service, built from the store each time so the
// Ptium address and credential are read fresh rather than cached past a change.
func (s *Server) presentations() *presentation.Service {
	return &presentation.Service{Spaces: s.Store, Links: s.Store, Settings: s.Store, Cipher: s.Cipher}
}

// presentationRequest is what a caller may ask for.
type presentationRequest struct {
	Title string `json:"title"`
	// NoteIDs restricts the deck to a selection, so a cluster or a few chosen
	// thoughts can become a talk without the rest of the space.
	NoteIDs []uuid.UUID `json:"noteIds"`
	// IncludeExcluded overrides the note-level "keep this out of analysis" mark.
	// It has to be asked for: a thought held back is being held back from having
	// things done to it, and putting it on a slide is one of those things.
	IncludeExcluded bool `json:"includeExcluded"`
	// DeckID, when given, has Ptium check the compiled source against a deck
	// that already exists. Nothing is written either way.
	DeckID string `json:"deckId"`
}

func (s *Server) previewPresentation(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:read") {
		return
	}
	spaceID, ok := parseID(w, r, "spaceID")
	if !ok {
		return
	}
	req := presentation.Request{
		SpaceID:         spaceID,
		Title:           r.URL.Query().Get("title"),
		IncludeExcluded: r.URL.Query().Get("includeExcluded") == "true",
	}

	svc := s.presentations()
	deckID := r.URL.Query().Get("deckId")
	preview, err := presentation.Preview{}, error(nil)
	if deckID != "" {
		preview, err = svc.PreviewAgainst(r.Context(), principal(r).User.ID, req, deckID)
	} else {
		preview, err = svc.Preview(r.Context(), principal(r).User.ID, req)
	}
	if err != nil {
		writePresentationError(w, err, "발표 구성을 만들지 못했습니다.")
		return
	}
	writeJSON(w, 200, preview)
}

func (s *Server) createPresentation(w http.ResponseWriter, r *http.Request) {
	// notes:write rather than notes:read: this sends the person's thoughts to
	// another service and creates something there. A key that may only read
	// must not be able to do that.
	if !requireScope(w, r, "notes:write") {
		return
	}
	spaceID, ok := parseID(w, r, "spaceID")
	if !ok {
		return
	}
	var body presentationRequest
	if r.ContentLength > 0 {
		if decodeJSON(w, r, &body) != nil {
			return
		}
	}

	result, err := s.presentations().Create(r.Context(), principal(r).User.ID, presentation.Request{
		SpaceID:         spaceID,
		Title:           body.Title,
		Only:            body.NoteIDs,
		IncludeExcluded: body.IncludeExcluded,
	})
	if err != nil {
		writePresentationError(w, err, "발표 자료를 만들지 못했습니다.")
		return
	}
	writeJSON(w, 201, result)
}

func (s *Server) listPresentations(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:read") {
		return
	}
	spaceID, ok := parseID(w, r, "spaceID")
	if !ok {
		return
	}
	links, err := s.Store.ListPresentationLinks(r.Context(), principal(r).User.ID, spaceID)
	if err != nil {
		writeError(w, 500, "발표 자료 목록을 불러오지 못했습니다.")
		return
	}
	writeJSON(w, 200, map[string]any{"presentations": s.withDeckURLs(r, links)})
}

// deckLink is a stored link plus where the deck can be opened.
type deckLink struct {
	store.PresentationLink
	// URL is computed on every read and never stored. An administrator who
	// moves Ptium would otherwise leave every past link pointing at an address
	// that no longer answers, with no way to tell which ones were stale.
	URL string `json:"url,omitempty"`
}

func (s *Server) withDeckURLs(r *http.Request, links []store.PresentationLink) []deckLink {
	var cfg presentation.Config
	// A missing or unreadable setting is not an error here: the list is still
	// worth showing, just without somewhere to click through to.
	_ = s.Store.GetSetting(r.Context(), "ptium", &cfg)
	base := strings.TrimRight(strings.TrimSpace(cfg.BaseURL), "/")

	out := make([]deckLink, 0, len(links))
	for _, link := range links {
		row := deckLink{PresentationLink: link}
		if base != "" && link.PtiumID != "" {
			row.URL = base + "/presentations/" + url.PathEscape(link.PtiumID) + "/editor"
		}
		out = append(out, row)
	}
	return out
}

// presentationSources answers "where did this slide's sentences come from".
//
// The question that matters most about a deck made this way, because the
// slides carry the person's own words: being able to get back to the note is
// being able to check that nothing was put in their mouth.
func (s *Server) presentationSources(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:read") {
		return
	}
	linkID, ok := parseID(w, r, "linkID")
	if !ok {
		return
	}
	userID := principal(r).User.ID
	sources, err := s.Store.PresentationSources(r.Context(), userID, linkID)
	if err != nil {
		writeError(w, 500, "슬라이드 출처를 불러오지 못했습니다.")
		return
	}
	source, err := s.Store.PresentationLinkSource(r.Context(), userID, linkID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, 404, "발표 자료를 찾을 수 없습니다.")
			return
		}
		writeError(w, 500, "슬라이드 출처를 불러오지 못했습니다.")
		return
	}
	writeJSON(w, 200, map[string]any{"sources": sources, "source": source})
}

// notePresentations answers the other direction: which talks quote this
// thought. Someone about to edit a note that two decks quote is making a
// different decision from someone editing one nobody has used.
func (s *Server) notePresentations(w http.ResponseWriter, r *http.Request) {
	if !requireScope(w, r, "notes:read") {
		return
	}
	noteID, ok := parseID(w, r, "noteID")
	if !ok {
		return
	}
	links, err := s.Store.PresentationsUsingNote(r.Context(), principal(r).User.ID, noteID)
	if err != nil {
		writeError(w, 500, "이 생각이 쓰인 발표 자료를 불러오지 못했습니다.")
		return
	}
	writeJSON(w, 200, map[string]any{"presentations": s.withDeckURLs(r, links)})
}

// writePresentationError turns the service's errors into the right status.
//
// Each of these is something a person can act on, and answering 500 for all of
// them would tell them only that it broke — when the actual answers are
// "connect Ptium", "there is nothing here yet" and "Ptium said no".
func writePresentationError(w http.ResponseWriter, err error, fallback string) {
	switch {
	case errors.Is(err, presentation.ErrNotConfigured):
		writeError(w, 409, "Ptium이 연결되어 있지 않습니다. 서비스 관리자에서 주소를 설정해 주세요.")
	case errors.Is(err, presentation.ErrNothingToPresent):
		writeError(w, 400, "발표로 만들 생각이 없습니다.")
	case errors.Is(err, pgx.ErrNoRows):
		writeError(w, 404, "공간을 찾을 수 없습니다.")
	default:
		writeError(w, 502, fallback+" "+err.Error())
	}
}
