package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/hkjang/umm/internal/auth"
	"github.com/hkjang/umm/internal/cryptoutil"
	"github.com/hkjang/umm/internal/dream"
	"github.com/hkjang/umm/internal/mcp"
	"github.com/hkjang/umm/internal/observability"
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
	Version  string
	WebDir   string
}

func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID, middleware.RealIP, middleware.Recoverer, middleware.RequestSize(1<<20), s.securityHeaders, s.accessLog, s.Auth.Middleware)
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
		api.Use(s.verifyWriteOrigin)
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
			protected.Post("/ai/assist", s.aiAssist)
			protected.Delete("/notes/{noteID}", s.deleteNote)
			protected.Post("/spaces/{spaceID}/edges", s.createEdge)
			protected.Get("/notifications", s.listNotifications)
			protected.Post("/notifications/{notificationID}/read", s.readNotification)
			protected.Group(func(account chi.Router) {
				account.Use(s.requireSession)
				account.Get("/preferences", s.getPreferences)
				account.Put("/preferences", s.putPreferences)
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
			protected.Post("/dreams/{dreamID}/regenerate", s.regenerateDream)
			protected.Post("/dreams/{dreamID}/develop", s.developDream)
			protected.Post("/dreams/{dreamID}/developed-note", s.saveDevelopedDream)
			protected.Post("/approvals", s.createApproval)
			protected.Get("/approvals", s.listApprovals)
			protected.Post("/approvals/{requestID}/decision", s.decideApproval)
			protected.Route("/admin", func(admin chi.Router) {
				admin.Use(s.requireSession, auth.RequireAdmin)
				admin.Get("/settings", s.adminSettings)
				admin.Put("/settings/{section}", s.putAdminSetting)
				admin.Post("/oidc/test", s.testOIDC)
				admin.Get("/users", s.adminUsers)
				admin.Put("/users/{userID}", s.updateUser)
				admin.Get("/metrics", s.adminMetrics)
				admin.Post("/dreams/run", s.runDreams)
				admin.Get("/audit", s.adminAudit)
				admin.Get("/security/encryption", s.encryptionKeyStatus)
				admin.Post("/security/encryption/rotate", s.rotateEncryptionKey)
				admin.Get("/ai-evals", s.listAIEvals)
				admin.Post("/ai-evals", s.createAIEval)
				admin.Delete("/ai-evals/{caseID}", s.deleteAIEval)
				admin.Post("/ai-evals/{caseID}/run", s.runAIEval)
			})
		})
	})
	r.Handle("/mcp", &mcp.Handler{Store: s.Store, Dreams: s.Dreams, Version: s.Version})
	r.Handle("/*", s.spa())
	return observability.Wrap(r)
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		next.ServeHTTP(w, r)
	})
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
	if !requireScope(w, r, "metrics:read") {
		return
	}
	if s.Metrics == nil {
		writeError(w, http.StatusServiceUnavailable, "운영 지표 수집기가 준비되지 않았습니다.")
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	s.Metrics.Prometheus(w, s.Version)
}

func (s *Server) spa() http.Handler {
	dir := s.WebDir
	if dir == "" {
		dir = "web/dist"
	}
	fileServer := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}
		clean := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if clean == "." {
			clean = "index.html"
		}
		candidate := filepath.Join(dir, clean)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			if clean != "index.html" && strings.Contains(filepath.Base(candidate), ".") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			fileServer.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFile(w, r, filepath.Join(dir, "index.html"))
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
