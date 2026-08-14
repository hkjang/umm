package dream

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRedactSecrets(t *testing.T) {
	input := "password=hello API_KEY: sk-test umm_key_abc_secret"
	got := redact(input)
	if strings.Contains(got, "hello") || strings.Contains(got, "sk-test") || strings.Contains(got, "umm_key_") {
		t.Fatalf("secret was not redacted: %s", got)
	}
}
func TestQualityScoreRejectsTrivialDream(t *testing.T) {
	sources := []sourceNote{{Content: "AI Gateway 권한 모델"}, {Content: "사용자별 API 키"}}
	if score := qualityScore("좋아요", sources); score >= .7 {
		t.Fatalf("trivial dream score too high: %f", score)
	}
	good := "AI Gateway의 사용자별 API 키 한도를 부서 예산 정책과 함께 정의하면 권한과 비용을 같은 규칙으로 관리할 수 있지 않을까?"
	if score := qualityScore(good, sources); score <= .5 {
		t.Fatalf("meaningful dream score too low: %f", score)
	}
}

func TestVisibleModelResponseRemovesReasoningBlocks(t *testing.T) {
	input := "<think>We need answer in Korean. Internal reasoning.</think>\n\n메모의 공통점을 작은 실험으로 확인해 보세요."
	got := visibleModelResponse(input)
	if got != "메모의 공통점을 작은 실험으로 확인해 보세요." {
		t.Fatalf("unexpected visible response: %q", got)
	}
	if strings.Contains(strings.ToLower(got), "think") {
		t.Fatalf("reasoning tag leaked: %q", got)
	}
}

func TestVisibleModelResponseDropsUnfinishedReasoning(t *testing.T) {
	if got := visibleModelResponse("<think>unfinished reasoning"); got != "" {
		t.Fatalf("unfinished reasoning leaked: %q", got)
	}
}

func TestVisibleModelResponseHandlesClosingTagOnly(t *testing.T) {
	input := "We need answer in Korean. Internal reasoning only.</think>\n메모를 주제별로 연결해 다음 행동을 정해 보세요."
	got := visibleModelResponse(input)
	if got != "메모를 주제별로 연결해 다음 행동을 정해 보세요." {
		t.Fatalf("closing-only reasoning was not removed: %q", got)
	}
}

func TestContainsHangul(t *testing.T) {
	if !containsHangul("한국어 response") || containsHangul("English response only") {
		t.Fatal("Hangul detection returned an unexpected result")
	}
}

func TestCallTextReturnsOnlyKoreanBodyAfterClosingThinkTag(t *testing.T) {
	var received chatRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Errorf("decode request: %v", err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": "English internal reasoning.</think>\n한국어 최종 답변입니다."}}},
			"usage":   map[string]any{"prompt_tokens": 12, "completion_tokens": 8},
		})
	}))
	defer server.Close()

	service := &Service{}
	text, _, _, _, err := service.callText(context.Background(), GatewayConfig{BaseURL: server.URL, TimeoutSeconds: 2}, "test-model", .2, 200, koreanOnlyInstruction, "사용자 메모")
	if err != nil {
		t.Fatalf("callText failed: %v", err)
	}
	if text != "한국어 최종 답변입니다." {
		t.Fatalf("reasoning leaked from callText: %q", text)
	}
	if len(received.Messages) == 0 || !strings.Contains(received.Messages[0].Content, "한국어") || !strings.Contains(received.Messages[0].Content, "<think>") {
		t.Fatalf("Korean-only reasoning instruction missing: %#v", received.Messages)
	}
}
