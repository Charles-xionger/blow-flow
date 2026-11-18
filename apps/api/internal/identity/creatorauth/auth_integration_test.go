//go:build integration

package creatorauth

import (
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/identity/localauth"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pressly/goose/v3"
)

func TestCreatorTokenIsBoundToActiveProvisionedUser(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	_, admin, err := database.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("creator_%d", time.Now().UnixNano())
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
	id := "00000000-0000-0000-0000-000000000076"
	hash, err := localauth.PasswordHash("test-password-long-enough")
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`INSERT INTO users(id,email,status,created_at,updated_at) VALUES(?,'creator@example.com','active',now(),now())`, id).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`INSERT INTO user_roles(user_id,role,created_at) VALUES(?,'user',now())`, id).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`INSERT INTO user_identities(issuer,subject,user_id,created_at,last_seen_at) VALUES(?,?,?,now(),now())`, Issuer, id, id).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`INSERT INTO creator_credentials(user_id,password_hash,created_at,updated_at) VALUES(?,?,now(),now())`, id, hash).Error; err != nil {
		t.Fatal(err)
	}
	clock := time.Now().UTC().Truncate(time.Second)
	auth, err := New(db, []byte(strings.Repeat("k", 32)), func() time.Time { return clock })
	if err != nil {
		t.Fatal(err)
	}
	if _, err = auth.Authenticate(context.Background(), "creator@example.com", "wrong"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("wrong password: %v", err)
	}
	identity, err := auth.Authenticate(context.Background(), "CREATOR@example.com", "test-password-long-enough")
	if err != nil || identity.Subject != id {
		t.Fatalf("login: %+v %v", identity, err)
	}
	token, err := auth.Issue(identity)
	if err != nil {
		t.Fatal(err)
	}
	got, err := auth.Verify(context.Background(), token)
	if err != nil || got.Subject != id {
		t.Fatalf("verify: %+v %v", got, err)
	}
	if err = db.Exec(`UPDATE users SET status='disabled' WHERE id=?`, id).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = auth.Verify(context.Background(), token); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("disabled token: %v", err)
	}
}
