package dream

import (
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
