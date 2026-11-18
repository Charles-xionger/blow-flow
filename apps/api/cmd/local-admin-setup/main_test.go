package main

import (
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestPrintQRCreatesPrivateImageFromExistingCredentials(t *testing.T) {
	directory := t.TempDir()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(directory); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previous) })

	login := "Admin email: admin@example.com\nAuthenticator URI: otpauth://totp/Blow%20Flow%3Aadmin%40example.com?secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&issuer=Blow+Flow\n"
	if err := os.WriteFile(loginFile, []byte(login), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(".env.local", []byte("ADMIN_AUTH_TOTP_SECRET='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := printQR(); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(filepath.Join(directory, qrFile))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	image, err := png.DecodeConfig(file)
	if err != nil || image.Width != 320 || image.Height != 320 {
		t.Fatalf("expected a 320px PNG, got %+v, %v", image, err)
	}
	info, err := file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("QR mode = %v, want 0600", info.Mode().Perm())
	}
}

func TestPrintQRRejectsStaleEnrollmentSecret(t *testing.T) {
	directory := t.TempDir()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(directory); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previous) })
	if err := os.WriteFile(loginFile, []byte("Authenticator URI: otpauth://totp/Blow%20Flow?secret=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(".env.local", []byte("ADMIN_AUTH_TOTP_SECRET='234567ABCDEFGHIJKLMNOPQRSTUVWXYZ'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(qrFile, []byte("stale"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := printQR(); err == nil {
		t.Fatal("expected a mismatched enrollment secret to fail")
	}
	if _, err := os.Stat(qrFile); !os.IsNotExist(err) {
		t.Fatalf("expected stale QR to be removed, got %v", err)
	}
}
