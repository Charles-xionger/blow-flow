package main

import (
	"os"
	"strings"
	"testing"
)

func TestSetupCreatesPrivatePasswordAndSigningConfiguration(t *testing.T) {
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	oldArgs := os.Args
	os.Args = []string{"setup", "admin@example.com"}
	t.Cleanup(func() { os.Args = oldArgs; _ = os.Chdir(previous) })
	if err := setup(); err != nil {
		t.Fatal(err)
	}
	login, err := os.ReadFile(loginFile)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(login), "Admin email: admin@example.com") || !strings.Contains(string(login), "Admin password: ") || strings.Contains(string(login), "TOTP") {
		t.Fatal("admin login file has unexpected contents")
	}
	env, err := os.ReadFile(".env.local")
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"DATABASE_URL=", "ADMIN_AUTH_EMAIL=", "ADMIN_AUTH_PASSWORD_HASH=", "AUTH_SIGNING_KEY="} {
		if !strings.Contains(string(env), key) {
			t.Fatalf("missing %s", key)
		}
	}
	if strings.Contains(string(env), "TOTP") {
		t.Fatal("obsolete TOTP configuration was created")
	}
	for _, name := range []string{loginFile, ".env.local"} {
		info, err := os.Stat(name)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("%s must be private: %v", name, err)
		}
	}
	if err := setup(); err == nil {
		t.Fatal("existing credentials were overwritten")
	}
}
