package main

import (
	"context"
	"encoding/base64"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"blow-flow/api/internal/account"
	accountpostgres "blow-flow/api/internal/account/postgres"
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/httpserver"
	"blow-flow/api/internal/identity/imagecaptcha"
	localauth "blow-flow/api/internal/identity/localauth"
	"blow-flow/api/internal/telemetry"
	"github.com/getsentry/sentry-go"
)

func main() {
	if err := run(); err != nil {
		slog.Error("API stopped", "reason", err.Error())
		os.Exit(1)
	}
}
func run() error {
	if err := telemetry.Init(os.Getenv("SENTRY_DSN"), os.Getenv("APP_ENV"), os.Getenv("SENTRY_RELEASE")); err != nil {
		slog.Warn("Sentry configuration unavailable")
	}
	defer sentry.Flush(2 * time.Second)
	var ping httpserver.Ping
	var accounts *account.Service
	var identityVerifier httpserver.IdentityVerifier
	var localAdmin httpserver.LocalAdminAuthenticator
	var captcha httpserver.ImageCaptcha
	if dsn := os.Getenv("DATABASE_URL"); dsn != "" {
		db, pool, err := database.Open(dsn)
		if err != nil {
			slog.Warn("database configuration unavailable")
		} else {
			defer pool.Close()
			if os.Getenv("ADMIN_AUTH_EMAIL") != "" {
				key, err := base64.RawStdEncoding.DecodeString(os.Getenv("AUTH_SIGNING_KEY"))
				if err != nil {
					return err
				}
				adminAuth, err := localauth.New(localauth.Config{Email: os.Getenv("ADMIN_AUTH_EMAIL"), PasswordHash: os.Getenv("ADMIN_AUTH_PASSWORD_HASH"), SigningKey: key}, time.Now)
				if err != nil {
					return err
				}
				identityVerifier = adminAuth
				localAdmin = adminAuth
				captcha = imagecaptcha.New()
				repository := accountpostgres.New(db, time.Now)
				accounts = account.NewService(repository, account.InitialAdministrator{Issuer: localauth.Issuer, Subject: localauth.Subject, LinkExistingByEmail: true}, time.Now)
				ping = func(ctx context.Context) error { return database.Check(ctx, pool) }
			} else {
				slog.Warn("account API unavailable: local admin authentication is not configured")
			}
		}
	}
	addr := os.Getenv("API_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	server := &http.Server{Handler: httpserver.NewWithDependencies(httpserver.Dependencies{Ping: ping, Accounts: accounts, IdentityVerifier: identityVerifier, LocalAdmin: localAdmin, Captcha: captcha}), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	slog.Info("API listening", "address", listener.Addr().String())
	select {
	case err := <-done:
		if err != http.ErrServerClosed {
			return err
		}
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			return err
		}
	}
	return nil
}
