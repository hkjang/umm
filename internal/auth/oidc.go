package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/hkjang/umm/internal/cryptoutil"
	"github.com/hkjang/umm/internal/store"
	"golang.org/x/oauth2"
)

type OIDCSettings struct {
	Enabled       bool     `json:"enabled"`
	IssuerURL     string   `json:"issuer_url"`
	ClientID      string   `json:"client_id"`
	ClientSecret  string   `json:"client_secret"`
	Scopes        []string `json:"scopes"`
	AdminGroup    string   `json:"admin_group"`
	TeamLeadGroup string   `json:"team_lead_group"`
}
type GeneralSettings struct {
	ServiceName  string `json:"service_name"`
	PublicURL    string `json:"public_url"`
	SessionHours int    `json:"session_hours"`
}

type OIDCService struct {
	Store    *store.Store
	Cipher   *cryptoutil.Cipher
	Sessions *Service
}

func (s *OIDCService) Enabled(ctx context.Context) bool {
	var cfg OIDCSettings
	return s.Store.GetSetting(ctx, "oidc", &cfg) == nil && cfg.Enabled
}
func (s *OIDCService) Test(ctx context.Context) error {
	_, _, _, err := s.configuration(ctx)
	return err
}

func (s *OIDCService) configuration(ctx context.Context) (OIDCSettings, *oidc.Provider, oauth2.Config, error) {
	var cfg OIDCSettings
	var general GeneralSettings
	if err := s.Store.GetSetting(ctx, "oidc", &cfg); err != nil {
		return cfg, nil, oauth2.Config{}, err
	}
	if !cfg.Enabled {
		return cfg, nil, oauth2.Config{}, errors.New("OIDC is disabled")
	}
	if err := s.Store.GetSetting(ctx, "general", &general); err != nil {
		return cfg, nil, oauth2.Config{}, err
	}
	issuer, err := url.Parse(cfg.IssuerURL)
	if err != nil || !(issuer.Scheme == "http" || issuer.Scheme == "https") || issuer.Host == "" {
		return cfg, nil, oauth2.Config{}, errors.New("invalid OIDC issuer URL")
	}
	secret := cfg.ClientSecret
	if strings.HasPrefix(secret, "enc:") {
		secret, err = s.Cipher.Decrypt(strings.TrimPrefix(secret, "enc:"))
		if err != nil {
			return cfg, nil, oauth2.Config{}, err
		}
	}
	provider, err := oidc.NewProvider(ctx, strings.TrimRight(cfg.IssuerURL, "/"))
	if err != nil {
		return cfg, nil, oauth2.Config{}, err
	}
	scopes := cfg.Scopes
	if len(scopes) == 0 {
		scopes = []string{oidc.ScopeOpenID, "profile", "email"}
	}
	if !slices.Contains(scopes, oidc.ScopeOpenID) {
		scopes = append([]string{oidc.ScopeOpenID}, scopes...)
	}
	callback := strings.TrimRight(general.PublicURL, "/") + "/api/v1/auth/oidc/callback"
	oauthCfg := oauth2.Config{ClientID: cfg.ClientID, ClientSecret: secret, Endpoint: provider.Endpoint(), RedirectURL: callback, Scopes: scopes}
	return cfg, provider, oauthCfg, nil
}

func (s *OIDCService) Start(w http.ResponseWriter, r *http.Request) {
	_, _, cfg, err := s.configuration(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	state, err := randomToken(32)
	if err != nil {
		http.Error(w, "unable to start login", 500)
		return
	}
	returnTo := r.URL.Query().Get("return_to")
	if !strings.HasPrefix(returnTo, "/") || strings.HasPrefix(returnTo, "//") {
		returnTo = "/"
	}
	_, err = s.Store.Pool.Exec(r.Context(), `INSERT INTO oauth_states(state_hash,return_to,expires_at) VALUES($1,$2,now()+interval '10 minutes')`, digest(state), returnTo)
	if err != nil {
		http.Error(w, "unable to start login", 500)
		return
	}
	http.Redirect(w, r, cfg.AuthCodeURL(state, oauth2.AccessTypeOffline), http.StatusFound)
}

func (s *OIDCService) Callback(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	code := r.URL.Query().Get("code")
	if state == "" || code == "" {
		http.Error(w, "invalid OIDC callback", 400)
		return
	}
	var returnTo string
	err := s.Store.Pool.QueryRow(r.Context(), `DELETE FROM oauth_states WHERE state_hash=$1 AND expires_at>now() RETURNING return_to`, digest(state)).Scan(&returnTo)
	if err != nil {
		http.Error(w, "OIDC state expired or invalid", 400)
		return
	}
	settings, provider, cfg, err := s.configuration(r.Context())
	if err != nil {
		http.Error(w, "OIDC configuration unavailable", 503)
		return
	}
	token, err := cfg.Exchange(r.Context(), code)
	if err != nil {
		http.Error(w, "OIDC token exchange failed", 401)
		return
	}
	rawID, ok := token.Extra("id_token").(string)
	if !ok {
		http.Error(w, "OIDC id_token missing", 401)
		return
	}
	idToken, err := provider.Verifier(&oidc.Config{ClientID: cfg.ClientID}).Verify(r.Context(), rawID)
	if err != nil {
		http.Error(w, "OIDC token verification failed", 401)
		return
	}
	var claims struct {
		Subject           string   `json:"sub"`
		PreferredUsername string   `json:"preferred_username"`
		Name              string   `json:"name"`
		Email             string   `json:"email"`
		Groups            []string `json:"groups"`
		RealmAccess       struct {
			Roles []string `json:"roles"`
		} `json:"realm_access"`
	}
	if err = idToken.Claims(&claims); err != nil {
		http.Error(w, "OIDC claims invalid", 401)
		return
	}
	groups := append(claims.Groups, claims.RealmAccess.Roles...)
	role := "user"
	if slices.Contains(groups, settings.AdminGroup) {
		role = "admin"
	} else if slices.Contains(groups, settings.TeamLeadGroup) {
		role = "team_lead"
	}
	u, err := s.Store.UpsertOIDCUser(r.Context(), claims.Subject, claims.PreferredUsername, claims.Name, claims.Email, role)
	if err != nil {
		http.Error(w, "unable to provision OIDC user", 500)
		return
	}
	session, err := s.Sessions.CreateSession(r.Context(), u.ID, OriginOf(r))
	if err != nil {
		http.Error(w, "unable to create session", 500)
		return
	}
	SetSessionCookie(w, r, session)
	s.Store.Audit(r.Context(), &u.ID, "auth.oidc.login", "user", u.ID.String(), json.RawMessage(`{}`))
	http.Redirect(w, r, returnTo, http.StatusFound)
}

func SetSessionCookie(w http.ResponseWriter, r *http.Request, token string) {
	secure := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	http.SetCookie(w, &http.Cookie{Name: CookieName, Value: token, Path: "/", HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode, Expires: time.Now().Add(30 * 24 * time.Hour), MaxAge: 30 * 86400})
}
func ClearSessionCookie(w http.ResponseWriter, r *http.Request) {
	secure := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	http.SetCookie(w, &http.Cookie{Name: CookieName, Value: "", Path: "/", HttpOnly: true, Secure: secure, SameSite: http.SameSiteLaxMode, Expires: time.Unix(0, 0), MaxAge: -1})
}
