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
	if err = db.Exec(`INSERT INTO generation_resource_grants(owner_id,resource_type,resource_id) VALUES(?,'project','p')`, owner).Error; err != nil {
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
	if view.QueueLength != 1 || len(view.Workers) != 1 || len(view.Circuits) != 3 {
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
