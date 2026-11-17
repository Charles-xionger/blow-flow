package account

import (
	"context"
	"errors"
	"testing"
	"time"
)

type repositoryStub struct {
	resolve func(context.Context, Identity, Role) (User, error)
	list    func(context.Context, ListUsersQuery) (UserPage, error)
	status  func(context.Context, StatusChange) (User, error)
	audit   func(context.Context, ListAuditQuery) (AuditPage, error)
}

func (r repositoryStub) ResolveIdentity(ctx context.Context, identity Identity, bootstrap Role) (User, error) {
	return r.resolve(ctx, identity, bootstrap)
}
func (r repositoryStub) ListUsers(ctx context.Context, query ListUsersQuery) (UserPage, error) {
	return r.list(ctx, query)
}
func (r repositoryStub) ChangeStatus(ctx context.Context, change StatusChange) (User, error) {
	return r.status(ctx, change)
}
func (r repositoryStub) ListAuditEvents(ctx context.Context, query ListAuditQuery) (AuditPage, error) {
	return r.audit(ctx, query)
}

func TestResolveRejectsUnverifiedIdentity(t *testing.T) {
	called := false
	service := NewService(repositoryStub{resolve: func(context.Context, Identity, Role) (User, error) {
		called = true
		return User{}, nil
	}}, "owner-subject", time.Now)

	_, err := service.Resolve(context.Background(), Identity{
		Issuer: "https://identity.example", Subject: "person-1", Email: "person@example.com",
	})

	if !errors.Is(err, ErrEmailUnverified) {
		t.Fatalf("Resolve() error = %v, want ErrEmailUnverified", err)
	}
	if called {
		t.Fatal("unverified identity reached repository")
	}
}

func TestResolveBootstrapsOnlyConfiguredInitialAdministrator(t *testing.T) {
	var roles []Role
	repo := repositoryStub{resolve: func(_ context.Context, _ Identity, role Role) (User, error) {
		roles = append(roles, role)
		return User{ID: "user-1", Role: role, Status: StatusActive}, nil
	}}
	service := NewService(repo, "owner-subject", time.Now)

	for _, subject := range []string{"member-subject", "owner-subject"} {
		_, err := service.Resolve(context.Background(), Identity{
			Issuer: "https://identity.example", Subject: subject, Email: subject + "@example.com", EmailVerified: true,
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	want := []Role{RoleUser, RoleAdmin}
	for i := range want {
		if roles[i] != want[i] {
			t.Fatalf("role[%d] = %q, want %q", i, roles[i], want[i])
		}
	}
}

func TestDisableUserRequiresAdministratorMFAAndRecentAuthentication(t *testing.T) {
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	called := 0
	repo := repositoryStub{status: func(_ context.Context, change StatusChange) (User, error) {
		called++
		if change.ActorID != "admin-1" || change.TargetID != "user-2" || change.Reason != "abuse" {
			t.Fatalf("unexpected change: %+v", change)
		}
		return User{ID: change.TargetID, Status: change.Status}, nil
	}}
	service := NewService(repo, "", func() time.Time { return now })
	admin := User{ID: "admin-1", Role: RoleAdmin, Status: StatusActive}

	proofs := []AuthProof{
		{MFA: false, AuthenticatedAt: now},
		{MFA: true, AuthenticatedAt: now.Add(-11 * time.Minute)},
	}
	for _, proof := range proofs {
		_, err := service.ChangeStatus(context.Background(), admin, proof, "user-2", StatusDisabled, "abuse")
		if !errors.Is(err, ErrRecentMFARequired) {
			t.Fatalf("ChangeStatus() error = %v, want ErrRecentMFARequired", err)
		}
	}
	if called != 0 {
		t.Fatal("status mutation happened without recent MFA")
	}

	_, err := service.ChangeStatus(context.Background(), admin, AuthProof{MFA: true, AuthenticatedAt: now.Add(-9 * time.Minute)}, "user-2", StatusDisabled, "abuse")
	if err != nil {
		t.Fatal(err)
	}
	if called != 1 {
		t.Fatalf("status mutations = %d, want 1", called)
	}
}
