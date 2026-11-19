package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	agentpostgres "blow-flow/api/internal/agent/postgres"
	"blow-flow/api/internal/agent/queue"
	"blow-flow/api/internal/database"
)

func main() {
	if err := run(); err != nil {
		slog.Error("agent dispatcher stopped", "reason", err.Error())
		os.Exit(1)
	}
}
func run() error {
	db, pool, err := database.Open(os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()
	rabbit, err := queue.Dial(os.Getenv("RABBITMQ_URL"))
	if err != nil {
		return err
	}
	defer rabbit.Close()
	outbox := queue.Outbox{Store: agentpostgres.New(db), Queue: rabbit}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		attempt, cancel := context.WithTimeout(ctx, 5*time.Second)
		if err := outbox.PublishPending(attempt); err != nil && ctx.Err() == nil {
			slog.Warn("agent outbox retry", "reason", err.Error())
		}
		cancel()
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
