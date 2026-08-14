package dream

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/hkjang/umm/internal/cryptoutil"
	"github.com/hkjang/umm/internal/intelligence"
	"github.com/hkjang/umm/internal/store"
)

type Config struct {
	Enabled          bool    `json:"enabled"`
	Automatic        bool    `json:"automatic"`
	Schedule         string  `json:"schedule"`
	Frequency        string  `json:"frequency"`
	CustomDays       []int   `json:"custom_days"`
	IntervalDays     int     `json:"interval_days"`
	Count            int     `json:"count"`
	MinNotes         int     `json:"min_notes"`
	ContextDays      int     `json:"context_days"`
	MaxContextNotes  int     `json:"max_context_notes"`
	Model            string  `json:"model"`
	Temperature      float64 `json:"temperature"`
	TokenLimit       int     `json:"token_limit"`
	MonthlyLimit     int     `json:"monthly_limit"`
	AllowUserDisable bool    `json:"allow_user_disable"`
	Notification     bool    `json:"notification"`
	QualityThreshold float64 `json:"quality_threshold"`
	QuietMode        bool    `json:"quiet_mode"`
}
type GatewayConfig struct {
	BaseURL              string  `json:"base_url"`
	APIKey               string  `json:"api_key"`
	TimeoutSeconds       int     `json:"timeout_seconds"`
	MaxRetries           int     `json:"max_retries"`
	PromptVersion        string  `json:"prompt_version"`
	InputCostPerMillion  float64 `json:"input_cost_per_million"`
	OutputCostPerMillion float64 `json:"output_cost_per_million"`
	LogPrompt            bool    `json:"log_prompt"`
	LogRetentionDays     int     `json:"log_retention_days"`
}
type Service struct {
	Store   *store.Store
	Cipher  *cryptoutil.Cipher
	Version string
	stop    chan struct{}
	once    sync.Once
}
type AssistResult struct {
	Mode         string `json:"mode"`
	Content      string `json:"content"`
	Model        string `json:"model"`
	InputTokens  int    `json:"inputTokens"`
	OutputTokens int    `json:"outputTokens"`
}
type sourceNote struct {
	ID        uuid.UUID
	SpaceID   uuid.UUID
	Content   string
	X, Y      float64
	UpdatedAt time.Time
}

func (s *Service) Start(ctx context.Context) {
	s.once.Do(func() { s.stop = make(chan struct{}); go s.loop(ctx) })
}
func (s *Service) Stop() {
	if s.stop != nil {
		close(s.stop)
	}
}

func (s *Service) loop(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.stop:
			return
		case <-ticker.C:
			s.tick(ctx)
		}
	}
}

func (s *Service) tick(ctx context.Context) {
	s.cleanupAILogs(ctx)
	var cfg Config
	if err := s.Store.GetSetting(ctx, "dream", &cfg); err != nil || !cfg.Enabled || !cfg.Automatic {
		return
	}
	var general struct {
		Timezone string `json:"timezone"`
	}
	_ = s.Store.GetSetting(ctx, "general", &general)
	location, err := time.LoadLocation(general.Timezone)
	if err != nil {
		location = time.UTC
	}
	now := time.Now().In(location)
	if now.Format("15:04") != cfg.Schedule {
		return
	}
	if err := s.EnqueueEligible(ctx, cfg, now); err != nil {
		slog.Error("dream eligibility failed", "error", err)
		return
	}
	for i := 0; i < 2; i++ {
		go s.work(context.Background(), cfg)
	}
}

func (s *Service) EnqueueEligible(ctx context.Context, cfg Config, at time.Time) error {
	if !scheduledToday(cfg, at) {
		return nil
	}
	if cfg.MinNotes < 2 {
		cfg.MinNotes = 2
	}
	if cfg.ContextDays < 1 {
		cfg.ContextDays = 7
	}
	_, err := s.Store.Pool.Exec(ctx, `INSERT INTO dream_jobs(user_id,scheduled_for)
		SELECT u.id,$1 FROM users u JOIN user_preferences p ON p.user_id=u.id
		WHERE u.active AND p.dream_enabled AND (p.dream_pause_until IS NULL OR p.dream_pause_until<now())
		AND (SELECT count(*) FROM notes n WHERE n.author_id=u.id AND n.deleted_at IS NULL AND n.source!='dream' AND n.updated_at>now()-make_interval(days=>$2)) >= $3
		AND (p.dream_frequency='daily' OR (p.dream_frequency='three_week' AND extract(isodow FROM $1::date) IN (1,3,5)) OR (p.dream_frequency='weekly' AND extract(isodow FROM $1::date)=1))
		AND (SELECT count(*) FROM ai_calls a WHERE a.user_id=u.id AND a.created_at>=date_trunc('month',now())) < $4
		ON CONFLICT(user_id,scheduled_for) DO NOTHING`, at.Format("2006-01-02"), cfg.ContextDays, cfg.MinNotes, cfg.MonthlyLimit)
	return err
}

func scheduledToday(cfg Config, at time.Time) bool {
	weekday := at.Weekday()
	isoWeekday := int(weekday)
	if isoWeekday == 0 {
		isoWeekday = 7
	}
	runToday := true
	switch cfg.Frequency {
	case "weekdays":
		runToday = weekday != time.Saturday && weekday != time.Sunday
	case "weekends":
		runToday = weekday == time.Saturday || weekday == time.Sunday
	case "custom":
		runToday = slices.Contains(cfg.CustomDays, isoWeekday)
	case "interval":
		if cfg.IntervalDays < 2 {
			cfg.IntervalDays = 2
		}
		daysSinceEpoch := at.UTC().Unix() / 86400
		runToday = daysSinceEpoch%int64(cfg.IntervalDays) == 0
	}
	return runToday
}

func (s *Service) Trigger(ctx context.Context) error {
	var cfg Config
	if err := s.Store.GetSetting(ctx, "dream", &cfg); err != nil {
		return err
	}
	if !cfg.Enabled {
		return errors.New("Dream feature is disabled")
	}
	if err := s.EnqueueEligible(ctx, cfg, time.Now()); err != nil {
		return err
	}
	go s.work(context.Background(), cfg)
	return nil
}

func (s *Service) work(ctx context.Context, cfg Config) {
	for {
		var jobID, userID uuid.UUID
		err := s.Store.Pool.QueryRow(ctx, `UPDATE dream_jobs SET status='running',attempt=attempt+1,started_at=now() WHERE id=(SELECT id FROM dream_jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,user_id`).Scan(&jobID, &userID)
		if err != nil {
			return
		}
		count := cfg.Count
		if count < 1 {
			count = 1
		}
		for i := 0; i < count; i++ {
			err = s.generate(ctx, cfg, jobID, userID)
			if err != nil {
				break
			}
		}
		if err != nil {
			slog.Warn("dream generation failed", "job", jobID, "error", err)
			if strings.Contains(err.Error(), "quality score") {
				_, _ = s.Store.Pool.Exec(ctx, `UPDATE dream_jobs SET status='skipped',error=$2,finished_at=now() WHERE id=$1`, jobID, truncate(err.Error(), 500))
				continue
			}
			_, _ = s.Store.Pool.Exec(ctx, `UPDATE dream_jobs SET status=CASE WHEN attempt<3 THEN 'queued' ELSE 'failed' END,error=$2,finished_at=CASE WHEN attempt>=3 THEN now() END WHERE id=$1`, jobID, truncate(err.Error(), 500))
		} else {
			_, _ = s.Store.Pool.Exec(ctx, `UPDATE dream_jobs SET status='completed',finished_at=now() WHERE id=$1`, jobID)
		}
	}
}

func (s *Service) generate(ctx context.Context, cfg Config, jobID, userID uuid.UUID) error {
	if cfg.MaxContextNotes < 2 {
		cfg.MaxContextNotes = 20
	}
	if cfg.ContextDays < 1 {
		cfg.ContextDays = 7
	}
	var includeOld bool
	var style string
	_ = s.Store.Pool.QueryRow(ctx, `SELECT include_old_notes,dream_style FROM user_preferences WHERE user_id=$1`, userID).Scan(&includeOld, &style)
	recentLimit := cfg.MaxContextNotes
	if includeOld && recentLimit > 3 {
		recentLimit -= 2
	}
	rows, err := s.Store.Pool.Query(ctx, `SELECT id,space_id,content,x,y,updated_at FROM notes WHERE author_id=$1 AND deleted_at IS NULL AND source!='dream' AND updated_at>now()-make_interval(days=>$2) AND length(trim(content))>0 ORDER BY updated_at DESC LIMIT $3`, userID, cfg.ContextDays, recentLimit)
	if err != nil {
		return err
	}
	defer rows.Close()
	var sources []sourceNote
	for rows.Next() {
		var n sourceNote
		if err := rows.Scan(&n.ID, &n.SpaceID, &n.Content, &n.X, &n.Y, &n.UpdatedAt); err != nil {
			return err
		}
		sources = append(sources, n)
	}
	rows.Close()
	if includeOld && len(sources) < cfg.MaxContextNotes {
		oldRows, oldErr := s.Store.Pool.Query(ctx, `SELECT id,space_id,content,x,y,updated_at FROM notes WHERE author_id=$1 AND deleted_at IS NULL AND source!='dream' AND updated_at<=now()-make_interval(days=>$2) AND length(trim(content))>0 ORDER BY updated_at ASC LIMIT $3`, userID, cfg.ContextDays, cfg.MaxContextNotes-len(sources))
		if oldErr == nil {
			for oldRows.Next() {
				var n sourceNote
				if oldRows.Scan(&n.ID, &n.SpaceID, &n.Content, &n.X, &n.Y, &n.UpdatedAt) == nil {
					sources = append(sources, n)
				}
			}
			oldRows.Close()
		}
	}
	spaceCounts := map[uuid.UUID]int{}
	for _, source := range sources {
		spaceCounts[source.SpaceID]++
	}
	selectedSpace := uuid.Nil
	if len(sources) > 0 {
		selectedSpace = sources[0].SpaceID
	}
	for spaceID, count := range spaceCounts {
		if selectedSpace == uuid.Nil || count > spaceCounts[selectedSpace] {
			selectedSpace = spaceID
		}
	}
	spaceSources := sources[:0]
	for _, source := range sources {
		if source.SpaceID == selectedSpace {
			spaceSources = append(spaceSources, source)
		}
	}
	sources = spaceSources
	if len(sources) < cfg.MinNotes {
		return errors.New("not enough source notes in one space")
	}
	vectors := make([][]float32, len(sources))
	for i, n := range sources {
		vectors[i] = intelligence.Embed(n.Content)
	}
	centrality := map[uuid.UUID]float64{}
	for i, n := range sources {
		for j := range vectors {
			if j != i {
				centrality[n.ID] += intelligence.Cosine(vectors[i], vectors[j])
			}
		}
		centrality[n.ID] /= float64(max(1, len(vectors)-1))
	}
	sort.SliceStable(sources, func(i, j int) bool { return centrality[sources[i].ID] > centrality[sources[j].ID] })
	var gateway GatewayConfig
	if err = s.Store.GetSetting(ctx, "ai_gateway", &gateway); err != nil {
		return err
	}
	if style == "auto" || style == "" {
		style = s.preferredType(ctx, userID)
	}
	var text, model string
	var score float64
	qualityThreshold := cfg.QualityThreshold
	if cfg.QuietMode {
		qualityThreshold = math.Min(.95, qualityThreshold+.1)
	}
	promptCiphertext := s.encryptPromptLog(gateway, sourcePrompt(sources))
	for generationAttempt := 0; generationAttempt < 2; generationAttempt++ {
		generated, inputTokens, outputTokens, usedModel, latency, callErr := s.callGateway(ctx, cfg, gateway, sources, style)
		status := "success"
		errText := ""
		if callErr != nil {
			status = "failed"
			errText = callErr.Error()
		}
		cost := int64(float64(inputTokens)*gateway.InputCostPerMillion + float64(outputTokens)*gateway.OutputCostPerMillion)
		_, _ = s.Store.Pool.Exec(ctx, `INSERT INTO ai_calls(user_id,dream_job_id,model,status,input_tokens,output_tokens,cost_micros,latency_ms,error,prompt_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, userID, jobID, usedModel, status, inputTokens, outputTokens, cost, latency.Milliseconds(), truncate(errText, 500), promptCiphertext)
		if callErr != nil {
			return callErr
		}
		text, model = generated, usedModel
		score = qualityScore(text, sources)
		if score >= qualityThreshold {
			break
		}
		if generationAttempt == 1 {
			return fmt.Errorf("quality score %.2f below threshold %.2f after regeneration", score, qualityThreshold)
		}
	}
	kind := inferType(text)
	for _, source := range sources {
		if includeOld && time.Since(source.UpdatedAt) > time.Duration(cfg.ContextDays)*24*time.Hour {
			kind = "rediscovery"
			break
		}
	}
	if style != "" && style != "auto" && style != "free" {
		kind = style
	}
	base := sources[0]
	note := store.Note{SpaceID: base.SpaceID, Content: strings.TrimSpace(text), Color: "lavender", Kind: "idea", Source: "dream", X: base.X + 280, Y: base.Y + 40, Width: 260, Height: 180}
	created, err := s.Store.CreateNote(ctx, userID, note)
	if err != nil {
		return err
	}
	var dreamID uuid.UUID
	err = s.Store.Pool.QueryRow(ctx, `INSERT INTO dream_notes(user_id,space_id,note_id,dream_type,model,prompt_version,quality_score,source_note_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING dream_id`, userID, base.SpaceID, created.ID, kind, model, gateway.PromptVersion, score, len(sources)).Scan(&dreamID)
	if err != nil {
		return err
	}
	for i, n := range sources {
		similarity := wordSimilarity(n.Content, text)
		_, _ = s.Store.Pool.Exec(ctx, `INSERT INTO dream_sources(dream_id,source_note_id,similarity_score,rank) VALUES($1,$2,$3,$4)`, dreamID, n.ID, similarity, i+1)
		_, _ = s.Store.Pool.Exec(ctx, `INSERT INTO note_edges(space_id,source_note_id,target_note_id,relation,created_by) VALUES($1,$2,$3,'dreamed',$4) ON CONFLICT DO NOTHING`, base.SpaceID, n.ID, created.ID, userID)
	}
	if cfg.Notification {
		var enabled bool
		_ = s.Store.Pool.QueryRow(ctx, `SELECT dream_notifications FROM user_preferences WHERE user_id=$1`, userID).Scan(&enabled)
		if enabled {
			_, _ = s.Store.Pool.Exec(ctx, `INSERT INTO notifications(user_id,kind,title,body,resource_type,resource_id) VALUES($1,'dream','어젯밤, 당신의 생각이 꿈을 꾸었습니다.',$2,'dream',$3)`, userID, truncate(text, 180), dreamID)
		}
	}
	return nil
}

type chatRequest struct {
	Model       string        `json:"model"`
	Messages    []chatMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
	MaxTokens   int           `json:"max_tokens"`
}
type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
type chatResponse struct {
	Choices []struct {
		Message chatMessage `json:"message"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
	} `json:"usage"`
}

var (
	secretPattern       = regexp.MustCompile(`(?i)(password|passwd|secret|api[_ -]?key|token)\s*[:=]\s*\S+|umm_key_[a-zA-Z0-9_-]+`)
	thoughtBlockPattern = regexp.MustCompile(`(?is)<(?:think|thinking|analysis)\b[^>]*>.*?</(?:think|thinking|analysis)\s*>`)
	thoughtOpenPattern  = regexp.MustCompile(`(?is)<(?:think|thinking|analysis)\b[^>]*>`)
	thoughtClosePattern = regexp.MustCompile(`(?is)</(?:think|thinking|analysis)\s*>`)
	thoughtTagPattern   = regexp.MustCompile(`(?is)</?(?:think|thinking|analysis)\b[^>]*>`)
)

const koreanOnlyInstruction = "최종 답변은 반드시 자연스러운 한국어로만 작성하세요. 영어로 답하지 마세요. 내부 추론이나 분석 과정, <think> 태그는 절대 노출하지 말고 최종 답변 본문만 출력하세요."

func redact(v string) string { return secretPattern.ReplaceAllString(v, "[민감정보 제거됨]") }

func visibleModelResponse(v string) string {
	cleaned := thoughtBlockPattern.ReplaceAllString(v, "")
	// Some reasoning models omit the opening tag and emit only `</think>`
	// before the final answer. Everything before the last closing tag is hidden.
	if closes := thoughtClosePattern.FindAllStringIndex(cleaned, -1); len(closes) > 0 {
		cleaned = cleaned[closes[len(closes)-1][1]:]
	}
	// A truncated reasoning block has no reliable user-visible answer. Keep any
	// text before it and discard the unfinished block instead of exposing it.
	if open := thoughtOpenPattern.FindStringIndex(cleaned); open != nil {
		cleaned = cleaned[:open[0]]
	}
	return strings.TrimSpace(thoughtTagPattern.ReplaceAllString(cleaned, ""))
}

func containsHangul(v string) bool {
	for _, r := range v {
		if (r >= '\u1100' && r <= '\u11ff') || (r >= '\u3130' && r <= '\u318f') || (r >= '\uac00' && r <= '\ud7a3') {
			return true
		}
	}
	return false
}

func sourcePrompt(sources []sourceNote) string {
	var b strings.Builder
	for i, source := range sources {
		fmt.Fprintf(&b, "[%d] %s\n", i+1, redact(truncate(source.Content, 1200)))
	}
	return b.String()
}

func (s *Service) encryptPromptLog(g GatewayConfig, prompt string) string {
	if !g.LogPrompt || strings.TrimSpace(prompt) == "" {
		return ""
	}
	encrypted, err := s.Cipher.Encrypt(prompt)
	if err != nil {
		slog.Warn("AI prompt log encryption failed", "error", err)
		return ""
	}
	return "enc:" + encrypted
}

func (s *Service) cleanupAILogs(ctx context.Context) {
	var gateway GatewayConfig
	if s.Store.GetSetting(ctx, "ai_gateway", &gateway) != nil {
		return
	}
	if gateway.LogRetentionDays < 1 {
		gateway.LogRetentionDays = 90
	}
	_, _ = s.Store.Pool.Exec(ctx, `DELETE FROM ai_calls WHERE created_at<now()-make_interval(days=>$1)`, gateway.LogRetentionDays)
}

func (s *Service) callGateway(ctx context.Context, cfg Config, g GatewayConfig, sources []sourceNote, style string) (string, int, int, string, time.Duration, error) {
	if strings.TrimSpace(g.BaseURL) == "" || strings.TrimSpace(cfg.Model) == "" {
		return "", 0, 0, cfg.Model, 0, errors.New("AI gateway URL and model must be configured")
	}
	endpoint := strings.TrimRight(g.BaseURL, "/")
	if !strings.HasSuffix(endpoint, "/chat/completions") {
		endpoint += "/v1/chat/completions"
	}
	u, err := url.Parse(endpoint)
	if err != nil || !(u.Scheme == "http" || u.Scheme == "https") || u.Host == "" {
		return "", 0, 0, cfg.Model, 0, errors.New("invalid AI gateway URL")
	}
	key := g.APIKey
	if strings.HasPrefix(key, "enc:") {
		key, err = s.Cipher.Decrypt(strings.TrimPrefix(key, "enc:"))
		if err != nil {
			return "", 0, 0, cfg.Model, 0, err
		}
	}
	var b strings.Builder
	b.WriteString("다음은 사용자가 직접 작성한 생각입니다.\n")
	for i, n := range sources {
		fmt.Fprintf(&b, "[%d] %s\n", i+1, redact(truncate(n.Content, 1200)))
	}
	system := "당신은 umm의 Dream Layer입니다. 사용자의 메모 중 최소 2개를 의미 있게 연결해 한 단계 발전한 새로운 생각 하나를 만드세요. 단순 요약, 뻔한 조언, 사실의 창작을 금지합니다. 1~4문장, 320자 이내로 작성하고 머리말이나 따옴표를 붙이지 마세요. " + koreanOnlyInstruction
	stylePrompt := map[string]string{"connection": "서로 다른 생각을 연결하세요.", "question": "생각을 발전시키는 날카로운 질문을 만드세요.", "expansion": "기존 아이디어를 구체적으로 확장하세요.", "contrarian": "숨은 가정을 뒤집는 반대 관점을 제시하세요.", "rediscovery": "과거 생각과 지금 생각을 연결하세요.", "action": "가장 작은 다음 행동으로 바꾸세요.", "pattern": "반복되는 관심이나 문제의 패턴을 발견하세요.", "free": "연결, 질문, 확장, 반대 관점 중 가장 가치 있는 방식을 고르세요."}
	if extra := stylePrompt[style]; extra != "" {
		system += " " + extra
	}
	reqBody := chatRequest{Model: cfg.Model, Messages: []chatMessage{{Role: "system", Content: system}, {Role: "user", Content: b.String()}}, Temperature: cfg.Temperature, MaxTokens: cfg.TokenLimit}
	raw, _ := json.Marshal(reqBody)
	timeout := g.TimeoutSeconds
	if timeout <= 0 {
		timeout = 45
	}
	client := &http.Client{Timeout: time.Duration(timeout) * time.Second}
	retries := g.MaxRetries
	if retries < 0 {
		retries = 0
	}
	start := time.Now()
	var lastErr error
	for attempt := 0; attempt <= retries; attempt++ {
		request, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
		request.Header.Set("Content-Type", "application/json")
		if key != "" {
			request.Header.Set("Authorization", "Bearer "+key)
		}
		resp, err := client.Do(request)
		if err != nil {
			lastErr = err
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
		resp.Body.Close()
		if readErr != nil {
			lastErr = readErr
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			lastErr = fmt.Errorf("AI gateway status %d: %s", resp.StatusCode, truncate(string(body), 300))
			continue
		}
		var result chatResponse
		if err = json.Unmarshal(body, &result); err != nil || len(result.Choices) == 0 {
			lastErr = errors.New("invalid AI gateway response")
			continue
		}
		text := visibleModelResponse(result.Choices[0].Message.Content)
		if text == "" {
			lastErr = errors.New("empty Dream response")
			continue
		}
		if !containsHangul(text) {
			lastErr = errors.New("Dream 응답이 한국어가 아닙니다")
			continue
		}
		return truncate(text, 500), result.Usage.PromptTokens, result.Usage.CompletionTokens, cfg.Model, time.Since(start), nil
	}
	return "", 0, 0, cfg.Model, time.Since(start), lastErr
}

func words(v string) map[string]bool {
	out := map[string]bool{}
	for _, w := range strings.Fields(strings.ToLower(v)) {
		w = strings.Trim(w, ".,!?()[]{}\"'“”‘’:;-/")
		if len([]rune(w)) > 1 {
			out[w] = true
		}
	}
	return out
}
func wordSimilarity(a, b string) float64 {
	aw, bw := words(a), words(b)
	if len(aw) == 0 || len(bw) == 0 {
		return 0
	}
	inter := 0
	for w := range aw {
		if bw[w] {
			inter++
		}
	}
	return float64(inter) / math.Sqrt(float64(len(aw)*len(bw)))
}
func qualityScore(text string, sources []sourceNote) float64 {
	if len([]rune(text)) < 20 || len([]rune(text)) > 500 {
		return 0.2
	}
	scores := make([]float64, 0, len(sources))
	combined := ""
	for _, n := range sources {
		scores = append(scores, wordSimilarity(n.Content, text))
		combined += " " + n.Content
	}
	sort.Sort(sort.Reverse(sort.Float64Slice(scores)))
	relevance := 0.0
	if len(scores) > 1 {
		relevance = math.Min(1, (scores[0]+scores[1])*1.8)
	}
	novelty := 1 - math.Min(1, wordSimilarity(combined, text))
	length := math.Min(1, float64(len([]rune(text)))/80)
	return math.Min(.96, .52+.24*relevance+.14*novelty+.10*length)
}
func inferType(v string) string {
	lower := strings.ToLower(v)
	if strings.Contains(lower, "반대로") || strings.Contains(lower, "가정") || strings.Contains(lower, "실패한다면") {
		return "contrarian"
	}
	if strings.Contains(lower, "반복") || strings.Contains(lower, "계속") || strings.Contains(lower, "패턴") {
		return "pattern"
	}
	if strings.Contains(v, "?") || strings.Contains(v, "까") || strings.Contains(v, "지?") {
		return "question"
	}
	if strings.Contains(v, "먼저") || strings.Contains(v, "시작") {
		return "action"
	}
	if strings.Contains(lower, "확장") || strings.Contains(lower, "발전") {
		return "expansion"
	}
	return "connection"
}
func truncate(v string, n int) string {
	r := []rune(v)
	if len(r) <= n {
		return v
	}
	return string(r[:n])
}

func (s *Service) Assist(ctx context.Context, userID uuid.UUID, noteIDs []uuid.UUID, mode string) (AssistResult, error) {
	allowed := map[string]string{"summarize": "핵심을 잃지 않는 3문장 이내의 요약을 만드세요.", "questions": "생각을 발전시키는 구체적인 질문 3개만 만드세요.", "expand": "한 단계 더 발전한 아이디어를 1~4문장으로 제안하세요.", "challenge": "숨은 가정과 실패 가능성을 지적하는 반대 관점을 1~4문장으로 제시하세요.", "actions": "지금 할 수 있는 가장 작은 실행 항목을 최대 5개 제시하세요."}
	instruction, ok := allowed[mode]
	if !ok {
		return AssistResult{}, errors.New("unsupported AI assist mode")
	}
	if len(noteIDs) == 0 || len(noteIDs) > 20 {
		return AssistResult{}, errors.New("select between 1 and 20 notes")
	}
	rows, err := s.Store.Pool.Query(ctx, `SELECT n.content FROM notes n WHERE n.id=ANY($1) AND n.deleted_at IS NULL AND EXISTS(SELECT 1 FROM spaces sp LEFT JOIN space_members sm ON sm.space_id=sp.id AND sm.user_id=$2 WHERE sp.id=n.space_id AND (sp.owner_id=$2 OR sm.user_id=$2))`, noteIDs, userID)
	if err != nil {
		return AssistResult{}, err
	}
	defer rows.Close()
	var input strings.Builder
	input.WriteString("선택한 생각:\n")
	count := 0
	for rows.Next() {
		var content string
		if rows.Scan(&content) == nil {
			count++
			fmt.Fprintf(&input, "[%d] %s\n", count, redact(truncate(content, 1500)))
		}
	}
	if count != len(noteIDs) {
		return AssistResult{}, errors.New("one or more notes are unavailable")
	}
	var cfg Config
	var gateway GatewayConfig
	if s.Store.GetSetting(ctx, "dream", &cfg) != nil || s.Store.GetSetting(ctx, "ai_gateway", &gateway) != nil {
		return AssistResult{}, errors.New("AI settings unavailable")
	}
	if cfg.Model == "" {
		return AssistResult{}, errors.New("AI model is not configured")
	}
	system := "당신은 umm 안에서 사용자의 생각을 조용히 발전시키는 조력자입니다. 사용자가 제공하지 않은 사실을 만들지 말고 간결하게 답하세요. " + instruction + " " + koreanOnlyInstruction
	text, inTokens, outTokens, latency, err := s.callText(ctx, gateway, cfg.Model, .45, min(800, max(128, cfg.TokenLimit)), system, input.String())
	status := "success"
	errText := ""
	if err != nil {
		status = "failed"
		errText = err.Error()
	}
	cost := int64(float64(inTokens)*gateway.InputCostPerMillion + float64(outTokens)*gateway.OutputCostPerMillion)
	promptCiphertext := s.encryptPromptLog(gateway, input.String())
	_, _ = s.Store.Pool.Exec(ctx, `INSERT INTO ai_calls(user_id,model,status,input_tokens,output_tokens,cost_micros,latency_ms,error,prompt_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, userID, cfg.Model, status, inTokens, outTokens, cost, latency.Milliseconds(), truncate(errText, 500), promptCiphertext)
	if err != nil {
		return AssistResult{}, err
	}
	return AssistResult{Mode: mode, Content: text, Model: cfg.Model, InputTokens: inTokens, OutputTokens: outTokens}, nil
}

func (s *Service) callText(ctx context.Context, g GatewayConfig, model string, temperature float64, maxTokens int, system, user string) (string, int, int, time.Duration, error) {
	endpoint := strings.TrimRight(g.BaseURL, "/")
	if !strings.HasSuffix(endpoint, "/chat/completions") {
		endpoint += "/v1/chat/completions"
	}
	u, err := url.Parse(endpoint)
	if err != nil || !(u.Scheme == "http" || u.Scheme == "https") || u.Host == "" {
		return "", 0, 0, 0, errors.New("invalid AI gateway URL")
	}
	key := g.APIKey
	if strings.HasPrefix(key, "enc:") {
		key, err = s.Cipher.Decrypt(strings.TrimPrefix(key, "enc:"))
		if err != nil {
			return "", 0, 0, 0, err
		}
	}
	raw, _ := json.Marshal(chatRequest{Model: model, Messages: []chatMessage{{Role: "system", Content: system}, {Role: "user", Content: user}}, Temperature: temperature, MaxTokens: maxTokens})
	timeout := g.TimeoutSeconds
	if timeout <= 0 {
		timeout = 45
	}
	client := &http.Client{Timeout: time.Duration(timeout) * time.Second}
	retries := g.MaxRetries
	if retries < 0 {
		retries = 0
	}
	start := time.Now()
	var lastErr error
	for attempt := 0; attempt <= retries; attempt++ {
		request, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
		request.Header.Set("Content-Type", "application/json")
		if key != "" {
			request.Header.Set("Authorization", "Bearer "+key)
		}
		resp, doErr := client.Do(request)
		if doErr != nil {
			lastErr = doErr
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
		resp.Body.Close()
		if readErr != nil {
			lastErr = readErr
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			lastErr = fmt.Errorf("AI gateway status %d: %s", resp.StatusCode, truncate(string(body), 300))
			continue
		}
		var result chatResponse
		if json.Unmarshal(body, &result) != nil || len(result.Choices) == 0 {
			lastErr = errors.New("invalid AI gateway response")
			continue
		}
		text := visibleModelResponse(result.Choices[0].Message.Content)
		if text == "" {
			lastErr = errors.New("empty AI response")
			continue
		}
		if !containsHangul(text) {
			lastErr = errors.New("AI 응답이 한국어가 아닙니다")
			continue
		}
		return truncate(text, 2000), result.Usage.PromptTokens, result.Usage.CompletionTokens, time.Since(start), nil
	}
	return "", 0, 0, time.Since(start), lastErr
}

func (s *Service) Feedback(ctx context.Context, userID, dreamID uuid.UUID, action string) error {
	allowed := map[string]bool{"exposed": true, "kept": true, "edited": true, "connected": true, "expanded": true, "moved": true, "deleted": true, "hidden": true}
	if !allowed[action] {
		return errors.New("invalid feedback action")
	}
	cmd, err := s.Store.Pool.Exec(ctx, `INSERT INTO dream_feedback(dream_id,user_id,action) SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM dream_notes WHERE dream_id=$1 AND user_id=$2)`, dreamID, userID, action)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return errors.New("dream not found")
	}
	status := "kept"
	if action == "exposed" {
		status = "exposed"
	}
	if action == "deleted" || action == "hidden" {
		status = "deleted"
	}
	_, _ = s.Store.Pool.Exec(ctx, `UPDATE dream_notes SET status=$2,exposed_at=CASE WHEN $2='exposed' AND exposed_at IS NULL THEN now() ELSE exposed_at END WHERE dream_id=$1`, dreamID, status)
	var dreamType string
	if s.Store.Pool.QueryRow(ctx, `SELECT dream_type FROM dream_notes WHERE dream_id=$1 AND user_id=$2`, dreamID, userID).Scan(&dreamType) == nil {
		delta := 0.0
		switch action {
		case "edited", "connected":
			delta = .08
		case "expanded":
			delta = .12
		case "kept", "moved":
			delta = .04
		case "deleted", "hidden":
			delta = -.12
		}
		if delta != 0 {
			_, _ = s.Store.Pool.Exec(ctx, `INSERT INTO dream_preferences(user_id,dream_type,score,sample_count) VALUES($1,$2,GREATEST(0,LEAST(1,.5+$3)),1) ON CONFLICT(user_id,dream_type) DO UPDATE SET score=GREATEST(0,LEAST(1,dream_preferences.score+$3)),sample_count=dream_preferences.sample_count+1,updated_at=now()`, userID, dreamType, delta)
		}
	}
	return nil
}

func (s *Service) preferredType(ctx context.Context, userID uuid.UUID) string {
	var typ string
	err := s.Store.Pool.QueryRow(ctx, `SELECT dream_type FROM dream_preferences WHERE user_id=$1 ORDER BY score DESC,sample_count DESC LIMIT 1`, userID).Scan(&typ)
	if err != nil {
		return "free"
	}
	return typ
}

func (s *Service) History(ctx context.Context, userID uuid.UUID) ([]map[string]any, error) {
	rows, err := s.Store.Pool.Query(ctx, `SELECT d.dream_id,d.dream_type,d.generated_at,d.exposed_at,d.quality_score,d.status,n.id,n.space_id,n.content FROM dream_notes d JOIN notes n ON n.id=d.note_id WHERE d.user_id=$1 AND n.deleted_at IS NULL ORDER BY d.generated_at DESC LIMIT 100`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var dreamID, noteID, spaceID uuid.UUID
		var typ, status, content string
		var generated time.Time
		var exposed *time.Time
		var score float64
		if err := rows.Scan(&dreamID, &typ, &generated, &exposed, &score, &status, &noteID, &spaceID, &content); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{"dreamId": dreamID, "type": typ, "generatedAt": generated, "exposedAt": exposed, "qualityScore": score, "status": status, "noteId": noteID, "spaceId": spaceID, "content": content})
	}
	return out, rows.Err()
}

func (s *Service) Metrics(ctx context.Context) (map[string]any, error) {
	out := map[string]any{}
	var generated, failed, queued, jobs int64
	err := s.Store.Pool.QueryRow(ctx, `SELECT count(*) FILTER(WHERE status='completed'),count(*) FILTER(WHERE status='failed'),count(*) FILTER(WHERE status='queued'),count(*) FROM dream_jobs WHERE created_at>=date_trunc('month',now())`).Scan(&generated, &failed, &queued, &jobs)
	if err != nil {
		return nil, err
	}
	out["generated"] = generated
	out["failed"] = failed
	out["queued"] = queued
	out["jobs"] = jobs
	var calls, input, output, cost int64
	var avg float64
	_ = s.Store.Pool.QueryRow(ctx, `SELECT count(*),COALESCE(sum(input_tokens),0),COALESCE(sum(output_tokens),0),COALESCE(sum(cost_micros),0) FROM ai_calls WHERE created_at>=date_trunc('month',now())`).Scan(&calls, &input, &output, &cost)
	_ = s.Store.Pool.QueryRow(ctx, `SELECT COALESCE(avg(quality_score),0) FROM dream_notes WHERE generated_at>=date_trunc('month',now())`).Scan(&avg)
	out["apiCalls"] = calls
	out["inputTokens"] = input
	out["outputTokens"] = output
	out["costMicros"] = cost
	out["avgQualityScore"] = avg
	for _, action := range []string{"kept", "edited", "connected", "expanded", "deleted"} {
		var count int64
		_ = s.Store.Pool.QueryRow(ctx, `SELECT count(*) FROM dream_feedback WHERE action=$1 AND created_at>=date_trunc('month',now())`, action).Scan(&count)
		out[action+"Count"] = count
	}
	var cfg Config
	_ = s.Store.GetSetting(ctx, "dream", &cfg)
	if cfg.ContextDays < 1 {
		cfg.ContextDays = 7
	}
	if cfg.MinNotes < 2 {
		cfg.MinNotes = 3
	}
	var eligible, generatedDreams, exposed, kept, deleted, activeAIUsers int64
	_ = s.Store.Pool.QueryRow(ctx, `SELECT count(*) FROM users u JOIN user_preferences p ON p.user_id=u.id WHERE u.active AND p.dream_enabled AND (SELECT count(*) FROM notes n WHERE n.author_id=u.id AND n.deleted_at IS NULL AND n.source!='dream' AND n.updated_at>now()-make_interval(days=>$1)) >= $2`, cfg.ContextDays, cfg.MinNotes).Scan(&eligible)
	_ = s.Store.Pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE exposed_at IS NOT NULL),count(*) FILTER(WHERE status='kept'),count(*) FILTER(WHERE status='deleted') FROM dream_notes WHERE generated_at>=date_trunc('month',now())`).Scan(&generatedDreams, &exposed, &kept, &deleted)
	_ = s.Store.Pool.QueryRow(ctx, `SELECT count(DISTINCT user_id) FROM ai_calls WHERE created_at>=date_trunc('month',now())`).Scan(&activeAIUsers)
	rate := func(value, total int64) float64 {
		if total == 0 {
			return 0
		}
		return float64(value) / float64(total)
	}
	out["eligibleUsers"] = eligible
	out["generatedDreams"] = generatedDreams
	out["exposedDreams"] = exposed
	out["keptRate"] = rate(kept, exposed)
	out["deleteRate"] = rate(deleted, exposed)
	expanded, _ := out["expandedCount"].(int64)
	out["expansionRate"] = rate(expanded, exposed)
	out["costPerActiveUserMicros"] = int64(0)
	if activeAIUsers > 0 {
		out["costPerActiveUserMicros"] = cost / activeAIUsers
	}
	runsPerMonth := 30
	switch cfg.Frequency {
	case "weekdays":
		runsPerMonth = 22
	case "weekends":
		runsPerMonth = 8
	case "custom":
		runsPerMonth = int(math.Round(float64(len(cfg.CustomDays)) * 4.35))
	case "interval":
		runsPerMonth = int(math.Ceil(30 / float64(max(2, cfg.IntervalDays))))
	}
	count := max(1, cfg.Count)
	expectedCalls := eligible * int64(runsPerMonth*count)
	if cfg.MonthlyLimit > 0 && expectedCalls > eligible*int64(cfg.MonthlyLimit) {
		expectedCalls = eligible * int64(cfg.MonthlyLimit)
	}
	var gateway GatewayConfig
	_ = s.Store.GetSetting(ctx, "ai_gateway", &gateway)
	contextNotes := cfg.MaxContextNotes
	if contextNotes < 2 {
		contextNotes = 20
	}
	outputTokenLimit := cfg.TokenLimit
	if outputTokenLimit < 64 {
		outputTokenLimit = 320
	}
	estimatedInputTokens := contextNotes * 300
	estimatedCostPerCall := int64(float64(estimatedInputTokens)*gateway.InputCostPerMillion + float64(outputTokenLimit)*gateway.OutputCostPerMillion)
	out["expectedMonthlyCalls"] = expectedCalls
	out["estimatedMonthlyCostMicros"] = expectedCalls * estimatedCostPerCall
	return out, nil
}
