package main

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"ai-flow/api/internal/database"
	"ai-flow/api/internal/httpserver"
	"ai-flow/api/internal/telemetry"
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
	if dsn := os.Getenv("DATABASE_URL"); dsn != "" {
		_, pool, err := database.Open(dsn)
		if err != nil {
			slog.Warn("database configuration unavailable")
		} else {
			defer pool.Close()
			ping = func(ctx context.Context) error { return database.Check(ctx, pool) }
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
	server := &http.Server{Handler: httpserver.New(ping), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
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
