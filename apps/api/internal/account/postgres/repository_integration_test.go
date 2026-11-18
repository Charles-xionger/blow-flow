//go:build integration

package postgres

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"blow-flow/api/internal/account"
	"blow-flow/api/internal/database"
	"github.com/pressly/goose/v3"
)

func TestAccountRepositoryOwnsIdentityStatusAndAuditTransaction(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("TEST_DATABASE_URL is required; integration tests must not silently skip")
	}
	_, admin, err := database.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("account_%d", time.Now().UnixNano())
	if _, err = admin.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec("DROP SCHEMA " + schema + " CASCADE")

	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	db, pool, err := database.Open(parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err = goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	migrations, err := filepath.Abs("../../../migrations")
	if err != nil {
		t.Fatal(err)
	}
	if err = goose.Up(pool, migrations); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	repository := New(db, func() time.Time { return now })
	identity := account.Identity{Issuer: "https://identity.example", Subject: "admin-subject", Email: "ADMIN@EXAMPLE.COM", EmailVerified: true}

	var users [2]account.User
	var errs [2]error
	var wait sync.WaitGroup
	for i := range users {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			users[index], errs[index] = repository.ResolveIdentity(context.Background(), identity, account.IdentityProvisioning{MayBecomeInitialAdministrator: true})
		}(i)
	}
	wait.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if users[0].ID != users[1].ID {
		t.Fatalf("concurrent identity resolution created %q and %q", users[0].ID, users[1].ID)
	}
	if users[0].Email != "admin@example.com" {
		t.Fatalf("email = %q", users[0].Email)
	}

	member, err := repository.ResolveIdentity(context.Background(), account.Identity{Issuer: identity.Issuer, Subject: "member-subject", Email: "member@example.com", EmailVerified: true}, account.IdentityProvisioning{})
	if err != nil {
		t.Fatal(err)
	}
	secondCandidate, err := repository.ResolveIdentity(context.Background(), account.Identity{Issuer: identity.Issuer, Subject: "second-admin", Email: "second@example.com", EmailVerified: true}, account.IdentityProvisioning{MayBecomeInitialAdministrator: true})
	if err != nil {
		t.Fatal(err)
	}
	if secondCandidate.Role != account.RoleUser {
		t.Fatalf("second initial-administrator candidate role = %q", secondCandidate.Role)
	}
	localAdmin, err := repository.ResolveIdentity(context.Background(), account.Identity{Issuer: "blow-flow-local", Subject: "bootstrap-admin", Email: "admin@example.com", EmailVerified: true}, account.IdentityProvisioning{MayBecomeInitialAdministrator: true, LinkExistingAdministratorByEmail: true})
	if err != nil || localAdmin.ID != users[0].ID {
		t.Fatalf("local admin identity did not link to existing administrator: %+v, %v", localAdmin, err)
	}
	_, err = repository.ResolveIdentity(context.Background(), account.Identity{Issuer: "blow-flow-local", Subject: "other-bootstrap", Email: "stranger@example.com", EmailVerified: true}, account.IdentityProvisioning{MayBecomeInitialAdministrator: true, LinkExistingAdministratorByEmail: true})
	if !errors.Is(err, account.ErrForbidden) {
		t.Fatalf("unmatched local identity was not rejected: %v", err)
	}
	changed, err := repository.DisableUser(context.Background(), account.DisableUser{ActorID: users[0].ID, TargetID: member.ID, Reason: "abuse", At: now.Add(time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	if changed.Status != account.StatusDisabled {
		t.Fatalf("status = %q", changed.Status)
	}
	page, err := repository.ListAuditEvents(context.Background(), account.ListAuditQuery{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Events) != 1 || page.Events[0].ActorID != users[0].ID || page.Events[0].TargetID != member.ID {
		t.Fatalf("audit events = %+v", page.Events)
	}
	if page.Events[0].Metadata["reason"] != "abuse" {
		t.Fatalf("audit metadata = %+v", page.Events[0].Metadata)
	}
	if err := repository.AppendAdminLogin(context.Background(), users[0].ID, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	page, err = repository.ListAuditEvents(context.Background(), account.ListAuditQuery{Limit: 10})
	if err != nil || len(page.Events) != 2 || page.Events[0].Action != "admin.logged_in" {
		t.Fatalf("login audit events = %+v, error = %v", page.Events, err)
	}

	usersPage, err := repository.ListUsers(context.Background(), account.ListUsersQuery{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(usersPage.Users) != 1 || usersPage.NextCursor == "" {
		t.Fatalf("users page = %+v", usersPage)
	}
}
