package localauth

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestLocalAdministratorPasswordAndJWT(t *testing.T) {
	now := time.Date(2026, 11, 18, 7, 0, 0, 0, time.UTC)
	hash, err := PasswordHash("a-long-random-password-for-admin")
	if err != nil {
		t.Fatal(err)
	}
	auth, err := New(Config{Email: "Admin@Example.com", PasswordHash: hash, SigningKey: []byte(strings.Repeat("k", 32))}, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	if _, err := auth.Authenticate("admin@example.com", "wrong-password"); err == nil {
		t.Fatal("wrong password accepted")
	}
	identity, err := auth.Authenticate("admin@example.com", "a-long-random-password-for-admin")
	if err != nil {
		t.Fatal(err)
	}
	if identity.Subject != Subject {
		t.Fatalf("unexpected identity: %+v", identity)
	}
	token, err := auth.Issue(identity)
	if err != nil {
		t.Fatal(err)
	}
	verified, err := auth.Verify(context.Background(), token)
	if err != nil || verified.Email != "admin@example.com" {
		t.Fatalf("signed token failed verification: %+v %v", verified, err)
	}
	if _, err := auth.Verify(context.Background(), token+"x"); err == nil {
		t.Fatal("tampered token accepted")
	}
	now = now.Add(16 * time.Minute)
	if _, err := auth.Verify(context.Background(), token); err == nil {
		t.Fatal("expired token accepted")
	}
}

func TestLocalAdministratorRequiresCompleteConfiguration(t *testing.T) {
	if _, err := New(Config{Email: "admin@example.com"}, time.Now); err == nil {
		t.Fatal("incomplete configuration accepted")
	}
	if _, err := PasswordHash("short"); err == nil {
		t.Fatal("short password accepted")
	}
}
