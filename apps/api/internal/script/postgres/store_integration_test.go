//go:build integration

package postgres

import (
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/resource"
	resourcepostgres "blow-flow/api/internal/resource/postgres"
	"blow-flow/api/internal/script"
	"blow-flow/api/internal/textmodel"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pressly/goose/v3"
)

func setup(t *testing.T) (*Store, string, string) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("TEST_DATABASE_URL required")
	}
	_, admin, err := database.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("script_%d", time.Now().UnixNano())
	if _, err = admin.Exec(`CREATE SCHEMA ` + schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { admin.Exec(`DROP SCHEMA ` + schema + ` CASCADE`); admin.Close() })
	u, _ := url.Parse(dsn)
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	db, pool, err := database.Open(u.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })
	if err = goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	dir, _ := filepath.Abs("../../../migrations")
	if err = goose.Up(pool, dir); err != nil {
		t.Fatal(err)
	}
	a, b := "00000000-0000-0000-0000-000000000041", "00000000-0000-0000-0000-000000000042"
	for _, owner := range []string{a, b} {
		if err = db.Exec(`INSERT INTO users(id,email,status,created_at,updated_at) VALUES(?,?,'active',now(),now())`, owner, owner+"@example.com").Error; err != nil {
			t.Fatal(err)
		}
	}
	resources := resource.Service{Repository: resourcepostgres.New(db)}
	if _, err = resources.CreateProject(context.Background(), a, "p", "Project", nil); err != nil {
		t.Fatal(err)
	}
	snapshot := json.RawMessage(`{"name":"Project","nodes":[{"id":"script-1","type":"script","position":{"x":10,"y":20},"data":{"type":"script"}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1},"custom":"keep"}`)
	if _, err = resources.SaveCanvas(context.Background(), a, "p", resource.SaveCanvas{RequestID: "setup", BaseVersion: 1, Snapshot: snapshot}); err != nil {
		t.Fatal(err)
	}
	return New(db), a, b
}
func TestTaskOwnershipReplayAndCanvasOutput(t *testing.T) {
	s, a, b := setup(t)
	ctx := context.Background()
	request := script.Create{RequestID: "req-1", CanvasID: "p", NodeID: "script-1", Input: script.Input{Model: "deepseek-v4-pro-ga-260813", Requirements: "write", Instruction: "Do it", Preset: "free", References: []script.Reference{}}}
	task, err := s.Create(ctx, a, request)
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != "queued" || task.OutputNodeID == "" {
		t.Fatalf("created %+v", task)
	}
	replay, err := s.Create(ctx, a, request)
	if err != nil || replay.ID != task.ID {
		t.Fatalf("replay %+v %v", replay, err)
	}
	changed := request
	changed.Input.Requirements = "other"
	if _, err = s.Create(ctx, a, changed); !errors.Is(err, script.ErrConflict) {
		t.Fatalf("changed replay %v", err)
	}
	if _, err = s.Get(ctx, b, task.ID); !errors.Is(err, script.ErrNotFound) {
		t.Fatalf("cross owner task %v", err)
	}
	if _, err = s.List(ctx, b, "p", ""); err != nil {
		t.Fatal(err)
	}
	claimed, err := s.Claim(ctx, task.ID, 30*time.Second)
	if err != nil || claimed == nil {
		t.Fatalf("claim %+v %v", claimed, err)
	}
	if ok, err := s.Append(ctx, task.ID, claimed.Lease, "hello"); err != nil || !ok {
		t.Fatalf("append %v %v", ok, err)
	}
	if err = s.Finish(ctx, task.ID, claimed.Lease, "completed", ""); err != nil {
		t.Fatal(err)
	}
	completed, err := s.Get(ctx, a, task.ID)
	if err != nil || completed.Status != "completed" || completed.Text != "hello" {
		t.Fatalf("completed %+v %v", completed, err)
	}
	var saved struct{ Snapshot []byte }
	if err = s.DB.Raw(`SELECT snapshot FROM projects WHERE id='p'`).Scan(&saved).Error; err != nil {
		t.Fatal(err)
	}
	var graph map[string]any
	if err = json.Unmarshal(saved.Snapshot, &graph); err != nil {
		t.Fatal(err)
	}
	if graph["custom"] != "keep" {
		t.Fatal("snapshot extension lost")
	}
	nodes := graph["nodes"].([]any)
	if len(nodes) != 2 {
		t.Fatalf("nodes=%d", len(nodes))
	}
	out := nodes[1].(map[string]any)["data"].(map[string]any)
	prompt := out["prompt"].([]any)
	if prompt[0].(map[string]any)["text"] != "hello" {
		t.Fatalf("output=%v", prompt)
	}
	var version int64
	if err = s.DB.Raw(`SELECT version FROM projects WHERE id='p'`).Scan(&version).Error; err != nil || version != 4 {
		t.Fatalf("version=%d %v", version, err)
	}
}
func TestStopAndDeletedOutputStayStopped(t *testing.T) {
	s, a, _ := setup(t)
	ctx := context.Background()
	request := script.Create{RequestID: "req-2", CanvasID: "p", NodeID: "script-1", Input: script.Input{Model: "deepseek-v4-pro-ga-260813", Requirements: "write", Preset: "free"}}
	task, err := s.Create(ctx, a, request)
	if err != nil {
		t.Fatal(err)
	}
	stopped, err := s.Stop(ctx, a, task.ID)
	if err != nil || stopped.Status != "stopped" {
		t.Fatalf("stop %+v %v", stopped, err)
	}
	if claim, err := s.Claim(ctx, task.ID, time.Second); err != nil || claim != nil {
		t.Fatalf("stopped claimed %+v %v", claim, err)
	}
}

type storyboardStream struct{ FailAssets bool }

func (s storyboardStream) Stream(_ context.Context, r textmodel.Request, emit textmodel.Emit) error {
	var content string
	switch {
	case strings.Contains(r.Prompt, "短片镜头骨架规划"):
		content = `{"summary":"夜景短片","shots":[{"title":"街口","duration":15,"action":"走入街口","characters":["小雨"],"scene":"街口","props":[]},{"title":"相遇","duration":15,"action":"遇到朋友","characters":["小雨"],"scene":"街口","props":[]}]}`
	case strings.Contains(r.Prompt, "固定资产名称"):
		if s.FailAssets {
			return errors.New("provider failed")
		}
		content = `{"characters":[{"name":"小雨","description":"年轻人，蓝色外套"}],"scene":[{"name":"街口","description":"夜色中的街口"}],"props":[]}`
	default:
		content = `{"shots":[{"id":"shot-001","visual":"走入街口","size":"中景","lighting":"路灯","dialogue":"无","sound":"脚步声","camera":"跟拍"},{"id":"shot-002","visual":"遇到朋友","size":"近景","lighting":"路灯","dialogue":"你好","sound":"无","camera":"固定"}]}`
	}
	return emit(content)
}
func TestWorkflowCheckpointRetryAndCompletion(t *testing.T) {
	s, a, _ := setup(t)
	ctx := context.Background()
	in := script.Input{Model: "deepseek-v4-pro-ga-260813", Requirements: "short film", Instruction: "create", Preset: "storyboard", OutputMode: "workflow", Storyboard: &script.Limits{Duration: 30, MaxShots: 2}}
	task, err := s.Create(ctx, a, script.Create{RequestID: "wf-1", CanvasID: "p", NodeID: "script-1", Input: in})
	if err != nil {
		t.Fatal(err)
	}
	if task.OutputNodeID != "script-1" || len(task.Workflow) == 0 {
		t.Fatalf("workflow create %+v", task)
	}
	failing := script.Worker{Store: s, Model: storyboardStream{FailAssets: true}}
	if err = failing.Process(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	failed, err := s.Get(ctx, a, task.ID)
	if err != nil || failed.Status != "failed" {
		t.Fatalf("failed %+v %v", failed, err)
	}
	var state script.Workflow
	if err = json.Unmarshal(failed.Workflow, &state); err != nil {
		t.Fatal(err)
	}
	if state.Plan == nil || state.Step("plan").Status != "completed" || state.Step("assets").Status != "failed" {
		t.Fatalf("checkpoint %+v", state)
	}
	retry, err := s.Create(ctx, a, script.Create{RequestID: "wf-2", CanvasID: "p", NodeID: "script-1", Input: in})
	if err != nil || retry.ID != task.ID || retry.Status != "queued" {
		t.Fatalf("retry %+v %v", retry, err)
	}
	working := script.Worker{Store: s, Model: storyboardStream{}}
	if err = working.Process(ctx, task.ID); err != nil {
		t.Fatal(err)
	}
	completed, err := s.Get(ctx, a, task.ID)
	if err != nil || completed.Status != "completed" || !strings.Contains(completed.Text, "视频提示词：") {
		t.Fatalf("completed %+v %v", completed, err)
	}
	if err = json.Unmarshal(completed.Workflow, &state); err != nil {
		t.Fatal(err)
	}
	if state.Progress(true) != 100 || state.Step("plan").Attempts != 1 || state.Step("assets").Attempts != 2 {
		t.Fatalf("progress/retry %+v", state)
	}
	oldReplay, err := s.Create(ctx, a, script.Create{RequestID: "wf-1", CanvasID: "p", NodeID: "script-1", Input: in})
	if err != nil || oldReplay.ID != task.ID {
		t.Fatalf("old replay %+v %v", oldReplay, err)
	}
}
