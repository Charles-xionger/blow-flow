//go:build integration

package queue

import (
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/generation"
	generationpostgres "blow-flow/api/internal/generation/postgres"
	"context"
	"fmt"
	"github.com/pressly/goose/v3"
	"net/url"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

type countingProvider struct{ calls atomic.Int64 }

func (p *countingProvider) Generate(_ context.Context, _ generation.Input) (string, error) {
	p.calls.Add(1)
	return "simulated://result", nil
}
func TestPostgresOutboxRabbitWorkerDuplicateAndCancel(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	rabbitURL := os.Getenv("TEST_RABBITMQ_URL")
	if dsn == "" || rabbitURL == "" {
		t.Fatal("TEST_DATABASE_URL and TEST_RABBITMQ_URL required")
	}
	_, admin, err := database.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("generation_queue_%d", time.Now().UnixNano())
	if _, err = admin.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec("DROP SCHEMA " + schema + " CASCADE")
	parsed, _ := url.Parse(dsn)
	q := parsed.Query()
	q.Set("search_path", schema)
	parsed.RawQuery = q.Encode()
	db, pool, err := database.Open(parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err = goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	migrations, _ := filepath.Abs("../../../migrations")
	if err = goose.Up(pool, migrations); err != nil {
		t.Fatal(err)
	}
	owner := "00000000-0000-0000-0000-000000000002"
	if err = db.Exec(`INSERT INTO users(id,email,status,created_at,updated_at) VALUES(?,'queue@example.com','active',now(),now())`, owner).Error; err != nil {
		t.Fatal(err)
	}
	rabbit, err := Dial(rabbitURL)
	if err != nil {
		t.Fatal(err)
	}
	defer rabbit.Close()
	store := generationpostgres.New(db)
	input := generation.Input{ProjectID: "p", Model: "runninghub/krea2", Prompt: "cat", Width: 1024, Height: 1024}
	task, err := store.Create(context.Background(), owner, "queue-key", "hash", input)
	if err != nil {
		t.Fatal(err)
	}
	cancelTask, err := store.Create(context.Background(), owner, "cancel-key", "hash", input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.Cancel(context.Background(), cancelTask.ID, owner); err != nil {
		t.Fatal(err)
	}
	closedRabbit, err := Dial(rabbitURL)
	if err != nil {
		t.Fatal(err)
	}
	_ = closedRabbit.Close()
	if err := (Publisher{DB: db, Rabbit: closedRabbit}).PublishPending(context.Background()); err == nil {
		t.Fatal("expected publication failure")
	}
	var pending int64
	db.Raw(`SELECT count(*) FROM generation_outbox WHERE published_at IS NULL`).Scan(&pending)
	if pending != 2 {
		t.Fatalf("pending after failed publish=%d", pending)
	}
	publisher := Publisher{DB: db, Rabbit: rabbit}
	if err = publisher.PublishPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err = publisher.PublishPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err = rabbit.Publish(context.Background(), task.ID); err != nil {
		t.Fatal(err)
	}
	provider := &countingProvider{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- (Worker{Store: store, Rabbit: rabbit, Provider: provider}).Run(ctx) }()
	deadline := time.After(10 * time.Second)
	for {
		got, _, err := store.Get(context.Background(), task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if got.Status == generation.Completed {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("worker exited: %v", err)
		case <-deadline:
			t.Fatal("worker did not complete")
		case <-time.After(50 * time.Millisecond):
		}
	}
	if provider.calls.Load() != 1 {
		t.Fatalf("provider calls=%d", provider.calls.Load())
	}
	got, _, err := store.Get(context.Background(), cancelTask.ID)
	if err != nil || got.Status != generation.Canceled {
		t.Fatalf("canceled task=%+v %v", got, err)
	}
	var count int64
	db.Raw(`SELECT count(*) FROM generation_task_events WHERE task_id=?`, task.ID).Scan(&count)
	if count != 3 {
		t.Fatalf("task events=%d", count)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("worker did not stop")
	}
}
