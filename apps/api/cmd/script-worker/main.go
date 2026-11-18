package main

import (
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/script"
	scriptpostgres "blow-flow/api/internal/script/postgres"
	"blow-flow/api/internal/script/progress"
	"blow-flow/api/internal/script/queue"
	"blow-flow/api/internal/textmodel"
	"context"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func main() {
	if err := run(); err != nil {
		slog.Error("script worker stopped", "reason", err.Error())
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
	store := scriptpostgres.New(db)
	if n, e := strconv.Atoi(os.Getenv("SCRIPT_CONCURRENCY")); e == nil && n > 0 && n <= 20 {
		store.MaxConcurrent = n
	}
	if raw := os.Getenv("REDIS_URL"); raw != "" {
		client, e := progress.Dial(raw)
		if e != nil {
			return e
		}
		defer client.Close()
		store.Notify = client.Publish
	}
	hosts := []string{}
	for _, h := range strings.Split(os.Getenv("SCRIPT_ASSET_HOSTS"), ",") {
		if h = strings.TrimSpace(h); h != "" {
			hosts = append(hosts, h)
		}
	}
	if bucket, region := os.Getenv("OSS_BUCKET_NAME"), os.Getenv("OSS_REGION"); bucket != "" && region != "" {
		hosts = append(hosts, bucket+"."+region+".aliyuncs.com")
	}
	localCapacity := store.MaxConcurrent
	if localCapacity < 1 {
		localCapacity = 5
	}
	worker := script.Worker{Store: store, Queue: rabbit, Model: textmodel.FromEnv(), AssetHosts: hosts, Slots: make(chan struct{}, localCapacity)}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	result := make(chan error, 1)
	go func() {
		result <- rabbit.Consume(ctx, func(ctx context.Context, id string) error { worker.Dispatch(ctx, id); return nil })
	}()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if err := store.Recover(ctx); err != nil {
			slog.Warn("script recovery retry", "reason", err.Error())
		}
		if err := worker.PublishPending(ctx); err != nil {
			slog.Warn("script outbox retry", "reason", err.Error())
		}
		if err := worker.ProcessDue(ctx); err != nil {
			slog.Warn("script pending retry", "reason", err.Error())
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
