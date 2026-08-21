package dream

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/store"
)

func TestDreamAcceptanceUsesSinglePoolConnectionIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not set")
	}
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("pool_max_conns", "1")
	parsed.RawQuery = query.Encode()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	db, err := store.Open(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if db.Pool.Config().MaxConns != 1 {
		t.Fatalf("test requires one pool connection, got %d", db.Pool.Config().MaxConns)
	}

	ownerID, editorID, spaceID, sourceID, dreamID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	ownerName, editorName := "dream_pool_owner_"+ownerID.String(), "dream_pool_editor_"+editorID.String()
	if _, err = db.Pool.Exec(ctx, `
		INSERT INTO users(id,username,display_name) VALUES
		($1,$2::citext,$2::text),($3,$4::citext,$4::text)`, ownerID, ownerName, editorID, editorName); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1 OR id=$2`, ownerID, editorID)
	if _, err = db.Pool.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'single-pool Dream acceptance')`, spaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO space_members(space_id,user_id,permission) VALUES($1,$2,'edit')`, spaceID, editorID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO notes(id,space_id,author_id,content,x,y) VALUES($1,$2,$3,'Dream source',10,20)`, sourceID, spaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO dream_notes(dream_id,user_id,space_id,dream_type,content) VALUES($1,$2,$3,'connection','single connection candidate')`, dreamID, editorID, spaceID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO dream_sources(dream_id,source_note_id,rank,cited) VALUES($1,$2,1,true)`, dreamID, sourceID); err != nil {
		t.Fatal(err)
	}

	service := &Service{Store: db}
	accepted, err := service.Accept(ctx, editorID, dreamID, "")
	if err != nil {
		t.Fatalf("Dream acceptance exhausted its single transaction connection: %v", err)
	}
	if accepted.SpaceID != spaceID || accepted.AuthorID != editorID || accepted.Source != "dream" {
		t.Fatalf("unexpected accepted Dream note: %#v", accepted)
	}
}

func TestDreamEditPermissionLockSerializesDowngradeIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not set")
	}
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("pool_max_conns", "2")
	parsed.RawQuery = query.Encode()
	ctx := context.Background()
	db, err := store.Open(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if db.Pool.Config().MaxConns != 2 {
		t.Fatalf("test requires two pool connections, got %d", db.Pool.Config().MaxConns)
	}

	ownerID, editorID, spaceID := uuid.New(), uuid.New(), uuid.New()
	ownerName, editorName := "dream_lock_owner_"+ownerID.String(), "dream_lock_editor_"+editorID.String()
	if _, err = db.Pool.Exec(ctx, `
		INSERT INTO users(id,username,display_name) VALUES
		($1,$2::citext,$2::text),($3,$4::citext,$4::text)`, ownerID, ownerName, editorID, editorName); err != nil {
		t.Fatal(err)
	}
	defer db.Pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1 OR id=$2`, ownerID, editorID)
	if _, err = db.Pool.Exec(ctx, `INSERT INTO spaces(id,owner_id,name) VALUES($1,$2,'Dream permission lock')`, spaceID, ownerID); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO space_members(space_id,user_id,permission) VALUES($1,$2,'edit')`, spaceID, editorID); err != nil {
		t.Fatal(err)
	}

	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	canEdit, err := canEditSpaceTx(ctx, tx, editorID, spaceID)
	if err != nil || !canEdit {
		_ = tx.Rollback(ctx)
		t.Fatalf("editor permission check = %v, err=%v", canEdit, err)
	}
	downgradeCtx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	_, downgradeErr := db.Pool.Exec(downgradeCtx, `UPDATE space_members SET permission='view' WHERE space_id=$1 AND user_id=$2`, spaceID, editorID)
	if downgradeErr == nil {
		cancel()
		_ = tx.Rollback(ctx)
		t.Fatal("permission downgrade bypassed the Dream transaction membership lock")
	}
	if !errors.Is(downgradeErr, context.DeadlineExceeded) && !errors.Is(downgradeCtx.Err(), context.DeadlineExceeded) {
		cancel()
		_ = tx.Rollback(ctx)
		t.Fatalf("permission downgrade failed for an unexpected reason: %v", downgradeErr)
	}
	cancel()
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `UPDATE space_members SET permission='view' WHERE space_id=$1 AND user_id=$2`, spaceID, editorID); err != nil {
		t.Fatal(err)
	}
	tx, err = db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	canEdit, err = canEditSpaceTx(ctx, tx, editorID, spaceID)
	if err != nil || canEdit {
		t.Fatalf("downgraded permission check = %v, err=%v", canEdit, err)
	}
}

func TestDreamInboxAcceptanceIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	db, err := store.Open(ctx, dsn)
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer db.Pool.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatalf("migrate database: %v", err)
	}
	var userID uuid.UUID
	username := "dream-inbox-" + uuid.NewString()
	err = db.Pool.QueryRow(ctx, `INSERT INTO users(username,display_name) VALUES($1::citext,$1::text) RETURNING id`, username).Scan(&userID)
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	defer db.Pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, userID)
	if _, err = db.Pool.Exec(ctx, `INSERT INTO user_preferences(user_id) VALUES($1)`, userID); err != nil {
		t.Fatalf("create preferences: %v", err)
	}
	space, err := db.CreateSpace(ctx, userID, "Dream inbox integration")
	if err != nil {
		t.Fatalf("create space: %v", err)
	}
	_, err = db.CreateNote(ctx, userID, store.Note{SpaceID: space.ID, Content: "사용자별 API 키 권한 정책", X: 100, Y: 120})
	if err != nil {
		t.Fatalf("create first note: %v", err)
	}
	_, err = db.CreateNote(ctx, userID, store.Note{SpaceID: space.ID, Content: "부서별 AI 비용 승인 규칙", X: 520, Y: 240})
	if err != nil {
		t.Fatalf("create second note: %v", err)
	}
	_, err = db.CreateNote(ctx, userID, store.Note{SpaceID: space.ID, Content: "AI Gateway API 권한과 예산 검증 체크리스트", X: 840, Y: 360})
	if err != nil {
		t.Fatalf("create third note: %v", err)
	}
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"role": "assistant", "content": `{"content":"사용자별 API 키 권한 정책과 부서별 AI 비용 승인 규칙을 하나의 예산 한도 검증으로 연결해 보세요.","type":"connection","rationale":"1번 권한 정책과 2번 비용 승인 규칙을 연결했습니다.","suggestedAction":"예산 한도 하나를 정해 승인 흐름을 시험하세요.","sourceRefs":[1,2]}`}}},
			"usage":   map[string]any{"prompt_tokens": 40, "completion_tokens": 30},
		})
	}))
	defer gateway.Close()
	var previousGateway GatewayConfig
	if db.GetSetting(ctx, "ai_gateway", &previousGateway) == nil {
		defer db.PutSetting(context.Background(), "ai_gateway", previousGateway, userID)
	}
	gatewayConfig := GatewayConfig{BaseURL: gateway.URL, TimeoutSeconds: 2, PromptVersion: "dream-inbox-test"}
	if err = db.PutSetting(ctx, "ai_gateway", gatewayConfig, userID); err != nil {
		t.Fatalf("configure gateway: %v", err)
	}
	var jobID uuid.UUID
	if err = db.Pool.QueryRow(ctx, `INSERT INTO dream_jobs(user_id,scheduled_for,status) VALUES($1,CURRENT_DATE,'running') RETURNING id`, userID).Scan(&jobID); err != nil {
		t.Fatalf("create Dream job: %v", err)
	}
	service := &Service{Store: db}
	cfg := Config{Model: "integration-model", MinNotes: 2, ContextDays: 7, MaxContextNotes: 10, Temperature: .2, TokenLimit: 1000, QualityThreshold: .5, Count: 1}
	if err = service.generate(ctx, cfg, jobID, userID); err != nil {
		t.Fatalf("generate staged Dream: %v", err)
	}
	var dreamID uuid.UUID
	var stagedNoteID *uuid.UUID
	var stagedContent, rationale string
	if err = db.Pool.QueryRow(ctx, `SELECT dream_id,note_id,content,rationale FROM dream_notes WHERE user_id=$1 ORDER BY generated_at DESC LIMIT 1`, userID).Scan(&dreamID, &stagedNoteID, &stagedContent, &rationale); err != nil {
		t.Fatalf("load generated Dream: %v", err)
	}
	if stagedNoteID != nil || stagedContent == "" || rationale == "" {
		t.Fatalf("Dream was not staged with structured content: note=%v content=%q rationale=%q", stagedNoteID, stagedContent, rationale)
	}
	var preAcceptEdges int
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM note_edges WHERE relation='dreamed' AND space_id=$1`, space.ID).Scan(&preAcceptEdges); err != nil || preAcceptEdges != 0 {
		t.Fatalf("staged Dream changed the canvas: edges=%d err=%v", preAcceptEdges, err)
	}
	type acceptResult struct {
		note store.Note
		err  error
	}
	acceptedResults := make(chan acceptResult, 2)
	for range 2 {
		go func() {
			note, acceptErr := service.Accept(ctx, userID, dreamID, "")
			acceptedResults <- acceptResult{note: note, err: acceptErr}
		}()
	}
	first := <-acceptedResults
	second := <-acceptedResults
	if first.err != nil || second.err != nil || first.note.ID != second.note.ID {
		t.Fatalf("concurrent acceptance was not idempotent: first=%#v second=%#v", first, second)
	}
	accepted := first.note
	if accepted.Source != "dream" || accepted.SpaceID != space.ID {
		t.Fatalf("unexpected accepted note: %#v", accepted)
	}
	retried, err := service.Accept(ctx, userID, dreamID, "")
	if err != nil || retried.ID != accepted.ID {
		t.Fatalf("accept retry was not idempotent: note=%#v err=%v", retried, err)
	}
	var status string
	var edgeCount, feedbackCount int
	if err = db.Pool.QueryRow(ctx, `SELECT status FROM dream_notes WHERE dream_id=$1`, dreamID).Scan(&status); err != nil || status != "kept" {
		t.Fatalf("Dream status was not kept: status=%q err=%v", status, err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM note_edges WHERE target_note_id=$1 AND relation='dreamed'`, accepted.ID).Scan(&edgeCount); err != nil || edgeCount != 2 {
		t.Fatalf("only the two cited source edges should be materialized: count=%d err=%v", edgeCount, err)
	}
	type developmentResult struct {
		value DevelopmentMaterialization
		err   error
	}
	developmentResults := make(chan developmentResult, 2)
	developedContent := "승인된 Dream을 예산 한도 검증 체크리스트로 발전시킨 결과"
	for range 2 {
		go func() {
			value, saveErr := service.MaterializeDevelopment(ctx, userID, dreamID, developedContent)
			developmentResults <- developmentResult{value: value, err: saveErr}
		}()
	}
	developedFirst := <-developmentResults
	developedSecond := <-developmentResults
	if developedFirst.err != nil || developedSecond.err != nil || developedFirst.value.Note.ID != developedSecond.value.Note.ID || developedFirst.value.Edge.ID != developedSecond.value.Edge.ID {
		t.Fatalf("concurrent development save was not idempotent: first=%#v second=%#v", developedFirst, developedSecond)
	}
	if developedFirst.value.Created == developedSecond.value.Created {
		t.Fatalf("exactly one development request should create data: first=%t second=%t", developedFirst.value.Created, developedSecond.value.Created)
	}
	if developedFirst.value.Note.Source != "dream" || developedFirst.value.Edge.SourceID != accepted.ID || developedFirst.value.Edge.TargetID != developedFirst.value.Note.ID || developedFirst.value.Edge.Relation != "expanded" {
		t.Fatalf("unexpected developed note or edge: %#v", developedFirst.value)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM note_edges WHERE source_note_id=$1 AND target_note_id=$2 AND relation='expanded'`, accepted.ID, developedFirst.value.Note.ID).Scan(&edgeCount); err != nil || edgeCount != 1 {
		t.Fatalf("developed note and edge were not saved atomically once: count=%d err=%v", edgeCount, err)
	}
	_ = service.Feedback(ctx, userID, dreamID, "kept")
	_ = service.Feedback(ctx, userID, dreamID, "kept")
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM dream_feedback WHERE dream_id=$1 AND action='kept'`, dreamID).Scan(&feedbackCount); err != nil || feedbackCount != 1 {
		t.Fatalf("feedback was not idempotent: count=%d err=%v", feedbackCount, err)
	}
	var frequencyDreamID uuid.UUID
	if err = db.Pool.QueryRow(ctx, `INSERT INTO dream_notes(user_id,space_id,dream_type,content) VALUES($1,$2,'question','빈도 피드백 후보') RETURNING dream_id`, userID, space.ID).Scan(&frequencyDreamID); err != nil {
		t.Fatalf("create frequency feedback candidate: %v", err)
	}
	if err = service.FeedbackWithReason(ctx, userID, frequencyDreamID, "hidden", "too_frequent"); err != nil {
		t.Fatalf("record frequency feedback: %v", err)
	}
	if err = service.FeedbackWithReason(ctx, userID, frequencyDreamID, "hidden", "too_frequent"); err != nil {
		t.Fatalf("retry frequency feedback: %v", err)
	}
	var dreamFrequency string
	if err = db.Pool.QueryRow(ctx, `SELECT dream_frequency FROM user_preferences WHERE user_id=$1`, userID).Scan(&dreamFrequency); err != nil || dreamFrequency != "three_week" {
		t.Fatalf("frequency feedback was not applied exactly once: frequency=%q err=%v", dreamFrequency, err)
	}
	if _, err = db.Pool.Exec(ctx, `
		INSERT INTO dream_notes(user_id,space_id,dream_type,content,generated_at)
		SELECT $1,$2,'question','더 최근의 Dream 후보 '||value,now()+(value*interval '1 second')
		FROM generate_series(1,101) AS value`, userID, space.ID); err != nil {
		t.Fatalf("create newer Dream history: %v", err)
	}
	loaded, err := service.Dream(ctx, userID, dreamID)
	if err != nil || loaded.DreamID != dreamID || loaded.NoteID == nil || *loaded.NoteID != accepted.ID {
		t.Fatalf("direct Dream lookup should not be limited by history pagination: dream=%#v err=%v", loaded, err)
	}
}
