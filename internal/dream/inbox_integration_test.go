package dream

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/store"
)

func TestDreamInboxAcceptanceIntegration(t *testing.T) {
	dsn := os.Getenv("POSTGRES_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_DSN is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
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
}
