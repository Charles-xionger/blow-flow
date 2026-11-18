package main

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"blow-flow/api/internal/identity/localauth"
)

const loginFile = ".admin-login.local"

func main() {
	var err error
	if len(os.Args) > 1 && os.Args[1] == "code" {
		err = printCode()
	} else {
		err = setup()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func setup() error {
	if _, err := os.Stat(loginFile); err == nil {
		return fmt.Errorf("%s already exists; remove it explicitly before generating new credentials", loginFile)
	}
	email := "admin@blowflow.local"
	if len(os.Args) > 1 {
		email = strings.ToLower(strings.TrimSpace(os.Args[1]))
	}
	if !strings.Contains(email, "@") {
		return fmt.Errorf("provide a valid admin email")
	}
	passwordBytes := make([]byte, 24)
	key := make([]byte, 32)
	if _, err := rand.Read(passwordBytes); err != nil {
		return err
	}
	if _, err := rand.Read(key); err != nil {
		return err
	}
	password := base64.RawURLEncoding.EncodeToString(passwordBytes)
	hash, err := localauth.PasswordHash(password)
	if err != nil {
		return err
	}
	secret, err := localauth.NewTOTPSecret()
	if err != nil {
		return err
	}
	uri := "otpauth://totp/" + url.PathEscape("Blow Flow:"+email) + "?secret=" + secret + "&issuer=" + url.QueryEscape("Blow Flow")
	login := fmt.Sprintf("Admin email: %s\nAdmin password: %s\nTOTP secret: %s\nAuthenticator URI: %s\n", email, password, secret, uri)
	file, err := os.OpenFile(loginFile, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(login); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	current, err := os.ReadFile(".env.local")
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	base := string(current)
	for _, setting := range []struct{ key, value string }{
		{"API_ADDR", "127.0.0.1:8080"},
		{"DATABASE_URL", "postgres://ai_flow:ai_flow_local@127.0.0.1:15432/ai_flow?sslmode=disable"},
		{"APP_ENV", "development"},
	} {
		if !hasEnvKey(base, setting.key) {
			base += setting.key + "=" + shellQuote(setting.value) + "\n"
		}
	}
	content := setEnv(base, map[string]string{
		"ADMIN_AUTH_EMAIL":         email,
		"ADMIN_AUTH_PASSWORD_HASH": hash,
		"ADMIN_AUTH_TOTP_SECRET":   secret,
		"AUTH_SIGNING_KEY":         base64.RawStdEncoding.EncodeToString(key),
	})
	if err := os.WriteFile(".env.local", []byte(content), 0600); err != nil {
		return err
	}
	if err := os.Chmod(".env.local", 0600); err != nil {
		return err
	}
	fmt.Printf("Local admin configured. Credentials and authenticator URI: apps/api/%s\n", loginFile)
	return nil
}

func hasEnvKey(content, key string) bool {
	for _, line := range strings.Split(content, "\n") {
		if strings.HasPrefix(line, key+"=") {
			return true
		}
	}
	return false
}

func setEnv(current string, updates map[string]string) string {
	lines := strings.Split(strings.TrimRight(current, "\n"), "\n")
	if len(lines) == 1 && lines[0] == "" {
		lines = nil
	}
	for i, line := range lines {
		key, _, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		if value, ok := updates[key]; ok {
			lines[i] = key + "=" + shellQuote(value)
			delete(updates, key)
		}
	}
	for _, key := range []string{"ADMIN_AUTH_EMAIL", "ADMIN_AUTH_PASSWORD_HASH", "ADMIN_AUTH_TOTP_SECRET", "AUTH_SIGNING_KEY"} {
		if value, ok := updates[key]; ok {
			lines = append(lines, key+"="+shellQuote(value))
		}
	}
	return strings.Join(lines, "\n") + "\n"
}

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }

func printCode() error {
	content, err := os.ReadFile(loginFile)
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(content), "\n") {
		if secret, ok := strings.CutPrefix(line, "TOTP secret: "); ok {
			code, err := localauth.CurrentTOTPCode(secret, time.Now())
			if err != nil {
				return err
			}
			fmt.Println(code)
			return nil
		}
	}
	return fmt.Errorf("TOTP secret missing from %s", loginFile)
}
