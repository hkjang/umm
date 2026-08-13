package httpapi

import (
	"context"
	"encoding/json"
	"errors"
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
	"github.com/hkjang/umm/internal/store"
)

type Server struct {
	Store   *store.Store
	Auth    *auth.Service
	OIDC    *auth.OIDCService
	Cipher  *cryptoutil.Cipher
	Dreams  *dream.Service
	Version string
	WebDir  string
}

func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID, middleware.RealIP, middleware.Recoverer, s.securityHeaders, s.accessLog, s.Auth.Middleware)
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
		api.Get("/meta", s.meta)
		api.Post("/auth/login", s.login)
		api.Get("/auth/oidc/start", s.OIDC.Start)
		api.Get("/auth/oidc/callback", s.OIDC.Callback)
		api.Group(func(protected chi.Router) {
			protected.Use(auth.Require)
			protected.Post("/auth/logout", s.logout)
			protected.Get("/me", s.me)
			protected.Get("/spaces", s.listSpaces)
			protected.Post("/spaces", s.createSpace)
			protected.Get("/spaces/{spaceID}/notes", s.listNotes)
			protected.Post("/spaces/{spaceID}/notes", s.createNote)
			protected.Put("/notes/{noteID}", s.updateNote)
			protected.Delete("/notes/{noteID}", s.deleteNote)
			protected.Post("/spaces/{spaceID}/edges", s.createEdge)
			protected.Get("/preferences", s.getPreferences)
			protected.Put("/preferences", s.putPreferences)
			protected.Get("/api-keys", s.listAPIKeys)
			protected.Post("/api-keys", s.createAPIKey)
			protected.Put("/api-keys/{keyID}", s.updateAPIKey)
			protected.Post("/api-keys/{keyID}/rotate", s.rotateAPIKey)
			protected.Delete("/api-keys/{keyID}", s.revokeAPIKey)
			protected.Get("/dreams", s.dreamHistory)
			protected.Post("/dreams/{dreamID}/feedback", s.dreamFeedback)
			protected.Post("/approvals", s.createApproval)
			protected.Get("/approvals", s.listApprovals)
			protected.Post("/approvals/{requestID}/decision", s.decideApproval)
			protected.Route("/admin", func(admin chi.Router) {
				admin.Use(auth.RequireAdmin)
				admin.Get("/settings", s.adminSettings)
				admin.Put("/settings/{section}", s.putAdminSetting)
				admin.Post("/oidc/test", s.testOIDC)
				admin.Get("/users", s.adminUsers)
				admin.Put("/users/{userID}", s.updateUser)
				admin.Get("/metrics", s.adminMetrics)
				admin.Post("/dreams/run", s.runDreams)
				admin.Get("/audit", s.adminAudit)
			})
		})
	})
	r.Handle("/mcp", &mcp.Handler{Store: s.Store, Dreams: s.Dreams, Version: s.Version})
	r.Handle("/*", s.spa())
	return r
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
		next.ServeHTTP(w, r)
		if !strings.HasPrefix(r.URL.Path, "/health") {
			slog.Info("http request", "method", r.Method, "path", r.URL.Path, "duration_ms", time.Since(start).Milliseconds())
		}
	})
}

func (s *Server) spa() http.Handler {
	dir := s.WebDir
	if dir == "" {
		dir = "web/dist"
	}
	fileServer := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
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
	return nil
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
func principal(r *http.Request) auth.Principal { p, _ := auth.PrincipalFrom(r.Context()); return p }
func notFound(err error) bool {
	return errors.Is(err, os.ErrNotExist) || strings.Contains(err.Error(), "no rows")
}
func contextWithTimeout(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), d)
}
