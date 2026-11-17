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
)

type verifierStub struct {
	identity account.Identity
	err      error
}

func (v verifierStub) Verify(context.Context, string) (account.Identity, error) {
	return v.identity, v.err
}

type accountServiceStub struct {
	resolved account.User
	changed  account.User
	changeID string
}

func (s *accountServiceStub) Resolve(context.Context, account.Identity) (account.User, error) {
	return s.resolved, nil
}
func (s *accountServiceStub) ListUsers(context.Context, account.User, account.AuthProof, account.ListUsersQuery) (account.UserPage, error) {
	return account.UserPage{Users: []account.User{s.resolved}}, nil
}
func (s *accountServiceStub) ChangeStatus(_ context.Context, _ account.User, _ account.AuthProof, targetID string, status account.Status, _ string) (account.User, error) {
	s.changeID = targetID
	s.changed.Status = status
	return s.changed, nil
}
func (s *accountServiceStub) ListAuditEvents(context.Context, account.User, account.AuthProof, account.ListAuditQuery) (account.AuditPage, error) {
	return account.AuditPage{Events: []account.AuditEvent{{ID: "audit-1"}}}, nil
}

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
		changed:  account.User{ID: "user-2", Role: account.RoleUser},
	}
	router := NewWithDependencies(Dependencies{
		Accounts:         service,
		IdentityVerifier: verifierStub{identity: account.Identity{Issuer: "https://identity.example", Subject: "admin", Email: "admin@example.com", EmailVerified: true, MFA: true, AuthenticatedAt: now}},
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/v1/admin/users/user-2/status", strings.NewReader(`{"status":"disabled","reason":"abuse"}`))
	req.Header.Set("Authorization", "Bearer valid-token")
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if service.changeID != "user-2" || service.changed.Status != account.StatusDisabled {
		t.Fatalf("change = %q %+v", service.changeID, service.changed)
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
