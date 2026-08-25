package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/auth"
	"github.com/hkjang/umm/internal/store"
)

// The API contract for turning a space into a talk.
//
// What has to hold at this layer rather than below it: a preview changes
// nothing, making a deck needs more than a read-only key, and the three ways
// this can refuse are told apart — "connect Ptium", "there is nothing here
// yet" and "Ptium said no" are different problems with different fixes, and
// answering 500 to all of them tells a person only that it broke.

type presentationHarness struct {
	db      *store.Store
	handler http.Handler
	cookie  *http.Cookie
	userID  uuid.UUID
	spaceID uuid.UUID
	notes   []uuid.UUID
}

func presentationAPI(t *testing.T) presentationHarness {
	t.Helper()
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not configured")
	}
	ctx := context.Background()
	db := isolatedHTTPStore(t, dsn)

	userID, spaceID := uuid.New(), uuid.New()
	username := "presentation_" + strings.ReplaceAll(userID.String(), "-", "")
	if _, err := db.Pool.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text)`, userID, username); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'회고 주기 재검토')`, spaceID, userID); err != nil {
		t.Fatal(err)
	}
	notes := make([]uuid.UUID, 2)
	contents := []string{"회고 주기를 격주로 줄여 보자", "주기가 짧으면 논의가 얕아진다"}
	for i := range notes {
		notes[i] = uuid.New()
		if _, err := db.Pool.Exec(ctx, `INSERT INTO notes(id,space_id,author_id,content,x) VALUES($1,$2,$3,$4,$5)`,
			notes[i], spaceID, userID, contents[i], i*400); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Pool.Exec(ctx, `
		INSERT INTO note_edges(space_id,source_note_id,target_note_id,relation,origin,created_by)
		VALUES($1,$2,$3,'supports','manual',$4)`, spaceID, notes[1], notes[0], userID); err != nil {
		t.Fatal(err)
	}

	authService := &auth.Service{Store: db}
	session, err := authService.CreateSession(ctx, userID, auth.SessionOrigin{UserAgent: "integration-test", ClientIP: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: db}
	router := chi.NewRouter()
	router.Get("/spaces/{spaceID}/presentation/preview", server.previewPresentation)
	router.Post("/spaces/{spaceID}/presentations", server.createPresentation)
	router.Get("/spaces/{spaceID}/presentations", server.listPresentations)
	router.Get("/notes/{noteID}/presentations", server.notePresentations)

	return presentationHarness{
		db:      db,
		handler: authService.Middleware(auth.Require(router)),
		cookie:  &http.Cookie{Name: auth.CookieName, Value: session},
		userID:  userID,
		spaceID: spaceID,
		notes:   notes,
	}
}

func (h presentationHarness) do(t *testing.T, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, path, reader)
	request.AddCookie(h.cookie)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	h.handler.ServeHTTP(recorder, request)
	return recorder
}

// The preview is the person's own storyline, and it is worth showing before
// anyone has connected Ptium at all. Refusing here would make the one part umm
// wrote itself unreachable.
func TestPreviewWorksBeforePtiumIsConnectedIntegration(t *testing.T) {
	h := presentationAPI(t)
	response := h.do(t, http.MethodGet, "/spaces/"+h.spaceID.String()+"/presentation/preview", "")
	if response.Code != 200 {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	var preview struct {
		Source    string `json:"source"`
		Checked   bool   `json:"checked"`
		Storyline struct {
			Title  string `json:"Title"`
			Slides []struct {
				Title string `json:"Title"`
			} `json:"Slides"`
		} `json:"storyline"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &preview); err != nil {
		t.Fatal(err)
	}
	if len(preview.Storyline.Slides) == 0 {
		t.Fatalf("no storyline: %s", response.Body.String())
	}
	if preview.Storyline.Title != "회고 주기 재검토" {
		t.Fatalf("the space's name did not become the title: %q", preview.Storyline.Title)
	}
	// The person's own sentence, not a paraphrase of it.
	if !strings.Contains(preview.Source, "회고 주기를 격주로 줄여 보자") {
		t.Fatalf("the thought was not carried through verbatim:\n%s", preview.Source)
	}
	// Never checked must not read as checked and clean.
	if preview.Checked {
		t.Fatal("a preview with no Ptium reported itself as checked")
	}
}

// Looking at what a space would become must not create anything.
func TestPreviewWritesNothingIntegration(t *testing.T) {
	h := presentationAPI(t)
	if response := h.do(t, http.MethodGet, "/spaces/"+h.spaceID.String()+"/presentation/preview", ""); response.Code != 200 {
		t.Fatalf("status %d", response.Code)
	}
	var links int
	if err := h.db.Pool.QueryRow(context.Background(),
		`SELECT count(*) FROM presentation_links WHERE space_id=$1`, h.spaceID).Scan(&links); err != nil {
		t.Fatal(err)
	}
	if links != 0 {
		t.Fatalf("a preview recorded %d links", links)
	}
}

// "Connect Ptium" is not the same problem as "it broke", and a person can only
// act on the first if it is said.
func TestCreateWithoutPtiumSaysToConnectItIntegration(t *testing.T) {
	h := presentationAPI(t)
	response := h.do(t, http.MethodPost, "/spaces/"+h.spaceID.String()+"/presentations", `{"title":"임원 보고"}`)
	if response.Code != 409 {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "Ptium") {
		t.Fatalf("the message does not name what is missing: %s", response.Body.String())
	}
	var links int
	if err := h.db.Pool.QueryRow(context.Background(),
		`SELECT count(*) FROM presentation_links WHERE space_id=$1`, h.spaceID).Scan(&links); err != nil {
		t.Fatal(err)
	}
	if links != 0 {
		t.Fatalf("a refused request still recorded %d links", links)
	}
}

// A space with nothing in it is a different problem again, and answering the
// same way as "Ptium is missing" would send someone to the settings page for
// no reason.
func TestASpaceWithNothingToPresentSaysSoIntegration(t *testing.T) {
	h := presentationAPI(t)
	ctx := context.Background()
	empty := uuid.New()
	if _, err := h.db.Pool.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'빈 공간')`, empty, h.userID); err != nil {
		t.Fatal(err)
	}
	response := h.do(t, http.MethodPost, "/spaces/"+empty.String()+"/presentations", "")
	if response.Code != 400 {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
}

// A preview of an empty space is the same refusal, so the UI does not offer a
// "make it" button for a space that cannot produce one.
func TestPreviewOfAnEmptySpaceRefusesIntegration(t *testing.T) {
	h := presentationAPI(t)
	empty := uuid.New()
	if _, err := h.db.Pool.Exec(context.Background(),
		`INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'빈 공간')`, empty, h.userID); err != nil {
		t.Fatal(err)
	}
	if response := h.do(t, http.MethodGet, "/spaces/"+empty.String()+"/presentation/preview", ""); response.Code != 400 {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
}

// A space someone cannot read compiles to nothing rather than to a deck. The
// permission check rides along with the store call, so this is really checking
// that no path skips it.
func TestAStrangerGetsNothingFromSomeoneElsesSpaceIntegration(t *testing.T) {
	h := presentationAPI(t)
	ctx := context.Background()

	stranger := uuid.New()
	name := "presentation_stranger_" + strings.ReplaceAll(stranger.String(), "-", "")
	if _, err := h.db.Pool.Exec(ctx, `INSERT INTO users(id,username,display_name) VALUES($1,$2::citext,$2::text)`, stranger, name); err != nil {
		t.Fatal(err)
	}
	authService := &auth.Service{Store: h.db}
	session, err := authService.CreateSession(ctx, stranger, auth.SessionOrigin{UserAgent: "integration-test", ClientIP: "127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/spaces/"+h.spaceID.String()+"/presentation/preview", strings.NewReader(""))
	request.AddCookie(&http.Cookie{Name: auth.CookieName, Value: session})
	recorder := httptest.NewRecorder()
	h.handler.ServeHTTP(recorder, request)

	// Nothing to present, because nothing was readable — not a deck built from
	// someone else's thoughts.
	if recorder.Code == 200 {
		t.Fatalf("a stranger got a storyline from someone else's space: %s", recorder.Body.String())
	}
}

func TestListingPresentationsStartsEmptyIntegration(t *testing.T) {
	h := presentationAPI(t)
	response := h.do(t, http.MethodGet, "/spaces/"+h.spaceID.String()+"/presentations", "")
	if response.Code != 200 {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	var body struct {
		Presentations []any `json:"presentations"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	// An empty list, not null: a client iterating it must not have to special
	// case the first visit.
	if body.Presentations == nil {
		t.Fatalf("presentations came back null: %s", response.Body.String())
	}
	if len(body.Presentations) != 0 {
		t.Fatalf("a fresh space already has talks: %s", response.Body.String())
	}
}

// The other direction, from a note. Someone about to edit a thought that decks
// quote is making a different decision from someone editing one nobody used.
func TestANoteReportsWhichTalksQuoteItIntegration(t *testing.T) {
	h := presentationAPI(t)
	ctx := context.Background()

	link, err := h.db.CreatePresentationLink(ctx, h.userID, h.spaceID, "pt_api", "임원 보고")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.db.CompletePresentationLink(ctx, h.userID, link.ID, store.PresentationReady, "# 임원 보고\n",
		[]store.SlideSource{{SlidePosition: 2, NoteID: h.notes[0]}}, 1, 0, ""); err != nil {
		t.Fatal(err)
	}

	response := h.do(t, http.MethodGet, "/notes/"+h.notes[0].String()+"/presentations", "")
	if response.Code != 200 {
		t.Fatalf("status %d: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "pt_api") {
		t.Fatalf("the talk quoting this note was not reported: %s", response.Body.String())
	}

	// And a note nobody used says so rather than reporting someone else's deck.
	response = h.do(t, http.MethodGet, "/notes/"+h.notes[1].String()+"/presentations", "")
	if response.Code != 200 {
		t.Fatalf("status %d", response.Code)
	}
	if strings.Contains(response.Body.String(), "pt_api") {
		t.Fatalf("an unused note claimed a talk: %s", response.Body.String())
	}
}

// A key that may only read must not be able to send someone's thoughts to
// another service and create something there. That is why making a deck asks
// for notes:write while previewing asks for notes:read — and the difference is
// only real if it is checked.
func TestAReadOnlyKeyCannotMakeADeckIntegration(t *testing.T) {
	h := presentationAPI(t)
	ctx := context.Background()

	authService := &auth.Service{Store: h.db}
	_, readOnly, err := authService.CreateKey(ctx, h.userID, "read-only", []string{"notes:read", "spaces:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}

	call := func(method, path string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, path, strings.NewReader(""))
		request.Header.Set("Authorization", "Bearer "+readOnly)
		recorder := httptest.NewRecorder()
		h.handler.ServeHTTP(recorder, request)
		return recorder
	}

	// Reading what the space would become is fine.
	if response := call(http.MethodGet, "/spaces/"+h.spaceID.String()+"/presentation/preview"); response.Code != 200 {
		t.Fatalf("a read-only key could not preview: %d %s", response.Code, response.Body.String())
	}
	// Making one is not.
	response := call(http.MethodPost, "/spaces/"+h.spaceID.String()+"/presentations")
	if response.Code != 403 {
		t.Fatalf("a read-only key made a deck: %d %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "notes:write") {
		t.Fatalf("the refusal does not name the missing scope: %s", response.Body.String())
	}
}

// A past deck is only useful if you can get back to it, and the address it
// lives at is computed on every read rather than stored: an administrator who
// moves Ptium would otherwise leave every past link pointing somewhere that no
// longer answers, with nothing to say which ones were stale.
func TestAPastDeckCarriesWhereToOpenItIntegration(t *testing.T) {
	h := presentationAPI(t)
	ctx := context.Background()

	link, err := h.db.CreatePresentationLink(ctx, h.userID, h.spaceID, "pt link/with space", "임원 보고")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.db.CompletePresentationLink(ctx, h.userID, link.ID, store.PresentationReady, "# 임원 보고\n",
		[]store.SlideSource{{SlidePosition: 2, NoteID: h.notes[0]}}, 1, 0, ""); err != nil {
		t.Fatal(err)
	}

	read := func() []map[string]any {
		t.Helper()
		response := h.do(t, http.MethodGet, "/spaces/"+h.spaceID.String()+"/presentations", "")
		if response.Code != 200 {
			t.Fatalf("status %d: %s", response.Code, response.Body.String())
		}
		var body struct {
			Presentations []map[string]any `json:"presentations"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.Presentations
	}

	// With no Ptium configured the list still comes back; there is simply
	// nowhere to click through to.
	rows := read()
	if len(rows) != 1 {
		t.Fatalf("expected one talk, got %+v", rows)
	}
	if _, ok := rows[0]["url"]; ok {
		t.Fatalf("a deck url appeared with no Ptium configured: %+v", rows[0])
	}

	if _, err := h.db.Pool.Exec(ctx,
		`INSERT INTO app_settings(key,value) VALUES('ptium', jsonb_build_object('base_url','https://ptium.internal/'))
		 ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`); err != nil {
		t.Fatal(err)
	}

	rows = read()
	deckURL, _ := rows[0]["url"].(string)
	if deckURL == "" {
		t.Fatalf("no deck url once Ptium is configured: %+v", rows[0])
	}
	// One slash, not two: the configured address may or may not end in one.
	if strings.Contains(strings.TrimPrefix(deckURL, "https://"), "//") {
		t.Fatalf("the trailing slash doubled up: %q", deckURL)
	}
	// Ptium ids are opaque to umm, so nothing may assume they are safe in a path.
	if strings.Contains(deckURL, "pt link/with space") {
		t.Fatalf("the deck id was not escaped into the url: %q", deckURL)
	}
	if !strings.HasSuffix(deckURL, "/editor") {
		t.Fatalf("the url does not open the editor: %q", deckURL)
	}
}

// The same deck has to look the same from both directions.
//
// It did not: the list of a space's talks reported a changed slide while the
// same deck reached from the note that changed reported none. The note view is
// where it matters most — you have just rewritten the thought — and it was the
// one saying nothing was wrong.
func TestBothViewsOfADeckAgreeOnWhatChangedIntegration(t *testing.T) {
	h := presentationAPI(t)
	ctx := context.Background()

	link, err := h.db.CreatePresentationLink(ctx, h.userID, h.spaceID, "pt_agree", "임원 보고")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.db.CompletePresentationLink(ctx, h.userID, link.ID, store.PresentationReady, "# 임원 보고\n",
		[]store.SlideSource{{SlidePosition: 2, NoteID: h.notes[0]}}, 1, 0, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Pool.Exec(ctx, `UPDATE notes SET content='고쳐 썼다' WHERE id=$1`, h.notes[0]); err != nil {
		t.Fatal(err)
	}

	staleFrom := func(path string) int {
		t.Helper()
		response := h.do(t, http.MethodGet, path, "")
		if response.Code != 200 {
			t.Fatalf("%s: status %d", path, response.Code)
		}
		var body struct {
			Presentations []struct {
				ID          string `json:"id"`
				StaleSlides int    `json:"staleSlides"`
			} `json:"presentations"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		for _, p := range body.Presentations {
			if p.ID == link.ID.String() {
				return p.StaleSlides
			}
		}
		t.Fatalf("%s did not return the deck: %s", path, response.Body.String())
		return -1
	}

	fromSpace := staleFrom("/spaces/" + h.spaceID.String() + "/presentations")
	fromNote := staleFrom("/notes/" + h.notes[0].String() + "/presentations")
	if fromSpace != 1 {
		t.Fatalf("the space's list reports %d changed slides, want 1", fromSpace)
	}
	if fromNote != fromSpace {
		t.Fatalf("the two views disagree: space says %d, note says %d", fromSpace, fromNote)
	}
}

// An administrator has to be able to connect Ptium from the screen, and to
// find out whether it worked without making a deck to see.
//
// The test lists Ptium's templates, which is an authenticated read: an answer
// proves the address responds, that it is a Ptium, and that the credential is
// accepted, all at once. Both the failures a person can act on from that screen
// are told apart from each other here.
func TestConnectingPtiumFromTheAdminScreenIntegration(t *testing.T) {
	h := presentationAPI(t)

	// Stands in for Ptium. The shape is the one a real Ptium returns — data is
	// the array itself, not an object wrapping one, which is what the first
	// version of this got wrong and only a live connection revealed.
	var seenAuth string
	ptium := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("Authorization")
		if seenAuth != "Bearer ptium_good" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"title":"Unauthorized","detail":"API 키가 올바르지 않습니다"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"t1","name":"Ptium Plum Wash","kind":"builtin"}],"meta":{"count":1}}`))
	}))
	defer ptium.Close()

	router := chi.NewRouter()
	server := &Server{Store: h.db}
	router.Post("/admin/ptium/test", server.testPtium)
	handler := (&auth.Service{Store: h.db}).Middleware(auth.Require(router))

	call := func(body string) (int, string) {
		request := httptest.NewRequest(http.MethodPost, "/admin/ptium/test", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.AddCookie(h.cookie)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder.Code, recorder.Body.String()
	}

	// No address is its own answer: "fill this in", not "it broke".
	if code, body := call(`{}`); code != 400 || !strings.Contains(body, "주소를 입력") {
		t.Fatalf("empty address: %d %s", code, body)
	}
	// A malformed address is a different fix again.
	if code, body := call(`{"base_url":"ptium.internal"}`); code != 400 || !strings.Contains(body, "올바르지 않습니다") {
		t.Fatalf("malformed address: %d %s", code, body)
	}
	// A refused key surfaces what Ptium said rather than a bare status.
	code, body := call(`{"base_url":"` + ptium.URL + `","api_key":"ptium_wrong","timeout_seconds":10}`)
	if code != 400 || !strings.Contains(body, "API 키가 올바르지 않습니다") {
		t.Fatalf("wrong key: %d %s", code, body)
	}

	code, body = call(`{"base_url":"` + ptium.URL + `","api_key":"ptium_good","timeout_seconds":10}`)
	if code != 200 {
		t.Fatalf("a working connection was refused: %d %s", code, body)
	}
	// The templates come back so the screen can offer them by name instead of
	// asking someone to paste a UUID from another service.
	if !strings.Contains(body, "Ptium Plum Wash") || !strings.Contains(body, `"t1"`) {
		t.Fatalf("templates were not returned: %s", body)
	}
	if seenAuth != "Bearer ptium_good" {
		t.Fatalf("the credential reached Ptium as %q", seenAuth)
	}
}

// The screen never sends a stored secret back, so testing a connection nobody
// has changed must not require retyping the key.
func TestTestingAnUnchangedPtiumUsesTheStoredKeyIntegration(t *testing.T) {
	h := presentationAPI(t)
	ctx := context.Background()

	var seenAuth string
	ptium := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer ptium.Close()

	if _, err := h.db.Pool.Exec(ctx,
		`INSERT INTO app_settings(key,value) VALUES('ptium', jsonb_build_object('base_url',$1::text,'api_key','ptium_stored','timeout_seconds',30))
		 ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, ptium.URL); err != nil {
		t.Fatal(err)
	}

	router := chi.NewRouter()
	router.Post("/admin/ptium/test", (&Server{Store: h.db}).testPtium)
	handler := (&auth.Service{Store: h.db}).Middleware(auth.Require(router))

	// The masked value is exactly what the screen sends back for an untouched
	// secret field.
	request := httptest.NewRequest(http.MethodPost, "/admin/ptium/test",
		strings.NewReader(`{"base_url":"","api_key":"`+secretMask+`","timeout_seconds":0}`))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(h.cookie)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != 200 {
		t.Fatalf("testing an unchanged connection failed: %d %s", recorder.Code, recorder.Body.String())
	}
	if seenAuth != "Bearer ptium_stored" {
		t.Fatalf("the stored key was not used: %q", seenAuth)
	}
}
