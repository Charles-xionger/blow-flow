package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"blow-flow/api/internal/account"
	accountpostgres "blow-flow/api/internal/account/postgres"
	agentpostgres "blow-flow/api/internal/agent/postgres"
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/generation"
	generationpostgres "blow-flow/api/internal/generation/postgres"
	"blow-flow/api/internal/generation/progress"
	"blow-flow/api/internal/httpserver"
	"blow-flow/api/internal/identity/creatorauth"
	"blow-flow/api/internal/identity/imagecaptcha"
	localauth "blow-flow/api/internal/identity/localauth"
	"blow-flow/api/internal/identity/session"
	"blow-flow/api/internal/resource"
	resourceoss "blow-flow/api/internal/resource/oss"
	resourcepostgres "blow-flow/api/internal/resource/postgres"
	"blow-flow/api/internal/script"
	scriptpostgres "blow-flow/api/internal/script/postgres"
	scriptprogress "blow-flow/api/internal/script/progress"
	"blow-flow/api/internal/telemetry"
	"blow-flow/api/internal/textmodel"
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
	var creatorAuth httpserver.CreatorAuthenticator
	var captcha httpserver.ImageCaptcha
	var refreshSessions httpserver.RefreshSessions
	var refreshStore *session.Store
	var agentRuns httpserver.AgentRuns
	var agentStore *agentpostgres.Store
	var agentRunnerKey []byte
	var generationService httpserver.GenerationService
	var resourceService *resource.Service
	var scriptService *script.Service
	var textModels *textmodel.Client
	var scriptWakeups *scriptprogress.Redis
	var wakeups *progress.Redis
	if dsn := os.Getenv("DATABASE_URL"); dsn != "" {
		db, pool, err := database.Open(dsn)
		if err != nil {
			slog.Warn("database configuration unavailable")
		} else {
			defer pool.Close()
			store := generationpostgres.New(db)
			agentStore = agentpostgres.New(db)
			agentRuns = agentStore
			resourceService = &resource.Service{Repository: resourcepostgres.New(db)}
			scriptStore := scriptpostgres.New(db)
			if n, e := strconv.Atoi(os.Getenv("SCRIPT_MAX_QUEUED_PER_USER")); e == nil && n > 0 && n <= 1000 {
				scriptStore.MaxQueuedPerUser = n
			}
			textModels = textmodel.FromEnv()
			scriptService = &script.Service{Repository: scriptStore, Models: textModels}
			if raw := os.Getenv("REDIS_URL"); raw != "" {
				client, dialErr := scriptprogress.Dial(raw)
				if dialErr != nil {
					return dialErr
				}
				scriptWakeups = client
				defer client.Close()
				scriptStore.Notify = client.Publish
			}
			if raw := os.Getenv("REDIS_URL"); raw != "" {
				client, dialErr := progress.Dial(raw)
				if dialErr != nil {
					return dialErr
				}
				wakeups = client
				defer client.Close()
				store.Notify = client.Publish
			}
			generationService = generation.Service{Store: store, Resources: generationpostgres.Resources{DB: db}}
			if os.Getenv("AUTH_SIGNING_KEY") != "" {
				key, err := base64.RawStdEncoding.DecodeString(os.Getenv("AUTH_SIGNING_KEY"))
				if err != nil {
					return err
				}
				userAuth, err := creatorauth.New(db, key, time.Now)
				if err != nil {
					return err
				}
				creatorAuth = userAuth
				verifiers := httpserver.IdentityChain{userAuth}
				if os.Getenv("ADMIN_AUTH_EMAIL") != "" {
					adminAuth, err := localauth.New(localauth.Config{Email: os.Getenv("ADMIN_AUTH_EMAIL"), PasswordHash: os.Getenv("ADMIN_AUTH_PASSWORD_HASH"), SigningKey: key}, time.Now)
					if err != nil {
						return err
					}
					localAdmin = adminAuth
					verifiers = append(verifiers, adminAuth)
				}
				identityVerifier = verifiers
				captcha = imagecaptcha.New()
				refreshStore = &session.Store{DB: db, Now: time.Now, Key: key}
				refreshSessions = refreshStore
				repository := accountpostgres.New(db, time.Now)
				accounts = account.NewService(repository, account.InitialAdministrator{Issuer: localauth.Issuer, Subject: localauth.Subject, LinkExistingByEmail: true}, time.Now)
				ping = func(ctx context.Context) error { return database.Check(ctx, pool) }
			} else {
				slog.Warn("account API unavailable: signing key is not configured")
			}
		}
	}
	addr := os.Getenv("API_ADDR")
	if raw := os.Getenv("AGENT_RUNNER_KEY"); raw != "" {
		key, err := base64.RawStdEncoding.DecodeString(raw)
		if err != nil || len(key) < 32 {
			return fmt.Errorf("AGENT_RUNNER_KEY must be at least 32 decoded bytes")
		}
		agentRunnerKey = key
	}
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if refreshStore != nil {
		go func() {
			ticker := time.NewTicker(6 * time.Hour)
			defer ticker.Stop()
			for {
				cleanup, cancel := context.WithTimeout(ctx, 30*time.Second)
				if err := refreshStore.Prune(cleanup); err != nil && ctx.Err() == nil {
					slog.Warn("refresh session cleanup failed")
				}
				cancel()
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}()
	}
	if agentStore != nil && len(agentRunnerKey) >= 32 {
		go func() {
			ticker := time.NewTicker(15 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					check, cancel := context.WithTimeout(ctx, 10*time.Second)
					if _, err := agentStore.InterruptExpired(check); err != nil && ctx.Err() == nil {
						slog.Warn("agent run expiry check failed")
					}
					cancel()
				}
			}
		}()
	}
	server := &http.Server{Handler: httpserver.NewWithDependencies(httpserver.Dependencies{Ping: ping, Accounts: accounts, IdentityVerifier: identityVerifier, LocalAdmin: localAdmin, CreatorAuth: creatorAuth, Captcha: captcha, RefreshSessions: refreshSessions, AgentRuns: agentRuns, AgentRunnerKey: agentRunnerKey, Generation: generationService, GenerationWakeups: wakeups, GenerationStreamClose: ctx.Done(), Resources: resourceService, ResourceBlobs: resourceoss.FromEnv(), Scripts: scriptService, ScriptWakeups: scriptWakeups, TextModels: textModels}), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
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
