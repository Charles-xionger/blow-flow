//go:build integration

package queue

import (
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/generation"
	generationpostgres "blow-flow/api/internal/generation/postgres"
	"context"
	"errors"
	"fmt"
	"github.com/pressly/goose/v3"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSubmissionCapacityAndUncertainResponse(t *testing.T) {
	dsn, rabbitURL := os.Getenv("TEST_DATABASE_URL"), os.Getenv("TEST_RABBITMQ_URL")
	if dsn == "" || rabbitURL == "" {
		t.Fatal("TEST_DATABASE_URL and TEST_RABBITMQ_URL required")
	}
	_, admin, err := database.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("submission_%d", time.Now().UnixNano())
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
	owner := "00000000-0000-0000-0000-000000000003"
	if err = db.Exec(`INSERT INTO users(id,email,status,created_at,updated_at) VALUES(?,'submission@example.com','active',now(),now())`, owner).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`INSERT INTO projects(id,owner_id,name,snapshot,version,created_at,updated_at) VALUES('p',?,'P','{}'::jsonb,1,now(),now())`, owner).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`UPDATE generation_connection_limits SET max_active=1`).Error; err != nil {
		t.Fatal(err)
	}
	store := generationpostgres.New(db)
	ctx := context.Background()
	input := generation.Input{ProjectID: "p", Model: "runninghub/krea2", Prompt: "cat", Width: 1024, Height: 1024, Seed: 42}
	first, err := store.Create(ctx, owner, "first", "hash-first", input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Create(ctx, owner, "second", "hash-second", input)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.Write([]byte(`{"code":301}`)) }))
	defer server.Close()
	rabbit, err := Dial(rabbitURL)
	if err != nil {
		t.Fatal(err)
	}
	defer rabbit.Close()
	if err = rabbit.Publish(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	if err = rabbit.Publish(ctx, second.ID); err != nil {
		t.Fatal(err)
	}
	workerCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 2)
	worker := SubmissionWorker{Store: store, Rabbit: rabbit, Provider: Krea2{BaseURL: server.URL, APIKey: "secret", Client: server.Client()}}
	go func() { done <- worker.Run(workerCtx) }()
	go func() { done <- worker.Run(workerCtx) }()
	waitStatus := func(id string, want generation.Status) {
		t.Helper()
		deadline := time.After(10 * time.Second)
		for {
			task, _, e := store.Get(ctx, id)
			if e != nil {
				t.Fatal(e)
			}
			if task.Status == want {
				return
			}
			select {
			case e := <-done:
				t.Fatalf("worker exited: %v", e)
			case <-deadline:
				t.Fatalf("task %s status=%s want=%s", id, task.Status, want)
			case <-time.After(25 * time.Millisecond):
			}
		}
	}
	waitStatus(first.ID, generation.Failed)
	waitStatus(second.ID, generation.Failed)
	if calls.Load() != 2 {
		t.Fatalf("provider submissions=%d", calls.Load())
	}
	if err = rabbit.Publish(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
	time.Sleep(250 * time.Millisecond)
	if calls.Load() != 2 {
		t.Fatalf("duplicate provider submissions=%d", calls.Load())
	}
	lost, err := store.Create(ctx, owner, "lost", "hash-lost", input)
	if err != nil {
		t.Fatal(err)
	}
	lostServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		h := w.(http.Hijacker)
		c, _, _ := h.Hijack()
		c.Close()
	}))
	defer lostServer.Close()
	claim, ok, err := store.ClaimSubmission(ctx, lost.ID)
	if err != nil || !ok {
		t.Fatalf("claim: %v %v", ok, err)
	}
	id, submitErr := (Krea2{BaseURL: lostServer.URL, APIKey: "secret", Client: lostServer.Client()}).Submit(ctx, claim.Input)
	if id != "" || !errors.Is(submitErr, ErrSubmissionUncertain) {
		t.Fatalf("lost response=%q %v", id, submitErr)
	}
	if err = store.ResolveSubmission(ctx, lost.ID, claim.Token, id, submitErr); err != nil {
		t.Fatal(err)
	}
	waitStatus(lost.ID, generation.NeedsReview)
	if err = rabbit.Publish(ctx, lost.ID); err != nil {
		t.Fatal(err)
	}
	time.Sleep(250 * time.Millisecond)
	if calls.Load() != 3 {
		t.Fatalf("uncertain duplicate submissions=%d", calls.Load())
	}
	if err = db.Exec(`UPDATE generation_connection_limits SET max_active=2`).Error; err != nil {
		t.Fatal(err)
	}
	active, err := store.Create(ctx, owner, "active", "hash-active", input)
	if err != nil {
		t.Fatal(err)
	}
	waiting, err := store.Create(ctx, owner, "waiting", "hash-waiting", input)
	if err != nil {
		t.Fatal(err)
	}
	activeClaim, ok, err := store.ClaimSubmission(ctx, active.ID)
	if err != nil || !ok {
		t.Fatalf("active claim: %v %v", ok, err)
	}
	_, ok, err = store.ClaimSubmission(ctx, waiting.ID)
	if err != generationpostgres.ErrNoCapacity || ok {
		t.Fatalf("capacity: %v %v", ok, err)
	}
	if err = store.ResolveSubmission(ctx, active.ID, activeClaim.Token, "", ErrSubmissionRejected); err != nil {
		t.Fatal(err)
	}
	waitingClaim, ok, err := store.ClaimSubmission(ctx, waiting.ID)
	if err != nil || !ok {
		t.Fatalf("released slot: %v %v", ok, err)
	}
	if err = db.Exec(`UPDATE generation_tasks SET lease_until=now()-interval '1 second' WHERE id=?`, waiting.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err = store.RecoverExpiredSubmissions(ctx); err != nil {
		t.Fatal(err)
	}
	if err = store.ResolveSubmission(ctx, waiting.ID, waitingClaim.Token, "late-provider-id", nil); err != generationpostgres.ErrStaleLease {
		t.Fatalf("stale worker write: %v", err)
	}
	waitStatus(waiting.ID, generation.NeedsReview)
	if err = db.Exec(`UPDATE generation_connection_limits SET max_active=4`).Error; err != nil {
		t.Fatal(err)
	}
	accepted, err := store.Create(ctx, owner, "accepted", "hash-accepted", input)
	if err != nil {
		t.Fatal(err)
	}
	acceptedClaim, ok, err := store.ClaimSubmission(ctx, accepted.ID)
	if err != nil || !ok {
		t.Fatalf("accepted claim: %v %v", ok, err)
	}
	if err = store.ResolveSubmission(ctx, accepted.ID, acceptedClaim.Token, "1910246754753896450", nil); err != nil {
		t.Fatal(err)
	}
	var providerID string
	if err = db.Raw(`SELECT provider_task_id FROM generation_tasks WHERE id=?`, accepted.ID).Scan(&providerID).Error; err != nil || providerID != "1910246754753896450" {
		t.Fatalf("provider id=%q %v", providerID, err)
	}
	_, ok, err = store.ClaimSubmission(ctx, accepted.ID)
	if err != nil || ok {
		t.Fatalf("accepted duplicate claim: %v %v", ok, err)
	}
	left, err := store.Create(ctx, owner, "left", "hash-left", input)
	if err != nil {
		t.Fatal(err)
	}
	right, err := store.Create(ctx, owner, "right", "hash-right", input)
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, taskID := range []string{left.ID, right.ID} {
		wg.Add(1)
		go func(taskID string) {
			defer wg.Done()
			<-start
			_, claimed, claimErr := generationpostgres.New(db).ClaimSubmission(ctx, taskID)
			if claimed {
				results <- nil
			} else {
				results <- claimErr
			}
		}(taskID)
	}
	close(start)
	wg.Wait()
	close(results)
	claimedCount, fullCount := 0, 0
	for result := range results {
		if result == nil {
			claimedCount++
		} else if result == generationpostgres.ErrNoCapacity {
			fullCount++
		} else {
			t.Fatalf("concurrent claim: %v", result)
		}
	}
	if claimedCount != 1 || fullCount != 1 {
		t.Fatalf("concurrent slots: claimed=%d full=%d", claimedCount, fullCount)
	}
	cancel()
	<-done
	<-done
}

func TestSubmissionWorkerRecoversPublishedTaskWithoutRabbitMessage(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("TEST_DATABASE_URL required")
	}
	_, admin, err := database.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("recovery_%d", time.Now().UnixNano())
	if _, err := admin.Exec("CREATE SCHEMA " + schema); err != nil {
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
	if err := goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	migrations, _ := filepath.Abs("../../../migrations")
	if err := goose.Up(pool, migrations); err != nil {
		t.Fatal(err)
	}
	owner := "00000000-0000-0000-0000-000000000004"
	if err := db.Exec(`INSERT INTO users(id,email,status,created_at,updated_at) VALUES(?,'recovery@example.com','active',now(),now())`, owner).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO projects(id,owner_id,name,snapshot,version,created_at,updated_at) VALUES('p',?,'P','{}'::jsonb,1,now(),now())`, owner).Error; err != nil {
		t.Fatal(err)
	}
	store := generationpostgres.New(db)
	ctx := context.Background()
	input := generation.Input{ProjectID: "p", Model: "runninghub/krea2", Prompt: "cat", Width: 1024, Height: 1024}
	task, err := store.Create(ctx, owner, "lost", "lost", input)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`UPDATE generation_outbox SET published_at=now() WHERE task_id=?`, task.ID).Error; err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int64
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.Write([]byte(`{"code":301}`)) }))
	defer provider.Close()
	worker := SubmissionWorker{Store: store, Provider: Krea2{BaseURL: provider.URL, APIKey: "secret", Client: provider.Client()}}
	if err := worker.ProcessDue(ctx); err != nil {
		t.Fatal(err)
	}
	if err := worker.ProcessDue(ctx); err != nil {
		t.Fatal(err)
	}
	got, _, err := store.Get(ctx, task.ID)
	if err != nil || got.Status != generation.Failed || calls.Load() != 1 {
		t.Fatalf("recovered %+v calls=%d err=%v", got, calls.Load(), err)
	}
}
