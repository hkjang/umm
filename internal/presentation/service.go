package presentation

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/store"
)

/*
Turning a space into a deck, end to end.

Preview compiles and shows; Create makes the deck. Someone looking at what
their space would become must not thereby change anything — not their space,
not Ptium — so the preview paths never write a link, never create a deck, and
pass dryRun down when they do reach Ptium at all.

The dependencies are interfaces rather than the concrete store and client so
that the orchestration — the order of the calls, what happens when one fails,
what gets recorded either way — can be tested without a database or a live
Ptium. The parts that genuinely need those have their own tests elsewhere.
*/

// Spaces is the part of the store this needs to read a space.
type Spaces interface {
	ListNotes(ctx context.Context, userID, spaceID uuid.UUID, query string) ([]store.Note, []store.Edge, error)
	ListSpaces(ctx context.Context, userID uuid.UUID) ([]store.Space, error)
}

// Links is the part of the store this needs to record what happened.
type Links interface {
	CreatePresentationLink(ctx context.Context, userID, spaceID uuid.UUID, ptiumID, title string) (store.PresentationLink, error)
	CompletePresentationLink(ctx context.Context, userID, linkID uuid.UUID, status, source string, sources []store.SlideSource, thoughtCount, excludedCount int, failure string) error
}

// Settings reads umm's configuration.
type Settings interface {
	GetSetting(ctx context.Context, key string, dst any) error
}

// Ptium is what the service needs from a Ptium installation.
type Ptium interface {
	CreateDeck(ctx context.Context, title, templateID, language string) (Deck, error)
	ApplySource(ctx context.Context, deckID, source string, dryRun bool) (ApplyResult, error)
}

// Config is umm's `ptium` settings section.
type Config struct {
	BaseURL        string `json:"base_url"`
	APIKey         string `json:"api_key"`
	TemplateID     string `json:"template_id"`
	Language       string `json:"language"`
	TimeoutSeconds int    `json:"timeout_seconds"`
}

// Service compiles spaces into decks.
type Service struct {
	Spaces   Spaces
	Links    Links
	Settings Settings
	// NewPtium builds a client from the configured address. Injected so a test
	// can hand back a stub without standing up an HTTP server, and so the
	// credential is read at call time rather than cached past a rotation.
	NewPtium func(cfg Config) (Ptium, error)
}

// Request is what a person asked for.
type Request struct {
	SpaceID uuid.UUID
	// Title overrides the space's name.
	Title string
	// Only restricts the deck to a selection, so a cluster or a few chosen
	// thoughts can become a talk without the rest of the space.
	Only []uuid.UUID
	// IncludeExcluded overrides the note-level mark. Off unless asked.
	IncludeExcluded bool
}

// Preview is what a space would become, without anything having happened.
type Preview struct {
	Storyline Storyline `json:"storyline"`
	Source    string    `json:"source"`
	// SlideCount and Warnings come from Ptium compiling against the real
	// template, so a preview is measured rather than guessed. They are absent
	// when no Ptium is configured, which is not an error: the storyline is
	// still worth showing.
	SlideCount int      `json:"slideCount"`
	Warnings   []string `json:"warnings"`
	// Checked says whether Ptium actually saw this. Without it a preview with
	// no warnings and one that was never checked look identical.
	Checked bool `json:"checked"`
}

// Result is a deck that now exists.
type Result struct {
	Link     store.PresentationLink `json:"link"`
	Warnings []string               `json:"warnings"`
}

// ErrNothingToPresent is returned when a space has no thought that could reach
// a slide, so the API answers 400 rather than making an empty deck.
var ErrNothingToPresent = errors.New("nothing in this space can become a talk")

// Preview compiles the space and, if Ptium is configured, asks it what would
// happen. Nothing is written and no deck is created.
func (s *Service) Preview(ctx context.Context, userID uuid.UUID, req Request) (Preview, error) {
	story, source, err := s.compile(ctx, userID, req)
	if err != nil {
		return Preview{}, err
	}
	// Checked stays false, and that is not a shortcoming to be papered over.
	// Ptium can only dry-run source against a deck, because the template is
	// what decides whether a slide fits, and it has no endpoint that validates
	// source without one. Creating a throwaway deck to check against would
	// leave litter in Ptium every time someone looked at a preview.
	//
	// So a first preview shows umm's own work: the order, the grouping, and the
	// person's own sentences. That is the part they are there to review. Use
	// PreviewAgainst once a deck exists to have Ptium measure it.
	return Preview{Storyline: story, Source: source, Warnings: []string{}}, nil
}

// PreviewAgainst compiles the space and checks it against an existing deck,
// changing neither.
func (s *Service) PreviewAgainst(ctx context.Context, userID uuid.UUID, req Request, deckID string) (Preview, error) {
	preview, err := s.Preview(ctx, userID, req)
	if err != nil {
		return Preview{}, err
	}
	client, _, err := s.client(ctx)
	if err != nil {
		if errors.Is(err, ErrNotConfigured) {
			return preview, nil
		}
		return Preview{}, err
	}
	result, err := client.ApplySource(ctx, deckID, preview.Source, true)
	if err != nil {
		return Preview{}, err
	}
	preview.SlideCount = result.SlideCount
	if result.Warnings != nil {
		preview.Warnings = result.Warnings
	}
	preview.Checked = true
	return preview, nil
}

// Create makes the deck.
//
// The link is written before the deck is compiled and updated afterwards,
// whichever way it goes. Recording only on success would leave a deck in Ptium
// that umm has no record of — invisible in umm and unexplained in Ptium — and
// a failure nobody can look up afterwards.
func (s *Service) Create(ctx context.Context, userID uuid.UUID, req Request) (Result, error) {
	story, source, err := s.compile(ctx, userID, req)
	if err != nil {
		return Result{}, err
	}
	client, cfg, err := s.client(ctx)
	if err != nil {
		return Result{}, err
	}

	deck, err := client.CreateDeck(ctx, story.Title, cfg.TemplateID, cfg.Language)
	if err != nil {
		return Result{}, err
	}
	link, err := s.Links.CreatePresentationLink(ctx, userID, req.SpaceID, deck.ID, story.Title)
	if err != nil {
		// The deck exists in Ptium and umm could not record it. Said plainly
		// rather than swallowed, because the two are now out of step and only a
		// person can decide what to do about it.
		return Result{}, fmt.Errorf("ptium made deck %s but umm could not record it: %w", deck.ID, err)
	}

	result, applyErr := client.ApplySource(ctx, deck.ID, source, false)
	if applyErr != nil {
		failure := applyErr.Error()
		if err := s.Links.CompletePresentationLink(ctx, userID, link.ID, store.PresentationFailed, source, nil,
			len(story.usedThoughts()), len(story.Excluded), failure); err != nil {
			return Result{}, fmt.Errorf("%w (and recording the failure also failed: %v)", applyErr, err)
		}
		return Result{}, applyErr
	}

	if err := s.Links.CompletePresentationLink(ctx, userID, link.ID, store.PresentationReady, source,
		story.SlideSources(), len(story.usedThoughts()), len(story.Excluded), ""); err != nil {
		return Result{}, err
	}
	link.Status = store.PresentationReady
	link.CompiledSource = source
	link.ThoughtCount = len(story.usedThoughts())
	link.ExcludedCount = len(story.Excluded)

	warnings := result.Warnings
	if warnings == nil {
		warnings = []string{}
	}
	return Result{Link: link, Warnings: warnings}, nil
}

// compile reads the space and turns it into a talk.
func (s *Service) compile(ctx context.Context, userID uuid.UUID, req Request) (Storyline, string, error) {
	// ListNotes carries the permission check, so a space the caller cannot read
	// comes back empty rather than compiled.
	notes, edges, err := s.Spaces.ListNotes(ctx, userID, req.SpaceID, "")
	if err != nil {
		return Storyline{}, "", err
	}

	title := req.Title
	if title == "" {
		title = s.spaceName(ctx, userID, req.SpaceID)
	}

	thoughts := make([]Thought, 0, len(notes))
	for _, note := range notes {
		thoughts = append(thoughts, Thought{
			ID: note.ID, Title: note.Title, Content: note.Content, Kind: note.Kind,
			X: note.X, Y: note.Y, AIExcluded: note.AIExcluded,
		})
	}
	links := make([]Link, 0, len(edges))
	for _, edge := range edges {
		links = append(links, Link{From: edge.SourceID, To: edge.TargetID, Relation: edge.Relation, Origin: edge.Origin})
	}

	story := Compile(thoughts, links, Options{Title: title, Only: req.Only, IncludeExcluded: req.IncludeExcluded})
	if len(story.Slides) == 0 {
		return Storyline{}, "", ErrNothingToPresent
	}
	// Trace is always on. A deck whose slides cannot say where they came from
	// is the thing this whole feature exists to avoid.
	return story, WriteSource(story, SourceOptions{Trace: true}), nil
}

func (s *Service) spaceName(ctx context.Context, userID, spaceID uuid.UUID) string {
	spaces, err := s.Spaces.ListSpaces(ctx, userID)
	if err != nil {
		return ""
	}
	for _, space := range spaces {
		if space.ID == spaceID {
			return space.Name
		}
	}
	return ""
}

// client builds a Ptium client from the current settings.
func (s *Service) client(ctx context.Context) (Ptium, Config, error) {
	var cfg Config
	if err := s.Settings.GetSetting(ctx, "ptium", &cfg); err != nil {
		return nil, cfg, err
	}
	if cfg.BaseURL == "" {
		return nil, cfg, ErrNotConfigured
	}
	build := s.NewPtium
	if build == nil {
		build = func(c Config) (Ptium, error) {
			return NewClient(c.BaseURL, c.APIKey, time.Duration(c.TimeoutSeconds)*time.Second)
		}
	}
	client, err := build(cfg)
	if err != nil {
		return nil, cfg, err
	}
	return client, cfg, nil
}

// SlideSources maps each slide's position to the thoughts on it.
//
// Positions are one-based and count only the slides umm wrote, matching what
// Ptium compiles from this source.
func (s Storyline) SlideSources() []store.SlideSource {
	var out []store.SlideSource
	position := 0
	if s.Title != "" {
		position++ // the cover, which quotes nothing
	}
	for _, slide := range s.Slides {
		position++
		for _, id := range slide.From {
			out = append(out, store.SlideSource{SlidePosition: position, NoteID: id})
		}
	}
	return out
}

// usedThoughts is every thought that reached a slide, counted once.
func (s Storyline) usedThoughts() map[uuid.UUID]bool {
	seen := map[uuid.UUID]bool{}
	for _, slide := range s.Slides {
		for _, id := range slide.From {
			seen[id] = true
		}
	}
	return seen
}
