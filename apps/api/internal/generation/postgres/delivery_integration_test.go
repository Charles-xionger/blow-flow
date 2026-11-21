//go:build integration

package postgres

import (
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/generation"
	"context"
	"encoding/json"
	"fmt"
	"github.com/pressly/goose/v3"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestProviderSuccessSaveRetryAndEventsSurviveRestart(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("TEST_DATABASE_URL required")
	}
	_, admin, err := database.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("delivery_%d", time.Now().UnixNano())
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
	owner := "00000000-0000-0000-0000-000000000008"
	if err = db.Exec(`INSERT INTO users(id,email,status,created_at,updated_at) VALUES(?,'delivery@example.com','active',now(),now())`, owner).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`INSERT INTO projects(id,owner_id,name,snapshot,version,created_at,updated_at) VALUES('project',?,'Project','{}'::jsonb,1,now(),now())`, owner).Error; err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	store := New(db)
	input := generation.Input{ProjectID: "project", Model: generation.H3Model, Prompt: "cat", Width: 1024, Height: 1024, Duration: 5, Seed: 42}
	task, err := store.Create(ctx, owner, "key", "hash", input)
	if err != nil {
		t.Fatal(err)
	}
	submission, ok, err := store.ClaimSubmission(ctx, task.ID)
	if err != nil || !ok {
		t.Fatalf("submit claim %v %v", ok, err)
	}
	if err = store.ResolveSubmission(ctx, task.ID, submission.Token, "original-provider-task", nil); err != nil {
		t.Fatal(err)
	}
	first, ok, err := store.ClaimDelivery(ctx, task.ID)
	if err != nil || !ok || first.ProviderID != "original-provider-task" {
		t.Fatalf("delivery claim %+v %v %v", first, ok, err)
	}
	if err = store.RecordProgress(ctx, task.ID, first.Token, "generating", nil); err != nil {
		t.Fatal(err)
	}
	if err = store.ScheduleQuery(ctx, first, "waiting_provider", nil, time.Minute); err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`UPDATE generation_tasks SET next_attempt_at=now()-interval '1 second' WHERE id=?`, task.ID).Error; err != nil {
		t.Fatal(err)
	}
	first, ok, err = store.ClaimDelivery(ctx, task.ID)
	if err != nil || !ok {
		t.Fatalf("reclaim %v %v", ok, err)
	}
	usage := &generation.ProviderUsage{Fields: map[string]json.RawMessage{"chargedPoint": json.RawMessage(`"1.28"`)}, Source: "runninghub_outputs", CollectedAt: time.Now().UTC()}
	if err = store.ProviderSucceeded(ctx, first, "https://provider.test/image.png", "png", usage); err != nil {
		t.Fatal(err)
	}
	// A fresh store instance represents a restarted worker. It never submits again.
	restarted := New(db)
	save, ok, err := restarted.ClaimDelivery(ctx, task.ID)
	if err != nil || !ok || save.ProviderURL != "https://provider.test/image.png" {
		t.Fatalf("restart %+v %v %v", save, ok, err)
	}
	if err = restarted.SaveFailed(ctx, save, "save_retryable", false); err != nil {
		t.Fatal(err)
	}
	got, ownerID, err := restarted.Get(ctx, task.ID)
	if err != nil || ownerID != owner || got.Status != "save_failed" || got.FailureCode != "save_retryable" {
		t.Fatalf("save failed %+v %s %v", got, ownerID, err)
	}
	detail, err := (generation.Service{Store: restarted}).AdminTaskDetail(ctx, generation.Actor{ID: owner, Admin: true}, task.ID)
	if err != nil || detail.Usage == nil || string(detail.Usage.Fields["chargedPoint"]) != `"1.28"` || detail.Status != "save_failed" {
		t.Fatalf("admin task after save failure: %+v, %v", detail, err)
	}
	if err = db.Exec(`UPDATE generation_tasks SET next_attempt_at=now()-interval '1 second' WHERE id=?`, task.ID).Error; err != nil {
		t.Fatal(err)
	}
	retry, ok, err := restarted.ClaimDelivery(ctx, task.ID)
	if err != nil || !ok || retry.ProviderURL == "" {
		t.Fatalf("retry %+v %v %v", retry, ok, err)
	}
	if err = restarted.Delivered(ctx, retry, "https://project-oss/result.png"); err != nil {
		t.Fatal(err)
	}
	if err = restarted.Delivered(ctx, retry, "https://project-oss/result.png"); err != ErrStaleLease {
		t.Fatalf("duplicate completion %v", err)
	}
	got, _, err = restarted.Get(ctx, task.ID)
	if err != nil || got.Status != "completed" || got.ResultURL != "https://project-oss/result.png" {
		t.Fatalf("delivered %+v %v", got, err)
	}
	events, err := restarted.Events(ctx, task.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, event := range events {
		names = append(names, event.Type)
		if event.Type == "stage_changed" && event.Stage != "waiting_provider" {
			t.Fatalf("stage change=%+v", event)
		}
	}
	if fmt.Sprint(names) != "[created submitting accepted progress stage_changed provider_succeeded save_retry delivered]" {
		t.Fatalf("events %v", names)
	}
	after, err := restarted.Events(ctx, task.ID, events[len(events)-1].ID)
	if err != nil || len(after) != 0 {
		t.Fatalf("cursor %v %v", after, err)
	}
	stalled, err := store.Create(ctx, owner, "stalled", "hash-stalled", input)
	if err != nil {
		t.Fatal(err)
	}
	stalledSubmission, ok, err := store.ClaimSubmission(ctx, stalled.ID)
	if err != nil || !ok {
		t.Fatalf("stalled submit: %v %v", ok, err)
	}
	if err = store.ResolveSubmission(ctx, stalled.ID, stalledSubmission.Token, "same-original-id", nil); err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`UPDATE generation_tasks SET tracking_started_at=now()-interval '1 hour' WHERE id=?`, stalled.ID).Error; err != nil {
		t.Fatal(err)
	}
	stalledClaim, ok, err := store.ClaimDelivery(ctx, stalled.ID)
	if err != nil || !ok {
		t.Fatalf("stalled claim: %v %v", ok, err)
	}
	if err = store.ScheduleQuery(ctx, stalledClaim, "generating", nil, 30*time.Minute); err != nil {
		t.Fatal(err)
	}
	stalledTask, _, err := store.Get(ctx, stalled.ID)
	if err != nil || stalledTask.Status != "wait_timeout" {
		t.Fatalf("timeout: %+v %v", stalledTask, err)
	}
	if err = store.ResumeDelivery(ctx, stalled.ID); err != nil {
		t.Fatal(err)
	}
	resumed, ok, err := store.ClaimDelivery(ctx, stalled.ID)
	if err != nil || !ok || resumed.ProviderID != "same-original-id" {
		t.Fatalf("resume: %+v %v %v", resumed, ok, err)
	}
}
