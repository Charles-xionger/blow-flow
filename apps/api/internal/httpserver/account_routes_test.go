package httpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"blow-flow/api/internal/account"
	"blow-flow/api/internal/identity/localauth"
)

type verifierStub struct {
	identity account.Identity
	err      error
}

type captchaStub struct{ used bool }

func (*captchaStub) Generate() (string, string, error) {
	return "challenge-1", "data:image/png;base64,example", nil
}

func (c *captchaStub) Verify(id, answer string) bool {
	if c.used || id != "challenge-1" {
		return false
	}
	c.used = true
	return answer == "1234"
}

func TestLocalAdminLoginIssuesTokenForRealAccountRoutes(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	hash, err := localauth.PasswordHash("test-password-long-enough")
	if err != nil {
		t.Fatal(err)
	}
	auth, err := localauth.New(localauth.Config{Email: "admin@example.com", PasswordHash: hash, SigningKey: []byte(strings.Repeat("k", 32))}, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	router := NewWithDependencies(Dependencies{Accounts: &accountServiceStub{resolved: account.User{ID: "admin-1", Email: "admin@example.com", Role: account.RoleAdmin, Status: account.StatusActive}}, IdentityVerifier: auth, LocalAdmin: auth, Captcha: &captchaStub{}})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/auth/admin/login", strings.NewReader(`{"email":"admin@example.com","password":"test-password-long-enough","captchaId":"challenge-1","captchaAnswer":"1234"}`))
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("login status = %d body=%s", w.Code, w.Body.String())
	}
	var response struct {
		AccessToken string `json:"accessToken"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.AccessToken == "" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("login did not return a protected token")
	}
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/v1/admin/users", nil)
	req.Header.Set("Authorization", "Bearer "+response.AccessToken)
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("admin route status = %d body=%s", w.Code, w.Body.String())
	}
}

func TestAdminLoginConsumesMalformedImageAnswer(t *testing.T) {
	challenge := &captchaStub{}
	router := NewWithDependencies(Dependencies{Accounts: &accountServiceStub{}, LocalAdmin: &authenticatorStub{}, Captcha: challenge})
	for _, body := range []string{
		`{"email":"admin@example.com","password":"password","captchaId":"challenge-1","captchaAnswer":"xx"}`,
		`{"email":"admin@example.com","password":"password","captchaId":"challenge-1","captchaAnswer":"1234"}`,
	} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v1/auth/admin/login", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", w.Code)
		}
		assertErrorCode(t, w, "invalid_captcha")
	}
}

type authenticatorStub struct{}

func (*authenticatorStub) Authenticate(string, string) (account.Identity, error) {
	panic("password verifier must not run before image verification")
}
func (*authenticatorStub) Issue(account.Identity) (string, error) { return "", nil }

func TestImageCaptchaEndpointIsUncached(t *testing.T) {
	router := NewWithDependencies(Dependencies{Captcha: &captchaStub{}})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/auth/captcha", nil))
	if w.Code != http.StatusOK || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Body.String(), `"id":"challenge-1"`) {
		t.Fatalf("captcha response = %d %s", w.Code, w.Body.String())
	}
}

func TestImageCaptchaEndpointLimitsIssuance(t *testing.T) {
	router := NewWithDependencies(Dependencies{Captcha: &captchaStub{}})
	for i := 0; i < 11; i++ {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/auth/captcha", nil))
		if i == 10 {
			if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") != "1" {
				t.Fatalf("request %d = %d, want 429 with retry", i+1, w.Code)
			}
		} else if w.Code != http.StatusOK {
			t.Fatalf("request %d = %d, want 200", i+1, w.Code)
		}
	}
}

func (v verifierStub) Verify(context.Context, string) (account.Identity, error) {
	return v.identity, v.err
}

type accountServiceStub struct {
	resolved  account.User
	disabled  account.User
	disableID string
}

func (s *accountServiceStub) Resolve(context.Context, account.Identity) (account.User, error) {
	return s.resolved, nil
}
func (s *accountServiceStub) ListUsers(context.Context, account.User, account.ListUsersQuery) (account.UserPage, error) {
	return account.UserPage{Users: []account.User{s.resolved}}, nil
}
func (s *accountServiceStub) DisableUser(_ context.Context, _ account.User, _ account.AuthProof, targetID string, _ string) (account.User, error) {
	s.disableID = targetID
	s.disabled.Status = account.StatusDisabled
	return s.disabled, nil
}
func (s *accountServiceStub) ListAuditEvents(context.Context, account.User, account.ListAuditQuery) (account.AuditPage, error) {
	return account.AuditPage{Events: []account.AuditEvent{{ID: "audit-1"}}}, nil
}
func (s *accountServiceStub) RecordAdminLogin(context.Context, account.User) error { return nil }

func TestAccountRoutesRequireBearerAuthentication(t *testing.T) {
	router := NewWithDependencies(Dependencies{Accounts: &accountServiceStub{}, IdentityVerifier: verifierStub{}})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/v1/me", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	assertErrorCode(t, w, "unauthorized")
}

func TestMeReturnsLocalBusinessIdentity(t *testing.T) {
	user := account.User{ID: "local-user-1", Email: "person@example.com", Role: account.RoleUser, Status: account.StatusActive}
	router := NewWithDependencies(Dependencies{
		Accounts:         &accountServiceStub{resolved: user},
		IdentityVerifier: verifierStub{identity: account.Identity{Issuer: "https://identity.example", Subject: "external-subject", Email: user.Email, EmailVerified: true}},
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer valid-token")
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var body struct {
		User account.User `json:"user"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.User.ID != "local-user-1" {
		t.Fatalf("user = %+v", body.User)
	}
}

func TestAdminCanDisableUserThroughVersionedAPI(t *testing.T) {
	now := time.Now().UTC()
	service := &accountServiceStub{
		resolved: account.User{ID: "admin-1", Role: account.RoleAdmin, Status: account.StatusActive},
		disabled: account.User{ID: "user-2", Role: account.RoleUser},
	}
	router := NewWithDependencies(Dependencies{
		Accounts:         service,
		IdentityVerifier: verifierStub{identity: account.Identity{Issuer: "https://identity.example", Subject: "admin", Email: "admin@example.com", EmailVerified: true, AuthenticatedAt: now}},
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/admin/users/user-2/disable", strings.NewReader(`{"reason":"abuse"}`))
	req.Header.Set("Authorization", "Bearer valid-token")
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if service.disableID != "user-2" || service.disabled.Status != account.StatusDisabled {
		t.Fatalf("disable = %q %+v", service.disableID, service.disabled)
	}
}

func assertErrorCode(t *testing.T, w *httptest.ResponseRecorder, want string) {
	t.Helper()
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error != want {
		t.Fatalf("error = %q, want %q", body.Error, want)
	}
}
