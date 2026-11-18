package main

import (
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/generation/postgres"
	"blow-flow/api/internal/generation/queue"
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	if err := run(); err != nil {
		slog.Error("generation worker stopped", "reason", err.Error())
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	publisher := queue.Publisher{DB: db, Rabbit: rabbit}
	store := postgres.New(db)
	worker := queue.SubmissionWorker{Store: store, Rabbit: rabbit, Provider: queue.Krea2{BaseURL: os.Getenv("RUNNINGHUB_BASE_URL"), APIKey: os.Getenv("RUNNINGHUB_API_KEY")}}
	result := make(chan error, 1)
	go func() { result <- worker.Run(ctx) }()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if err := store.RecoverExpiredSubmissions(ctx); err != nil {
			slog.Warn("submission recovery retry", "reason", err.Error())
		}
		if err := publisher.PublishPending(ctx); err != nil {
			slog.Warn("outbox publish retry", "reason", err.Error())
		}
		select {
		case <-ctx.Done():
			return nil
		case err := <-result:
			return err
		case <-ticker.C:
		}
	}
}
