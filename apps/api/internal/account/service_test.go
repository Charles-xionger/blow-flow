package account

import (
	"context"
	"errors"
	"testing"
	"time"
)

type repositoryStub struct {
	resolve func(context.Context, Identity, IdentityProvisioning) (User, error)
	list    func(context.Context, ListUsersQuery) (UserPage, error)
	disable func(context.Context, DisableUser) (User, error)
	audit   func(context.Context, ListAuditQuery) (AuditPage, error)
	login   func(context.Context, string, time.Time) error
}

func (r repositoryStub) ResolveIdentity(ctx context.Context, identity Identity, provisioning IdentityProvisioning) (User, error) {
	return r.resolve(ctx, identity, provisioning)
}
func (r repositoryStub) ListUsers(ctx context.Context, query ListUsersQuery) (UserPage, error) {
	return r.list(ctx, query)
}
func (r repositoryStub) DisableUser(ctx context.Context, command DisableUser) (User, error) {
	return r.disable(ctx, command)
}
func (r repositoryStub) ListAuditEvents(ctx context.Context, query ListAuditQuery) (AuditPage, error) {
	return r.audit(ctx, query)
}
func (r repositoryStub) AppendAdminLogin(ctx context.Context, userID string, at time.Time) error {
	if r.login != nil {
		return r.login(ctx, userID, at)
	}
	return nil
}

func TestResolveRejectsUnverifiedIdentity(t *testing.T) {
	called := false
	service := NewService(repositoryStub{resolve: func(context.Context, Identity, IdentityProvisioning) (User, error) {
		called = true
		return User{}, nil
	}}, InitialAdministrator{Issuer: "https://identity.example", Subject: "owner-subject"}, time.Now)

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
	var policies []IdentityProvisioning
	repo := repositoryStub{resolve: func(_ context.Context, _ Identity, provisioning IdentityProvisioning) (User, error) {
		policies = append(policies, provisioning)
		return User{ID: "user-1", Status: StatusActive}, nil
	}}
	service := NewService(repo, InitialAdministrator{Issuer: "https://identity.example", Subject: "owner-subject"}, time.Now)

	for _, subject := range []string{"member-subject", "owner-subject"} {
		_, err := service.Resolve(context.Background(), Identity{
			Issuer: "https://identity.example", Subject: subject, Email: subject + "@example.com", EmailVerified: true,
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	want := []bool{false, true}
	for i := range want {
		if policies[i].MayBecomeInitialAdministrator != want[i] {
			t.Fatalf("policy[%d] = %+v, want initial-admin=%v", i, policies[i], want[i])
		}
	}
	_, err := service.Resolve(context.Background(), Identity{Issuer: "https://other-issuer.example", Subject: "owner-subject", Email: "owner@example.com", EmailVerified: true})
	if err != nil {
		t.Fatal(err)
	}
	if policies[2].MayBecomeInitialAdministrator {
		t.Fatal("matching subject from another issuer could become administrator")
	}
}

func TestAdministratorCanResolveAfterPasswordAuthentication(t *testing.T) {
	repo := repositoryStub{resolve: func(context.Context, Identity, IdentityProvisioning) (User, error) {
		return User{ID: "admin-1", Role: RoleAdmin, Status: StatusActive}, nil
	}}
	service := NewService(repo, InitialAdministrator{}, time.Now)
	_, err := service.Resolve(context.Background(), Identity{Issuer: "https://identity.example", Subject: "admin", Email: "admin@example.com", EmailVerified: true})
	if err != nil {
		t.Fatalf("Resolve() error = %v", err)
	}
}

func TestDisableUserRequiresRecentAuthentication(t *testing.T) {
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	called := 0
	repo := repositoryStub{disable: func(_ context.Context, change DisableUser) (User, error) {
		called++
		if change.ActorID != "admin-1" || change.TargetID != "user-2" || change.Reason != "abuse" {
			t.Fatalf("unexpected change: %+v", change)
		}
		return User{ID: change.TargetID, Status: StatusDisabled}, nil
	}}
	service := NewService(repo, InitialAdministrator{}, func() time.Time { return now })
	admin := User{ID: "admin-1", Role: RoleAdmin, Status: StatusActive}

	proofs := []AuthProof{
		{},
		{AuthenticatedAt: now.Add(-11 * time.Minute)},
	}
	for _, proof := range proofs {
		_, err := service.DisableUser(context.Background(), admin, proof, "user-2", "abuse")
		if !errors.Is(err, ErrRecentAuthenticationRequired) {
			t.Fatalf("ChangeStatus() error = %v, want ErrRecentAuthenticationRequired", err)
		}
	}
	if called != 0 {
		t.Fatal("status mutation happened without recent authentication")
	}

	_, err := service.DisableUser(context.Background(), admin, AuthProof{AuthenticatedAt: now.Add(-9 * time.Minute)}, "user-2", "abuse")
	if err != nil {
		t.Fatal(err)
	}
	if called != 1 {
		t.Fatalf("status mutations = %d, want 1", called)
	}
}

func TestAdministratorCannotDisableOwnAccount(t *testing.T) {
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	service := NewService(repositoryStub{disable: func(context.Context, DisableUser) (User, error) {
		t.Fatal("repository called for self-disable")
		return User{}, nil
	}}, InitialAdministrator{}, func() time.Time { return now })
	admin := User{ID: "admin-1", Role: RoleAdmin, Status: StatusActive}
	_, err := service.DisableUser(context.Background(), admin, AuthProof{AuthenticatedAt: now}, admin.ID, "mistake")
	if !errors.Is(err, ErrCannotDisableSelf) {
		t.Fatalf("DisableUser() error = %v, want ErrCannotDisableSelf", err)
	}
}
