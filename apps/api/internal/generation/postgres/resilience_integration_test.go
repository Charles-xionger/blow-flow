//go:build integration

package postgres

import (
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/generation"
	"context"
	"errors"
	"fmt"
	"github.com/pressly/goose/v3"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func resilienceStore(t *testing.T) (*Store, string) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("TEST_DATABASE_URL required")
	}
	_, admin, err := database.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("resilience_%d", time.Now().UnixNano())
	if _, err = admin.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Exec("DROP SCHEMA " + schema + " CASCADE"); admin.Close() })
	parsed, _ := url.Parse(dsn)
	q := parsed.Query()
	q.Set("search_path", schema)
	parsed.RawQuery = q.Encode()
	db, pool, err := database.Open(parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })
	if err = goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	migrations, _ := filepath.Abs("../../../migrations")
	if err = goose.Up(pool, migrations); err != nil {
		t.Fatal(err)
	}
	owner := "00000000-0000-0000-0000-000000000099"
	if err = db.Exec(`INSERT INTO users(id,email,status,created_at,updated_at) VALUES(?,'resilience@example.com','active',now(),now())`, owner).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`INSERT INTO projects(id,owner_id,name,snapshot,version,created_at,updated_at) VALUES('p',?,'P','{}'::jsonb,1,now(),now())`, owner).Error; err != nil {
		t.Fatal(err)
	}
	return New(db), owner
}
func resilienceInput() generation.Input {
	return generation.Input{ProjectID: "p", Model: "runninghub/krea2", Prompt: "cat", Width: 1024, Height: 1024}
}
func TestQueueAdmissionHasDistinctLimitsAndPreservesIdempotency(t *testing.T) {
	s, owner := resilienceStore(t)
	ctx := context.Background()
	if err := s.DB.Exec(`UPDATE generation_queue_limits SET max_queued=1 WHERE scope='user'`).Error; err != nil {
		t.Fatal(err)
	}
	first, err := s.Create(ctx, owner, "first", "h1", resilienceInput())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Create(ctx, owner, "first", "h1", resilienceInput()); err != nil {
		t.Fatalf("idempotent retry: %v", err)
	}
	if _, err = s.Create(ctx, owner, "second", "h2", resilienceInput()); !errors.Is(err, generation.ErrUserQueueFull) {
		t.Fatalf("user limit: %v", err)
	}
	if err = s.DB.Exec(`UPDATE generation_queue_limits SET max_queued=10 WHERE scope='user'`).Error; err != nil {
		t.Fatal(err)
	}
	if err = s.DB.Exec(`UPDATE generation_queue_limits SET max_queued=1 WHERE scope='model'`).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = s.Create(ctx, owner, "second", "h2", resilienceInput()); !errors.Is(err, generation.ErrModelQueueFull) {
		t.Fatalf("model limit: %v", err)
	}
	if err = s.DB.Exec(`UPDATE generation_queue_limits SET max_queued=10 WHERE scope='model'`).Error; err != nil {
		t.Fatal(err)
	}
	if err = s.DB.Exec(`UPDATE generation_queue_limits SET max_queued=1 WHERE scope='connection'`).Error; err != nil {
		t.Fatal(err)
	}
	if _, err = s.Create(ctx, owner, "second", "h2", resilienceInput()); !errors.Is(err, generation.ErrConnectionQueueFull) {
		t.Fatalf("connection limit: %v", err)
	}
	if _, _, err = s.Get(ctx, first.ID); err != nil {
		t.Fatal(err)
	}
}
func TestSubmitCircuitOpensProbesAndDoesNotBlockDeliveryClaim(t *testing.T) {
	s, owner := resilienceStore(t)
	ctx := context.Background()
	if err := s.DB.Exec(`UPDATE generation_circuits SET failure_threshold=1,cooldown_seconds=1 WHERE operation='submit'`).Error; err != nil {
		t.Fatal(err)
	}
	a, err := s.Create(ctx, owner, "a", "a", resilienceInput())
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.Create(ctx, owner, "b", "b", resilienceInput())
	if err != nil {
		t.Fatal(err)
	}
	claim, ok, err := s.ClaimSubmission(ctx, a.ID)
	if err != nil || !ok {
		t.Fatalf("claim: %v %v", ok, err)
	}
	if err = s.ResolveSubmission(ctx, a.ID, claim.Token, "", errors.New("uncertain network response")); err != nil {
		t.Fatal(err)
	}
	if _, ok, err = s.ClaimSubmission(ctx, b.ID); ok || !errors.Is(err, ErrSubmitCircuitOpen) {
		t.Fatalf("open: %v %v", ok, err)
	}
	task, _, err := s.Get(ctx, b.ID)
	if err != nil || task.Status != generation.Queued {
		t.Fatalf("queued: %+v %v", task, err)
	}
	if err = s.DB.Exec(`UPDATE generation_circuits SET opened_at=now()-interval '2 seconds' WHERE operation='submit'`).Error; err != nil {
		t.Fatal(err)
	}
	probe, ok, err := s.ClaimSubmission(ctx, b.ID)
	if err != nil || !ok {
		t.Fatalf("probe: %v %v", ok, err)
	}
	if err = s.ResolveSubmission(ctx, b.ID, probe.Token, "provider-1", nil); err != nil {
		t.Fatal(err)
	}
	var state string
	s.DB.Raw(`SELECT state FROM generation_circuits WHERE operation='submit'`).Scan(&state)
	if state != "closed" {
		t.Fatalf("circuit=%s", state)
	}
	if _, ok, err = s.ClaimDelivery(ctx, b.ID); err != nil || !ok {
		t.Fatalf("delivery: %v %v", ok, err)
	}
}
func TestOperationsAuditsAdminReadAndReportsBacklog(t *testing.T) {
	s, owner := resilienceStore(t)
	ctx := context.Background()
	if _, err := s.Create(ctx, owner, "a", "a", resilienceInput()); err != nil {
		t.Fatal(err)
	}
	if err := s.Heartbeat(ctx, "worker-a"); err != nil {
		t.Fatal(err)
	}
	view, err := s.Operations(ctx, owner)
	if err != nil {
		t.Fatal(err)
	}
	if view.QueueLength != 1 || len(view.Workers) != 1 || len(view.Circuits) != 9 {
		t.Fatalf("operations=%+v", view)
	}
	var n int64
	s.DB.Raw(`SELECT count(*) FROM generation_admin_audit WHERE actor_id=? AND action='view_generation_operations'`, owner).Scan(&n)
	if n != 1 {
		t.Fatalf("audit=%d", n)
	}
}
func TestInFlightClaimDefersWhenSubmitCircuitOpens(t *testing.T) {
	s, owner := resilienceStore(t)
	ctx := context.Background()
	if err := s.DB.Exec(`UPDATE generation_circuits SET failure_threshold=1 WHERE operation='submit'`).Error; err != nil {
		t.Fatal(err)
	}
	a, _ := s.Create(ctx, owner, "a", "a", resilienceInput())
	b, _ := s.Create(ctx, owner, "b", "b", resilienceInput())
	aClaim, ok, err := s.ClaimSubmission(ctx, a.ID)
	if err != nil || !ok {
		t.Fatal(err)
	}
	bClaim, ok, err := s.ClaimSubmission(ctx, b.ID)
	if err != nil || !ok {
		t.Fatal(err)
	}
	if err = s.ResolveSubmission(ctx, a.ID, aClaim.Token, "", errors.New("network")); err != nil {
		t.Fatal(err)
	}
	if allowed, err := s.CheckSubmission(ctx, b.ID, bClaim.Token); allowed || !errors.Is(err, ErrSubmitCircuitOpen) {
		t.Fatalf("allowed=%v err=%v", allowed, err)
	}
	if err = s.RequeueSubmission(ctx, b.ID, bClaim.Token); err != nil {
		t.Fatal(err)
	}
	task, _, err := s.Get(ctx, b.ID)
	if err != nil || task.Status != generation.Queued {
		t.Fatalf("task=%+v err=%v", task, err)
	}
}

func TestQueuedTaskRecoversWithoutRabbitWakeupAfterGrantReturns(t *testing.T) {
	s, owner := resilienceStore(t)
	ctx := context.Background()
	task, err := s.Create(ctx, owner, "lost-wakeup", "lost-wakeup", resilienceInput())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DB.Exec(`UPDATE generation_outbox SET published_at=now() WHERE task_id=?`, task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.DB.Exec(`UPDATE projects SET deleted_at=now() WHERE owner_id=?`, owner).Error; err != nil {
		t.Fatal(err)
	}
	ids, err := s.DueQueued(ctx, 25)
	if err != nil || len(ids) != 1 || ids[0] != task.ID {
		t.Fatalf("recovery scan %v %v", ids, err)
	}
	if _, ok, err := s.ClaimSubmission(ctx, task.ID); err != nil || ok {
		t.Fatalf("unauthorized claim %v %v", ok, err)
	}
	if err := s.DB.Exec(`UPDATE projects SET deleted_at=NULL WHERE owner_id=?`, owner).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.DB.Exec(`UPDATE generation_tasks SET recovery_checked_at=now()-interval '6 seconds' WHERE id=?`, task.ID).Error; err != nil {
		t.Fatal(err)
	}
	ids, err = s.DueQueued(ctx, 25)
	if err != nil || len(ids) != 1 || ids[0] != task.ID {
		t.Fatalf("reauthorized scan %v %v", ids, err)
	}
	claim, ok, err := s.ClaimSubmission(ctx, task.ID)
	if err != nil || !ok {
		t.Fatalf("claim %v %v", ok, err)
	}
	if _, ok, err := s.ClaimSubmission(ctx, task.ID); err != nil || ok {
		t.Fatalf("duplicate paid claim %v %v", ok, err)
	}
	if err := s.ResolveSubmission(ctx, task.ID, claim.Token, "provider-original", nil); err != nil {
		t.Fatal(err)
	}
}

func TestLateNodeResultRemainsTaskScopedAndCannotReplaceCurrentResult(t *testing.T) {
	s, owner := resilienceStore(t)
	ctx := context.Background()
	input := resilienceInput()
	input.NodeID = "image-node"
	old, err := s.Create(ctx, owner, "old", "old", input)
	if err != nil {
		t.Fatal(err)
	}
	newer, err := s.Create(ctx, owner, "new", "new", input)
	if err != nil {
		t.Fatal(err)
	}
	finish := func(task generation.Task, url string) {
		t.Helper()
		sub, ok, err := s.ClaimSubmission(ctx, task.ID)
		if err != nil || !ok {
			t.Fatalf("submission %v %v", ok, err)
		}
		if err := s.ResolveSubmission(ctx, task.ID, sub.Token, "provider-"+task.ID, nil); err != nil {
			t.Fatal(err)
		}
		query, ok, err := s.ClaimDelivery(ctx, task.ID)
		if err != nil || !ok {
			t.Fatalf("delivery %v %v", ok, err)
		}
		if err := s.ProviderSucceeded(ctx, query, "https://provider.test/"+task.ID, "png", nil); err != nil {
			t.Fatal(err)
		}
		save, ok, err := s.ClaimDelivery(ctx, task.ID)
		if err != nil || !ok {
			t.Fatalf("save %v %v", ok, err)
		}
		if err := s.Delivered(ctx, save, url); err != nil {
			t.Fatal(err)
		}
	}
	finish(newer, "https://project.test/new.png")
	finish(old, "https://project.test/old.png")
	oldTask, _, err := s.Get(ctx, old.ID)
	if err != nil || oldTask.ResultURL != "https://project.test/old.png" {
		t.Fatalf("old task %+v %v", oldTask, err)
	}
	var head struct{ TaskID, ResultURL string }
	if err := s.DB.Raw(`SELECT task_id,result_url FROM generation_node_results WHERE owner_id=? AND project_id='p' AND node_id='image-node'`, owner).Scan(&head).Error; err != nil {
		t.Fatal(err)
	}
	if head.TaskID != newer.ID || head.ResultURL != "https://project.test/new.png" {
		t.Fatalf("node result %+v", head)
	}
}

func TestDeliveryCircuitsAndRetryExhaustionAreIndependent(t *testing.T) {
	s, owner := resilienceStore(t)
	ctx := context.Background()
	task, err := s.Create(ctx, owner, "retry", "retry", resilienceInput())
	if err != nil {
		t.Fatal(err)
	}
	sub, ok, err := s.ClaimSubmission(ctx, task.ID)
	if err != nil || !ok {
		t.Fatalf("submission %v %v", ok, err)
	}
	if err := s.ResolveSubmission(ctx, task.ID, sub.Token, "provider-original", nil); err != nil {
		t.Fatal(err)
	}
	if err := s.DB.Exec(`UPDATE generation_circuits SET state='open',opened_at=now(),cooldown_seconds=30 WHERE operation='submit'`).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.DB.Exec(`UPDATE generation_circuits SET failure_threshold=1,cooldown_seconds=1 WHERE operation='query'`).Error; err != nil {
		t.Fatal(err)
	}
	claim, ok, err := s.ClaimDelivery(ctx, task.ID)
	if err != nil || !ok {
		t.Fatalf("query claim %v %v", ok, err)
	}
	if allowed, err := s.BeginOperation(ctx, claim, "query"); err != nil || !allowed {
		t.Fatalf("submit breaker blocked query %v %v", allowed, err)
	}
	if err := s.RecordOperation(ctx, claim, "query", errors.New("network")); err != nil {
		t.Fatal(err)
	}
	if err := s.ScheduleQuery(ctx, claim, "waiting_provider", errors.New("network"), time.Hour); err != nil {
		t.Fatal(err)
	}
	if err := s.DB.Exec(`UPDATE generation_tasks SET next_attempt_at=now()-interval '1 second' WHERE id=?`, task.ID).Error; err != nil {
		t.Fatal(err)
	}
	claim, ok, err = s.ClaimDelivery(ctx, task.ID)
	if err != nil || !ok {
		t.Fatalf("query claim 2 %v %v", ok, err)
	}
	if allowed, err := s.BeginOperation(ctx, claim, "query"); err != nil || allowed {
		t.Fatalf("open query circuit %v %v", allowed, err)
	}
	if err := s.DB.Exec(`UPDATE generation_circuits SET opened_at=now()-interval '2 seconds' WHERE operation='query'`).Error; err != nil {
		t.Fatal(err)
	}
	if allowed, err := s.BeginOperation(ctx, claim, "query"); err != nil || !allowed {
		t.Fatalf("half-open query %v %v", allowed, err)
	}
	if err := s.RecordOperation(ctx, claim, "query", nil); err != nil {
		t.Fatal(err)
	}
	var state string
	s.DB.Raw(`SELECT state FROM generation_circuits WHERE operation='query'`).Scan(&state)
	if state != "closed" {
		t.Fatalf("query circuit %s", state)
	}
	if err := s.DB.Exec(`UPDATE generation_tasks SET poll_attempts=5 WHERE id=?`, task.ID).Error; err != nil {
		t.Fatal(err)
	}
	claim.Attempts = 5
	if err := s.ScheduleQuery(ctx, claim, "waiting_provider", errors.New("network"), time.Hour); err != nil {
		t.Fatal(err)
	}
	got, _, err := s.Get(ctx, task.ID)
	if err != nil || got.Status != generation.QueryFailed {
		t.Fatalf("query exhausted %+v %v", got, err)
	}
	if err := s.ResumeDelivery(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	query, ok, err := s.ClaimDelivery(ctx, task.ID)
	if err != nil || !ok {
		t.Fatalf("resumed query %v %v", ok, err)
	}
	if err := s.ProviderSucceeded(ctx, query, "https://provider.test/result.png", "png", nil); err != nil {
		t.Fatal(err)
	}
	if err := s.DB.Exec(`UPDATE generation_circuits SET failure_threshold=1,cooldown_seconds=1 WHERE operation='save'`).Error; err != nil {
		t.Fatal(err)
	}
	save, ok, err := s.ClaimDelivery(ctx, task.ID)
	if err != nil || !ok {
		t.Fatalf("save claim %v %v", ok, err)
	}
	if allowed, err := s.BeginOperation(ctx, save, "save"); err != nil || !allowed {
		t.Fatalf("submit breaker blocked save %v %v", allowed, err)
	}
	if err := s.RecordOperation(ctx, save, "save", errors.New("storage")); err != nil {
		t.Fatal(err)
	}
	if allowed, err := s.BeginOperation(ctx, save, "save"); err != nil || allowed {
		t.Fatalf("open save circuit %v %v", allowed, err)
	}
	if err := s.DB.Exec(`UPDATE generation_circuits SET opened_at=now()-interval '2 seconds' WHERE operation='save'`).Error; err != nil {
		t.Fatal(err)
	}
	if allowed, err := s.BeginOperation(ctx, save, "save"); err != nil || !allowed {
		t.Fatalf("half-open save %v %v", allowed, err)
	}
	if err := s.RecordOperation(ctx, save, "save", nil); err != nil {
		t.Fatal(err)
	}
	s.DB.Raw(`SELECT state FROM generation_circuits WHERE operation='save'`).Scan(&state)
	if state != "closed" {
		t.Fatalf("save circuit %s", state)
	}
	if err := s.DB.Exec(`UPDATE generation_tasks SET save_attempts=4 WHERE id=?`, task.ID).Error; err != nil {
		t.Fatal(err)
	}
	save.SaveAttempts = 4
	if err := s.SaveFailed(ctx, save, "save_retryable", false); err != nil {
		t.Fatal(err)
	}
	got, _, err = s.Get(ctx, task.ID)
	if err != nil || got.Status != generation.SaveExhausted || got.FailureCode != "save_exhausted" {
		t.Fatalf("save exhausted %+v %v", got, err)
	}
}
