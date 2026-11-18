//go:build integration

package session

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"blow-flow/api/internal/account"
	"blow-flow/api/internal/database"
	"github.com/pressly/goose/v3"
)

func TestRefreshSessionRotatesOnceAndExpires(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("TEST_DATABASE_URL is required")
	}
	_, admin, err := database.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("refresh_%d", time.Now().UnixNano())
	if _, err = admin.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec("DROP SCHEMA " + schema + " CASCADE")
	u, _ := url.Parse(dsn)
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	db, pool, err := database.Open(u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err = goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	migrations, _ := filepath.Abs("../../../migrations")
	if err = goose.Up(pool, migrations); err != nil {
		t.Fatal(err)
	}
	userID := "00000000-0000-0000-0000-000000000099"
	if err = db.Exec(`INSERT INTO users(id,email,status,created_at,updated_at) VALUES(?,'admin@example.com','active',now(),now())`, userID).Error; err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	store := Store{DB: db, Now: func() time.Time { return now }}
	identity := account.Identity{Issuer: "blow-flow-local", Subject: "bootstrap-admin", Email: "admin@example.com", EmailVerified: true, AuthenticatedAt: now}
	raw, err := store.Issue(context.Background(), account.User{ID: userID}, identity)
	if err != nil {
		t.Fatal(err)
	}
	got, next, err := store.Rotate(context.Background(), raw, identity.Issuer)
	if err != nil || got.Subject != identity.Subject || next == raw {
		t.Fatalf("rotation: %+v %v", got, err)
	}
	if _, _, err = store.Rotate(context.Background(), raw, identity.Issuer); err != ErrInvalid {
		t.Fatalf("old token reused: %v", err)
	}
	if err = store.Revoke(context.Background(), next, identity.Issuer); err != nil {
		t.Fatal(err)
	}
	if _, _, err = store.Rotate(context.Background(), next, identity.Issuer); err != ErrInvalid {
		t.Fatalf("revoked token: %v", err)
	}
	if err = db.Exec(`UPDATE users SET email='new@example.com' WHERE id=?`, userID).Error; err != nil {
		t.Fatal(err)
	}
	raw, err = store.Issue(context.Background(), account.User{ID: userID}, identity)
	if err != nil {
		t.Fatal(err)
	}
	updated, updatedNext, err := store.Rotate(context.Background(), raw, identity.Issuer)
	if err != nil || updated.Email != "new@example.com" {
		t.Fatalf("current email: %+v %v", updated, err)
	}
	if err = db.Exec(`UPDATE users SET status='disabled' WHERE id=?`, userID).Error; err != nil {
		t.Fatal(err)
	}
	if _, _, err = store.Rotate(context.Background(), updatedNext, identity.Issuer); err != ErrInvalid {
		t.Fatalf("disabled account: %v", err)
	}
	if err = db.Exec(`UPDATE users SET status='active' WHERE id=?`, userID).Error; err != nil {
		t.Fatal(err)
	}
	raw, err = store.Issue(context.Background(), account.User{ID: userID}, identity)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(Lifetime + time.Second)
	if _, _, err = store.Rotate(context.Background(), raw, identity.Issuer); err != ErrInvalid {
		t.Fatalf("expired token: %v", err)
	}
}
