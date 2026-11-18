package main

import (
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/generation/postgres"
	"blow-flow/api/internal/generation/progress"
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
	if raw := os.Getenv("REDIS_URL"); raw != "" {
		client, dialErr := progress.Dial(raw)
		if dialErr != nil {
			return dialErr
		}
		defer client.Close()
		store.Notify = client.Publish
	}
	worker := queue.SubmissionWorker{Store: store, Rabbit: rabbit, Provider: queue.Krea2{BaseURL: os.Getenv("RUNNINGHUB_BASE_URL"), APIKey: os.Getenv("RUNNINGHUB_API_KEY")}}
	delivery := queue.DeliveryWorker{Store: store, Provider: queue.Krea2{BaseURL: os.Getenv("RUNNINGHUB_BASE_URL"), APIKey: os.Getenv("RUNNINGHUB_API_KEY")}, Artifacts: queue.OSSFromEnv()}
	result := make(chan error, 1)
	go func() { result <- worker.Run(ctx) }()
	go func() {
		poll := time.NewTicker(time.Second)
		defer poll.Stop()
		for {
			if err := delivery.ProcessDue(ctx); err != nil && ctx.Err() == nil {
				slog.Warn("delivery retry", "reason", err.Error())
			}
			select {
			case <-ctx.Done():
				return
			case <-poll.C:
			}
		}
	}()
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
