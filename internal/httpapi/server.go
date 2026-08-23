package httpapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/hkjang/umm/internal/auth"
	"github.com/hkjang/umm/internal/cryptoutil"
	"github.com/hkjang/umm/internal/dream"
	"github.com/hkjang/umm/internal/mcp"
	"github.com/hkjang/umm/internal/observability"
	"github.com/hkjang/umm/internal/realtime"
	"github.com/hkjang/umm/internal/store"
	"github.com/hkjang/umm/internal/webhook"
)

type Server struct {
	Store    *store.Store
	Auth     *auth.Service
	OIDC     *auth.OIDCService
	Cipher   *cryptoutil.Cipher
	Dreams   *dream.Service
	Webhooks *webhook.Service
	Metrics  *observability.Registry
	Events   *realtime.Hub
	Version  string
	WebDir   string
	// TrustedProxies contains only reverse proxies that may supply forwarding
	// headers. An empty list is the secure default for direct deployments.
	TrustedProxies []netip.Prefix

	limiterOnce sync.Once
	limiter     *rateLimiter

	policyMu       sync.Mutex
	policy         securityPolicy
	policyLoadedAt time.Time
}

// Handler returns the traced HTTP handler the server listens with.
func (s *Server) Handler() http.Handler {
	return observability.Wrap(s.router())
}

// router builds the route tree. It is separate from Handler so tests can walk
// the routes: the tracing wrapper hides them.
func (s *Server) router() chi.Router {
	s.limiterOnce.Do(func() { s.limiter = newRateLimiter() })
	r := chi.NewRouter()
	r.Use(middleware.RequestID, s.trustedProxyHeaders, middleware.Recoverer, middleware.RequestSize(1<<20), s.securityHeaders, s.accessLog, s.Auth.Middleware)
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"status": "ok", "version": s.Version})
	})
	r.Get("/readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := contextWithTimeout(r, 2*time.Second)
		defer cancel()
		if err := s.Store.Pool.Ping(ctx); err != nil {
			writeError(w, 503, "database unavailable")
			return
		}
		writeJSON(w, 200, map[string]string{"status": "ready"})
	})
	r.Route("/api/v1", func(api chi.Router) {
		api.Use(s.verifyWriteOrigin, s.rateLimit)
		api.Get("/meta", s.meta)
		api.Post("/auth/login", s.login)
		api.Get("/auth/oidc/start", s.OIDC.Start)
		api.Get("/auth/oidc/callback", s.OIDC.Callback)
		api.Group(func(protected chi.Router) {
			protected.Use(auth.Require, s.idempotency)
			protected.Post("/auth/logout", s.logout)
			protected.Get("/me", s.me)
			protected.Get("/metrics", s.prometheusMetrics)
			protected.Get("/today", s.todayReview)
			protected.Get("/morning-brief", s.morningBrief)
			protected.Get("/contradictions", s.contradictions)
			protected.Get("/open-questions", s.openQuestions)
			protected.Get("/onboarding", s.onboardingProgress)
			protected.Post("/onboarding/complete", s.completeOnboarding)
			protected.Get("/search", s.searchNotes)
			protected.Get("/spaces", s.listSpaces)
			protected.Post("/spaces", s.createSpace)
			protected.Put("/spaces/{spaceID}", s.updateSpace)
			protected.Delete("/spaces/{spaceID}", s.deleteSpace)
			protected.Get("/spaces/{spaceID}/notes", s.listNotes)
			protected.Get("/spaces/{spaceID}/events", s.spaceEvents)
			protected.Get("/spaces/{spaceID}/members", s.listSpaceMembers)
			protected.Post("/spaces/{spaceID}/members", s.shareSpace)
			protected.Delete("/spaces/{spaceID}/members/{memberID}", s.removeSpaceMember)
			protected.Post("/spaces/{spaceID}/notes", s.createNote)
			protected.Put("/notes/{noteID}", s.updateNote)
			protected.Get("/notes/{noteID}/related", s.relatedNotes)
			protected.Get("/notes/{noteID}/backlinks", s.noteBacklinks)
			protected.Post("/notes/{noteID}/review", s.reviewNote)
			protected.Get("/notes/{noteID}/comments", s.listComments)
			protected.Post("/notes/{noteID}/comments", s.createComment)
			protected.Put("/comments/{commentID}/resolve", s.resolveComment)
			protected.Delete("/comments/{commentID}", s.deleteComment)
			protected.Get("/notes/{noteID}/history", s.noteHistory)
			protected.Post("/notes/{noteID}/restore/{version}", s.restoreNote)
			protected.Get("/spaces/{spaceID}/clusters", s.thoughtClusters)
			protected.Get("/spaces/{spaceID}/export/authorize", s.authorizeExport)
			protected.Get("/spaces/{spaceID}/export/markdown", s.exportMarkdown)
			protected.Delete("/notes/{noteID}", s.deleteNote)
			protected.Post("/capture", s.captureThought)
			protected.Post("/notes/{noteID}/move", s.moveNote)
			protected.Post("/notes/{noteID}/merge", s.mergeNotes)
			protected.Get("/notes/{noteID}/space-suggestions", s.spaceSuggestions)
			protected.Post("/spaces/{spaceID}/edges", s.createEdge)
			protected.Delete("/edges/{edgeID}", s.deleteEdge)
			protected.Post("/edges/{edgeID}/accept", s.acceptSuggestion)
			protected.Post("/spaces/{spaceID}/links/suggest", s.suggestLinks)
			protected.Get("/notifications", s.listNotifications)
			protected.Post("/notifications/{notificationID}/read", s.readNotification)
			protected.Group(func(account chi.Router) {
				account.Use(s.requireSession)
				account.Get("/preferences", s.getPreferences)
				account.Put("/preferences", s.putPreferences)
				account.Get("/sessions", s.listSessions)
				account.Delete("/sessions/{sessionID}", s.revokeSession)
				account.Post("/sessions/revoke-others", s.revokeOtherSessions)
				account.Get("/api-keys", s.listAPIKeys)
				account.Post("/api-keys", s.createAPIKey)
				account.Put("/api-keys/{keyID}", s.updateAPIKey)
				account.Post("/api-keys/{keyID}/rotate", s.rotateAPIKey)
				account.Delete("/api-keys/{keyID}", s.revokeAPIKey)
			})
			protected.Get("/webhooks", s.listWebhooks)
			protected.Post("/webhooks", s.createWebhook)
			protected.Put("/webhooks/{webhookID}", s.updateWebhook)
			protected.Delete("/webhooks/{webhookID}", s.deleteWebhook)
			protected.Post("/webhooks/{webhookID}/test", s.testWebhook)
			protected.Post("/webhooks/{webhookID}/rotate-secret", s.rotateWebhookSecret)
			protected.Get("/dreams", s.dreamHistory)
			protected.Post("/dreams/{dreamID}/feedback", s.dreamFeedback)
			protected.Post("/dreams/{dreamID}/accept", s.acceptDream)
			protected.Post("/dreams/{dreamID}/developed-note", s.saveDevelopedDream)
			// Interactive generation gets a per-user burst guard here; the Dream
			// service applies the shared daily quota at the gateway boundary.
			protected.Group(func(paid chi.Router) {
				paid.Use(s.aiQuota)
				paid.Post("/ai/assist", s.aiAssist)
				paid.Post("/dreams/{dreamID}/regenerate", s.regenerateDream)
				paid.Post("/dreams/{dreamID}/develop", s.developDream)
			})
			protected.Post("/approvals", s.createApproval)
			protected.Get("/approvals", s.listApprovals)
			protected.Post("/approvals/{requestID}/decision", s.decideApproval)
			protected.Route("/admin", func(admin chi.Router) {
				admin.Use(s.requireSession, auth.RequireAdmin)
				admin.Get("/settings", s.adminSettings)
				admin.Put("/settings/{section}", s.putAdminSetting)
				admin.Post("/oidc/test", s.testOIDC)
				admin.Post("/ai-gateway/test", s.testEmbeddingGateway)
				admin.Get("/ai-gateway/discover", s.discoverEmbeddingGateways)
				admin.Get("/users", s.adminUsers)
				admin.Put("/users/{userID}", s.updateUser)
				admin.Get("/metrics", s.adminMetrics)
				admin.Get("/embedding-quality", s.embeddingQuality)
				admin.Post("/dreams/run", s.runDreams)
				admin.Get("/audit", s.adminAudit)
				admin.Get("/security/encryption", s.encryptionKeyStatus)
				admin.Post("/security/encryption/rotate", s.rotateEncryptionKey)
				admin.Get("/ai-evals", s.listAIEvals)
				admin.Post("/ai-evals", s.createAIEval)
				admin.Delete("/ai-evals/{caseID}", s.deleteAIEval)
				admin.With(s.aiQuota).Post("/ai-evals/{caseID}/run", s.runAIEval)
			})
		})
	})
	r.Handle("/mcp", &mcp.Handler{Store: s.Store, Dreams: s.Dreams, Version: s.Version})
	r.Handle("/*", s.spa())
	return r
}

type contextKey string

const cspNonceKey contextKey = "csp-nonce"

func cspNonce(r *http.Request) string {
	nonce, _ := r.Context().Value(cspNonceKey).(string)
	return nonce
}

// contentSecurityPolicy pins script execution to the exact bundle umm served.
//
// script-src uses a per-response nonce with 'strict-dynamic', so an injected
// <script src="..."> is refused even when it points at an allowed origin.
// style-src deliberately keeps 'unsafe-inline': Mantine writes its theme
// variables into a runtime <style> element and React Flow positions every node
// with a style attribute, so removing it would break the canvas without closing
// a comparable hole. Everything else is denied outright.
func contentSecurityPolicy(nonce string) string {
	return strings.Join([]string{
		"default-src 'self'",
		"img-src 'self' data: blob:",
		"font-src 'self' data:",
		"style-src 'self' 'unsafe-inline'",
		"style-src-attr 'unsafe-inline'",
		"script-src 'nonce-" + nonce + "' 'strict-dynamic' 'self'",
		"connect-src 'self'",
		"worker-src 'self'",
		"manifest-src 'self'",
		"object-src 'none'",
		"frame-src 'none'",
		"frame-ancestors 'none'",
		"base-uri 'self'",
		"form-action 'self'",
	}, "; ")
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nonce, err := randomNonce()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "보안 헤더를 준비하지 못했습니다.")
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("X-Permitted-Cross-Domain-Policies", "none")
		w.Header().Set("Content-Security-Policy", contentSecurityPolicy(nonce))
		// Only assert HSTS on a connection that already arrived over TLS, so a
		// plain-HTTP evaluation deployment does not lock its own browser out.
		if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), cspNonceKey, nonce)))
	})
}

func randomNonce() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawStdEncoding.EncodeToString(buf), nil
}
func (s *Server) accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		wrapped := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		if s.Metrics != nil {
			s.Metrics.Begin()
			defer func() {
				status := wrapped.Status()
				if status == 0 {
					status = http.StatusOK
				}
				s.Metrics.Observe(r.Method, chi.RouteContext(r.Context()).RoutePattern(), status, time.Since(start))
			}()
		}
		next.ServeHTTP(wrapped, r)
		if !strings.HasPrefix(r.URL.Path, "/health") {
			slog.Info("http request", "method", r.Method, "path", r.URL.Path, "duration_ms", time.Since(start).Milliseconds())
		}
	})
}

func (s *Server) prometheusMetrics(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	allowed := p.AuthType == "session" && p.User.Role == "admin"
	if p.AuthType == "api_key" {
		allowed = p.Scopes["metrics:read"]
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "운영 지표는 관리자 세션 또는 metrics:read API 키로만 조회할 수 있습니다.")
		return
	}
	if s.Metrics == nil {
		writeError(w, http.StatusServiceUnavailable, "운영 지표 수집기가 준비되지 않았습니다.")
		return
	}
	// The realtime figures live in the hub, so they are sampled at scrape time
	// rather than being pushed on every subscription change.
	if s.Events != nil {
		subscribers, spaces, delivered, listening := s.Events.Stats()
		s.Metrics.Gauge("umm_realtime_subscribers", float64(subscribers), "Open collaboration event subscriptions.")
		s.Metrics.Gauge("umm_realtime_spaces", float64(spaces), "Spaces with at least one open subscription.")
		s.Metrics.Gauge("umm_realtime_signals_total", float64(delivered), "Collaboration wake-ups delivered to subscribers.")
		listeningValue := 0.0
		if listening {
			listeningValue = 1
		}
		s.Metrics.Gauge("umm_realtime_listener_up", listeningValue, "1 when the PostgreSQL LISTEN connection is healthy.")
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	s.Metrics.Prometheus(w, s.Version)
}

// scriptTagPattern finds every script element in the shell document so the
// per-response CSP nonce can be attached to it.
var scriptTagPattern = regexp.MustCompile(`(?i)<script(\s|>)`)

// Vite's production bundle names end in an eight-character content hash.
// Stable PWA metadata and service-worker URLs live outside this convention and
// must revalidate on every release.
var contentHashedAssetPattern = regexp.MustCompile(`-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$`)

// nonceMarker lets the document expose its nonce to the bundle, which passes it
// to Mantine so runtime style elements are labelled too.
const nonceMarker = "__CSP_NONCE__"

func injectNonce(document []byte, nonce string) []byte {
	tagged := scriptTagPattern.ReplaceAll(document, []byte(`<script nonce="`+nonce+`"$1`))
	return bytes.ReplaceAll(tagged, []byte(nonceMarker), []byte(nonce))
}

func (s *Server) spa() http.Handler {
	dir := s.WebDir
	if dir == "" {
		dir = "web/dist"
	}
	fileServer := http.FileServer(http.Dir(dir))
	indexPath := filepath.Join(dir, "index.html")
	// The shell document is rewritten per request, so it is never served from
	// the static file handler and never cached.
	serveIndex := func(w http.ResponseWriter, r *http.Request) {
		document, err := os.ReadFile(indexPath)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		document = injectNonce(document, cspNonce(r))
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Content-Length", strconv.Itoa(len(document)))
		w.WriteHeader(http.StatusOK)
		if r.Method != http.MethodHead {
			_, _ = w.Write(document)
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}
		clean := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if clean == "." || clean == "index.html" {
			serveIndex(w, r)
			return
		}
		candidate := filepath.Join(dir, clean)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			webPath := filepath.ToSlash(clean)
			if strings.HasPrefix(webPath, "assets/") && contentHashedAssetPattern.MatchString(filepath.Base(webPath)) {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			fileServer.ServeHTTP(w, r)
			return
		}
		serveIndex(w, r)
	})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return err
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		if err == nil {
			return errors.New("request body must contain exactly one JSON value")
		}
		return err
	}
	return nil
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/problem+json; charset=utf-8")
	writeJSON(w, status, map[string]any{
		"type": "about:blank", "title": http.StatusText(status), "status": status,
		"detail": message, "error": message,
	})
}
func writeProblem(w http.ResponseWriter, r *http.Request, status int, problemType, title, detail string, extra map[string]any) {
	payload := map[string]any{
		"type":  "https://umm.local/problems/" + problemType,
		"title": title, "status": status, "detail": detail, "error": detail,
		"requestId": middleware.GetReqID(r.Context()),
	}
	for key, value := range extra {
		payload[key] = value
	}
	w.Header().Set("Content-Type", "application/problem+json; charset=utf-8")
	writeJSON(w, status, payload)
}
func principal(r *http.Request) auth.Principal { p, _ := auth.PrincipalFrom(r.Context()); return p }
func notFound(err error) bool {
	return errors.Is(err, os.ErrNotExist) || strings.Contains(err.Error(), "no rows")
}
func contextWithTimeout(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), d)
}
