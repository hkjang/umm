package intelligence

import (
	"context"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"testing"
	"time"
)

// The embedding layer decides which thoughts umm calls related, which ones it
// clusters, and which pair a Dream is built from. Those decisions are only as
// good as the vectors underneath them, so this file measures the vectors
// directly instead of inferring their quality from the features built on top.
//
// The question it answers is narrow and checkable: does the active algorithm
// score two ways of saying the same thing above two unrelated sentences that
// merely share vocabulary? A lexical algorithm gets that backwards.

type pairClass string

const (
	// classParaphrase: same meaning, deliberately different wording. These must
	// score high or "related thoughts" misses the connections worth surfacing.
	classParaphrase pairClass = "paraphrase"
	// classRelated: different claims about the same subject. Should sit between
	// paraphrase and unrelated.
	classRelated pairClass = "related"
	// classLexicalDecoy: unrelated meaning, shared vocabulary. The trap for any
	// algorithm that scores surface overlap.
	classLexicalDecoy pairClass = "lexical-decoy"
	// classUnrelated: no meaningful relationship. The floor.
	classUnrelated pairClass = "unrelated"
)

type semanticPair struct {
	Class pairClass
	A, B  string
}

// semanticPairs is a small hand-labelled set drawn from the kind of notes umm
// actually holds: working thoughts about a product, in Korean and English.
// It is not a benchmark of record — it is a regression fence and a way to
// compare one embedding backend against another on the same ground.
var semanticPairs = []semanticPair{
	// Same meaning, different words.
	{classParaphrase, "외부 API 없이 사내망에서만 모델을 돌린다", "폐쇄망 내부 GPU 서버로 추론을 처리한다"},
	{classParaphrase, "메모를 고칠 때마다 이전 상태를 남긴다", "편집 시점마다 스냅샷을 보관한다"},
	{classParaphrase, "밤사이 쌓인 생각에서 새 연결을 찾아준다", "자는 동안 기록을 훑어 관계를 발견한다"},
	{classParaphrase, "로그인 실패가 반복되면 잠시 막는다", "인증 시도가 계속 틀리면 일시적으로 차단한다"},
	{classParaphrase, "the database stores every note revision", "each edit to a memo is kept as a snapshot"},
	{classParaphrase, "search should work without any network access", "lookups must succeed on a fully isolated machine"},
	{classParaphrase, "팀원마다 볼 수 있는 범위를 다르게 준다", "구성원별로 접근 권한을 구분한다"},
	{classParaphrase, "오래 안 본 기록을 다시 꺼내 보여준다", "잊고 있던 메모를 되살려 제시한다"},

	// Same subject, different claim.
	{classRelated, "임베딩 모델을 바꾸면 다시 계산해야 한다", "벡터 차원이 달라지면 기존 인덱스를 못 쓴다"},
	{classRelated, "캔버스에서 생각을 드래그해 배치한다", "포스트잇 위치를 자유롭게 옮길 수 있다"},
	{classRelated, "webhook payload is signed with HMAC", "receivers must verify the signature header"},
	{classRelated, "Dream은 하루에 한 번 생성된다", "야간 배치가 사용자별로 돌아간다"},

	// Shared vocabulary, unrelated meaning — the trap.
	{classLexicalDecoy, "PostgreSQL 백업 주기를 하루로 정했다", "PostgreSQL 로고 색상이 마음에 든다"},
	{classLexicalDecoy, "임베딩 모델 교체 계획을 세웠다", "모델하우스 임베딩 광고를 봤다"},
	{classLexicalDecoy, "the memory graph needs typed edges", "the graph on the wall of the memory ward"},
	{classLexicalDecoy, "검색 결과를 점수 순으로 정렬한다", "검색대에서 결과를 기다리며 줄을 섰다"},
	{classLexicalDecoy, "캔버스 확대 배율을 조정했다", "캔버스 천으로 만든 가방을 샀다"},
	{classLexicalDecoy, "token limit을 4096으로 올렸다", "지하철 token을 잃어버렸다"},

	// Unrelated.
	{classUnrelated, "고객 인터뷰를 매주 정리한다", "쿠버네티스 인그레스 설정"},
	{classUnrelated, "점심에 김치찌개를 먹었다", "분산 트랜잭션의 격리 수준"},
	{classUnrelated, "the release pipeline builds an image", "he practised the violin for an hour"},
	{classUnrelated, "주말에 자전거를 탔다", "TLS 인증서 만료일 확인"},
}

// discriminationFloor is the recorded behaviour of the default offline
// algorithm. It is deliberately a floor and not a target: the value is negative
// because character n-gram hashing scores shared substrings above shared
// meaning. Raising it is the point of any embedding work; this constant exists
// so the number can never quietly get worse.
// Measured at -0.250 on this dataset; the floor sits just below so a
// regression trips it while normal variation does not.
const discriminationFloor = -0.30

// pairAccuracyFloor is the fraction of (paraphrase, lexical-decoy) comparisons
// the algorithm must get the right way round. Measured at 4.2%: the offline
// default answers this question correctly in one comparison out of twenty-four,
// which is what makes every "semantic" feature built on top of it lexical.
const pairAccuracyFloor = 0.02

type classReport struct {
	class pairClass
	mean  float64
	min   float64
	max   float64
	count int
}

func scorePairs(t *testing.T, provider Provider) (map[pairClass][]float64, error) {
	t.Helper()
	scores := map[pairClass][]float64{}
	for _, pair := range semanticPairs {
		vectors, _ := provider.Embed(context.Background(), []string{pair.A, pair.B})
		if len(vectors) != 2 {
			return nil, fmt.Errorf("provider returned %d vectors for a pair", len(vectors))
		}
		scores[pair.Class] = append(scores[pair.Class], Cosine(vectors[0], vectors[1]))
	}
	return scores, nil
}

func summarise(scores map[pairClass][]float64) []classReport {
	order := []pairClass{classParaphrase, classRelated, classLexicalDecoy, classUnrelated}
	reports := make([]classReport, 0, len(order))
	for _, class := range order {
		values := scores[class]
		if len(values) == 0 {
			continue
		}
		report := classReport{class: class, min: values[0], max: values[0], count: len(values)}
		for _, value := range values {
			report.mean += value
			report.min = math.Min(report.min, value)
			report.max = math.Max(report.max, value)
		}
		report.mean /= float64(len(values))
		reports = append(reports, report)
	}
	return reports
}

// pairwiseAccuracy asks the only question that matters for retrieval: given one
// paraphrase and one lexical decoy, does the algorithm rank the paraphrase
// higher? Every pairing is compared, so the result does not depend on where a
// threshold happens to sit.
func pairwiseAccuracy(scores map[pairClass][]float64) float64 {
	paraphrases, decoys := scores[classParaphrase], scores[classLexicalDecoy]
	if len(paraphrases) == 0 || len(decoys) == 0 {
		return 0
	}
	correct, total := 0, 0
	for _, paraphrase := range paraphrases {
		for _, decoy := range decoys {
			total++
			if paraphrase > decoy {
				correct++
			}
		}
	}
	return float64(correct) / float64(total)
}

func meanOf(scores map[pairClass][]float64, class pairClass) float64 {
	values := scores[class]
	if len(values) == 0 {
		return 0
	}
	total := 0.0
	for _, value := range values {
		total += value
	}
	return total / float64(len(values))
}

func reportTable(t *testing.T, name string, scores map[pairClass][]float64) {
	t.Helper()
	var builder strings.Builder
	fmt.Fprintf(&builder, "\n%s\n", name)
	fmt.Fprintf(&builder, "  %-14s %6s %6s %6s %5s\n", "class", "mean", "min", "max", "n")
	for _, report := range summarise(scores) {
		fmt.Fprintf(&builder, "  %-14s %6.3f %6.3f %6.3f %5d\n",
			report.class, report.mean, report.min, report.max, report.count)
	}
	discrimination := meanOf(scores, classParaphrase) - meanOf(scores, classLexicalDecoy)
	fmt.Fprintf(&builder, "  discrimination (paraphrase - lexical-decoy): %+.3f\n", discrimination)
	fmt.Fprintf(&builder, "  pairwise accuracy (paraphrase > decoy):      %6.1f%%\n", pairwiseAccuracy(scores)*100)
	t.Log(builder.String())
}

// TestEmbeddingQualityIsMeasured records what the active algorithm actually
// captures. It fails only on regression, so it documents the ceiling rather
// than demanding one.
func TestEmbeddingQualityIsMeasured(t *testing.T) {
	scores, err := scorePairs(t, Provider{})
	if err != nil {
		t.Fatalf("score pairs: %v", err)
	}
	reportTable(t, "offline default (character n-gram hashing)", scores)

	discrimination := meanOf(scores, classParaphrase) - meanOf(scores, classLexicalDecoy)
	if discrimination < discriminationFloor {
		t.Errorf("discrimination fell to %+.3f, below the recorded floor of %+.3f", discrimination, discriminationFloor)
	}
	if accuracy := pairwiseAccuracy(scores); accuracy < pairAccuracyFloor {
		t.Errorf("pairwise accuracy fell to %.1f%%, below the recorded floor of %.1f%%", accuracy*100, pairAccuracyFloor*100)
	}
}

// TestOfflineDefaultRanksVocabularyAboveMeaning states the deficiency as an
// assertion rather than a comment. When an embedding backend finally inverts
// this, the test fails and must be rewritten — which is exactly the moment the
// features built on top stop being lexical.
func TestOfflineDefaultRanksVocabularyAboveMeaning(t *testing.T) {
	scores, err := scorePairs(t, Provider{})
	if err != nil {
		t.Fatalf("score pairs: %v", err)
	}
	paraphrase := meanOf(scores, classParaphrase)
	decoy := meanOf(scores, classLexicalDecoy)
	if paraphrase > decoy {
		t.Fatalf("the offline default now scores meaning (%.3f) above vocabulary (%.3f): "+
			"update discriminationFloor and pairAccuracyFloor to lock in the improvement", paraphrase, decoy)
	}
	t.Logf("offline default scores vocabulary %.3f above meaning %.3f (gap %.3f)", decoy, paraphrase, decoy-paraphrase)
}

// TestRelatedThoughtThresholdMissesParaphrases connects the vector measurement
// to a behaviour a person would notice. The store treats 0.22 as "related" and
// 0.34 as "same cluster"; this records how many genuine paraphrases clear those
// bars today.
func TestRelatedThoughtThresholdMissesParaphrases(t *testing.T) {
	const (
		relatedThreshold = .22
		clusterThreshold = .34
	)
	scores, err := scorePairs(t, Provider{})
	if err != nil {
		t.Fatalf("score pairs: %v", err)
	}
	paraphrases := scores[classParaphrase]
	related, clustered := 0, 0
	for _, score := range paraphrases {
		if score >= relatedThreshold {
			related++
		}
		if score >= clusterThreshold {
			clustered++
		}
	}
	decoysClustered := 0
	for _, score := range scores[classLexicalDecoy] {
		if score >= clusterThreshold {
			decoysClustered++
		}
	}
	t.Logf("of %d paraphrases: %d reach the related bar (%.2f), %d reach the cluster bar (%.2f)",
		len(paraphrases), related, relatedThreshold, clustered, clusterThreshold)
	t.Logf("of %d lexical decoys: %d reach the cluster bar and would be grouped as one topic",
		len(scores[classLexicalDecoy]), decoysClustered)
	if related > len(paraphrases) {
		t.Fatal("impossible count")
	}
}

// TestGatewayEmbeddingQuality runs the same measurement against a configured
// gateway so a candidate model can be compared on identical ground. It is
// skipped unless UMM_EMBEDDING_TEST_URL and UMM_EMBEDDING_TEST_MODEL are set:
//
//	UMM_EMBEDDING_TEST_URL=http://127.0.0.1:8080 \
//	UMM_EMBEDDING_TEST_MODEL=intfloat/multilingual-e5-small \
//	go test ./internal/intelligence -run Gateway -v
func TestGatewayEmbeddingQuality(t *testing.T) {
	baseURL := strings.TrimSpace(os.Getenv("UMM_EMBEDDING_TEST_URL"))
	model := strings.TrimSpace(os.Getenv("UMM_EMBEDDING_TEST_MODEL"))
	if baseURL == "" || model == "" {
		t.Skip("set UMM_EMBEDDING_TEST_URL and UMM_EMBEDDING_TEST_MODEL to compare a candidate model")
	}
	provider := Provider{Remote: &RemoteConfig{
		BaseURL: baseURL,
		APIKey:  os.Getenv("UMM_EMBEDDING_TEST_KEY"),
		Model:   model,
		Timeout: 60 * time.Second,
	}}
	if _, err := provider.EmbedStrict(context.Background(), []string{"probe"}); err != nil {
		t.Fatalf("gateway unreachable: %v", err)
	}
	scores, err := scorePairs(t, provider)
	if err != nil {
		t.Fatalf("score pairs: %v", err)
	}
	reportTable(t, "gateway: "+model, scores)

	discrimination := meanOf(scores, classParaphrase) - meanOf(scores, classLexicalDecoy)
	accuracy := pairwiseAccuracy(scores)
	// A candidate worth adopting has to get the basic question right. These are
	// the numbers to beat, not a claim that the candidate will.
	if discrimination <= 0 {
		t.Errorf("candidate scores vocabulary above meaning (discrimination %+.3f); it is not an improvement", discrimination)
	}
	if accuracy < 0.8 {
		t.Errorf("candidate ranks a paraphrase above a lexical decoy only %.1f%% of the time", accuracy*100)
	}
}

// TestSemanticPairsAreWellFormed guards the dataset itself. A duplicated or
// empty pair would quietly skew every number above.
func TestSemanticPairsAreWellFormed(t *testing.T) {
	seen := map[string]bool{}
	counts := map[pairClass]int{}
	for index, pair := range semanticPairs {
		if strings.TrimSpace(pair.A) == "" || strings.TrimSpace(pair.B) == "" {
			t.Fatalf("pair %d has an empty side", index)
		}
		if pair.A == pair.B {
			t.Fatalf("pair %d compares a sentence with itself", index)
		}
		key := pair.A + "\x00" + pair.B
		if seen[key] {
			t.Fatalf("pair %d is a duplicate", index)
		}
		seen[key] = true
		counts[pair.Class]++
	}
	for _, class := range []pairClass{classParaphrase, classRelated, classLexicalDecoy, classUnrelated} {
		if counts[class] < 4 {
			t.Errorf("class %s has only %d pairs; too few to average", class, counts[class])
		}
	}
	classes := make([]string, 0, len(counts))
	for class, count := range counts {
		classes = append(classes, fmt.Sprintf("%s=%d", class, count))
	}
	sort.Strings(classes)
	t.Logf("dataset: %d pairs (%s)", len(semanticPairs), strings.Join(classes, ", "))
}
