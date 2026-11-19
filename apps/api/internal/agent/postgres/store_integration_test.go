//go:build integration

package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"blow-flow/api/internal/agent"
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/generation"
	generationpostgres "blow-flow/api/internal/generation/postgres"
	"blow-flow/api/internal/resource"
	resourcepostgres "blow-flow/api/internal/resource/postgres"
	"github.com/pressly/goose/v3"
)

func agentStore(t *testing.T) (*Store, *resource.Service, string, string) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("TEST_DATABASE_URL required")
	}
	_, adminDB, err := database.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("agent_%d", time.Now().UnixNano())
	if _, err = adminDB.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { adminDB.Exec("DROP SCHEMA " + schema + " CASCADE"); adminDB.Close() })
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
	migrations, _ := filepath.Abs("../../../migrations")
	if err = goose.Up(pool, migrations); err != nil {
		t.Fatal(err)
	}
	owner := "00000000-0000-0000-0000-000000000088"
	if err = db.Exec(`INSERT INTO users(id,email,status,created_at,updated_at) VALUES(?,'agent@example.com','active',now(),now())`, owner).Error; err != nil {
		t.Fatal(err)
	}
	resources := &resource.Service{Repository: resourcepostgres.New(db)}
	if _, err = resources.CreateProject(context.Background(), owner, "project-a", "Canvas", nil); err != nil {
		t.Fatal(err)
	}
	if _, err = resources.CreateProject(context.Background(), owner, "project-b", "Other", nil); err != nil {
		t.Fatal(err)
	}
	store := New(db)
	return store, resources, owner, "project-a"
}

func TestRunTokenScopesCanvasCommitAndRecoversItsReceipt(t *testing.T) {
	s, resources, owner, project := agentStore(t)
	ctx := context.Background()
	task, err := s.Enqueue(ctx, owner, project, "message-1")
	if err != nil {
		t.Fatal(err)
	}
	replay, err := s.Enqueue(ctx, owner, project, "message-1")
	if err != nil || replay.ID != task.ID {
		t.Fatalf("enqueue replay: %+v %v", replay, err)
	}
	if _, err = s.Enqueue(ctx, owner, "project-b", "message-1"); !errors.Is(err, agent.ErrRequestConflict) {
		t.Fatalf("request identity: %v", err)
	}
	if _, err = s.Enqueue(ctx, owner, project, "message-2"); !errors.Is(err, agent.ErrConflict) {
		t.Fatalf("active project: %v", err)
	}
	run, err := s.Claim(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Claim(ctx, task.ID); !errors.Is(err, agent.ErrConflict) {
		t.Fatalf("duplicate claim: %v", err)
	}
	current, err := s.ReadCanvas(ctx, run.Token)
	if err != nil || current.Version != 1 {
		t.Fatalf("canvas: %+v %v", current, err)
	}
	if _, err = s.ReadCanvas(ctx, "invalid"); !errors.Is(err, agent.ErrRunExpired) {
		t.Fatalf("invalid run: %v", err)
	}
	var old struct {
		Name string `json:"name"`
	}
	_ = json.Unmarshal(current.Snapshot, &old)
	next := json.RawMessage(`{"name":"Canvas","nodes":[{"id":"new","type":"text","position":{"x":0,"y":0},"data":{"type":"text","label":"New"}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1},"history":{"schema":1}}`)
	input := agent.Commit{CallID: "call-1", BaseVersion: 1, Operations: json.RawMessage(`[{"kind":"create","node":{"id":"new","type":"text","position":{"x":0,"y":0},"data":{"type":"text","label":"New"}}}]`), Snapshot: next}
	if _, err = s.CommitCanvas(ctx, run.Token, agent.Commit{CallID: "call-smuggled-create", BaseVersion: 1, Operations: json.RawMessage(`[{"kind":"create","node":{"id":"new","type":"text","position":{"x":10,"y":0}}}]`), Snapshot: next}); !errors.Is(err, agent.ErrForbidden) {
		t.Fatalf("create mismatch: %v", err)
	}
	ack, err := s.CommitCanvas(ctx, run.Token, input)
	if err != nil || ack.Version != 2 {
		t.Fatalf("commit: %+v %v", ack, err)
	}
	again, err := s.CommitCanvas(ctx, run.Token, input)
	if err != nil || again.Version != 2 {
		t.Fatalf("lost response: %+v %v", again, err)
	}
	if receipt, found, err := s.CanvasReceipt(ctx, run.Token, "call-1"); err != nil || !found || receipt.Version != 2 || !sameJSON(receipt.Operations, input.Operations) || string(receipt.RemovedNodes) != "[]" {
		t.Fatalf("receipt lookup: %+v %t %v", receipt, found, err)
	}
	if receipt, found, err := s.CanvasReceipt(ctx, run.Token, "absent"); err != nil || found || receipt.Version != 0 {
		t.Fatalf("missing receipt: %+v %t %v", receipt, found, err)
	}
	changed := input
	changed.Snapshot = json.RawMessage(`{"name":"Changed","nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`)
	if _, err = s.CommitCanvas(ctx, run.Token, changed); !errors.Is(err, agent.ErrRequestConflict) {
		t.Fatalf("reused tool call: %v", err)
	}
	latest, err := s.ReadCanvas(ctx, run.Token)
	if err != nil || latest.Version != 2 {
		t.Fatalf("latest canvas: %+v %v", latest, err)
	}
	updated := json.RawMessage(`{"name":"Canvas","nodes":[{"id":"new","type":"text","position":{"x":0,"y":0},"data":{"type":"text","label":"New","prompt":"Draft","generationContentVersion":1}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1},"history":{"schema":1}}`)
	ack, err = s.CommitCanvas(ctx, run.Token, agent.Commit{CallID: "call-update", BaseVersion: 2, Operations: json.RawMessage(`[{"kind":"update","id":"new","data":{"prompt":"Draft"}}]`), Snapshot: updated})
	if err != nil || ack.Version != 3 {
		t.Fatalf("update task-created node: %+v %v", ack, err)
	}
	smuggled := json.RawMessage(`{"name":"Canvas","nodes":[{"id":"new","type":"text","position":{"x":10,"y":0},"data":{"type":"text","label":"New","prompt":"Secret change","generationContentVersion":1}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1},"history":{"schema":1}}`)
	if _, err = s.CommitCanvas(ctx, run.Token, agent.Commit{CallID: "call-smuggle", BaseVersion: 3, Operations: json.RawMessage(`[{"kind":"move","id":"new","position":{"x":10,"y":0}}]`), Snapshot: smuggled}); !errors.Is(err, agent.ErrForbidden) {
		t.Fatalf("unlisted content rewrite: %v", err)
	}
	removed := json.RawMessage(`{"name":"Canvas","nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`)
	if _, err = resources.SaveCanvas(ctx, owner, project, resource.SaveCanvas{RequestID: "human-delete", BaseVersion: 3, Snapshot: removed}); err != nil {
		t.Fatal(err)
	}
	if deleted, err := s.DeletedNodes(ctx, run.Token, []string{"new"}); err != nil || len(deleted) != 1 || deleted[0] != "new" {
		t.Fatalf("tombstone lookup: %v %v", deleted, err)
	}
	if _, err = s.CommitCanvas(ctx, run.Token, agent.Commit{CallID: "call-2", BaseVersion: 3, Operations: input.Operations, Snapshot: next}); !errors.Is(err, agent.ErrConflict) {
		t.Fatalf("human version conflict: %v", err)
	}
	if _, err = s.CommitCanvas(ctx, run.Token, agent.Commit{CallID: "call-2", BaseVersion: 4, Operations: input.Operations, Snapshot: next}); !errors.Is(err, agent.ErrForbidden) {
		t.Fatalf("deleted identity reused: %v", err)
	}
	if err = s.Finish(ctx, run.Token, "completed"); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ReadCanvas(ctx, run.Token); !errors.Is(err, agent.ErrRunExpired) {
		t.Fatalf("finished token: %v", err)
	}
}

func sameJSON(a, b []byte) bool {
	var left, right any
	return json.Unmarshal(a, &left) == nil && json.Unmarshal(b, &right) == nil && reflect.DeepEqual(left, right)
}

func TestExpiredRunInterruptsWithoutReclaim(t *testing.T) {
	s, _, owner, project := agentStore(t)
	now := time.Now().UTC()
	s.Now = func() time.Time { return now }
	task, err := s.Enqueue(context.Background(), owner, project, "message-2")
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.Claim(context.Background(), task.ID)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(61 * time.Second)
	if _, err = s.Heartbeat(context.Background(), run.Token); !errors.Is(err, agent.ErrRunExpired) {
		t.Fatalf("expired heartbeat: %v", err)
	}
	count, err := s.InterruptExpired(context.Background())
	if err != nil || count != 1 {
		t.Fatalf("interrupt: %d %v", count, err)
	}
	if _, err = s.Claim(context.Background(), task.ID); !errors.Is(err, agent.ErrConflict) {
		t.Fatalf("unsafe auto-claim: %v", err)
	}
}

func TestCommandsPersistMessagesAndReplayWithoutDuplicateWork(t *testing.T) {
	s, _, owner, project := agentStore(t)
	ctx := context.Background()
	input := agent.Command{RequestID: "send-1", Action: "send", Text: "画一只猫", ModelID: "gemini", CanvasVersion: 1}
	task, err := s.Command(ctx, owner, project, input)
	if err != nil || task.Status != "queued" || task.ModelID != "gemini" {
		t.Fatalf("send: %+v %v", task, err)
	}
	replay, err := s.Command(ctx, owner, project, input)
	if err != nil || replay.ID != task.ID {
		t.Fatalf("replay: %+v %v", replay, err)
	}
	input.Text = "画一只狗"
	if _, err := s.Command(ctx, owner, project, input); !errors.Is(err, agent.ErrRequestConflict) {
		t.Fatalf("changed replay: %v", err)
	}
	view, err := s.Snapshot(ctx, owner, project)
	if err != nil || len(view.Tasks) != 1 || len(view.Messages) != 1 || view.Messages[0].Text != "画一只猫" {
		t.Fatalf("snapshot: %+v %v", view, err)
	}
	run, err := s.Claim(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	runContext, err := s.Context(ctx, run.Token)
	if err != nil || runContext.Task.ID != task.ID || len(runContext.Messages) != 1 {
		t.Fatalf("run context: %+v %v", runContext, err)
	}
	var pending int64
	if err := s.DB.Raw(`SELECT count(*) FROM agent_outbox WHERE task_id=? AND published_at IS NULL`, task.ID).Scan(&pending).Error; err != nil || pending != 1 {
		t.Fatalf("outbox: %d %v", pending, err)
	}
	if _, err := s.Snapshot(ctx, "00000000-0000-0000-0000-000000000099", project); !errors.Is(err, agent.ErrNotFound) {
		t.Fatalf("other owner: %v", err)
	}
	if _, err := s.Command(ctx, owner, "project-b", agent.Command{RequestID: "send-1", Action: "send", Text: "画一只猫", ModelID: "gemini", CanvasVersion: 1}); !errors.Is(err, agent.ErrRequestConflict) {
		t.Fatalf("cross-project replay: %v", err)
	}
	if _, err := s.Command(ctx, owner, project, agent.Command{RequestID: "send-2", Action: "send", Text: "再加一只狗", ModelID: "gemini", CanvasVersion: 2}); !errors.Is(err, agent.ErrConflict) {
		t.Fatalf("stale canvas: %v", err)
	}
	if _, err := s.Command(ctx, owner, project, agent.Command{RequestID: "bad-reference", Action: "send", Text: "参考别人的节点", ModelID: "gemini", CanvasVersion: 1, References: []agent.Reference{{NodeID: "missing"}}}); !errors.Is(err, agent.ErrInvalid) {
		t.Fatalf("unknown reference: %v", err)
	}
	if _, err := s.Command(ctx, owner, project, agent.Command{RequestID: "send-2", Action: "send", Text: "再加一只狗", ModelID: "gemini", CanvasVersion: 1}); err != nil {
		t.Fatal(err)
	}
	view, err = s.Snapshot(ctx, owner, project)
	if err != nil || len(view.Messages) != 2 || len(view.Tasks) != 1 {
		t.Fatalf("follow-up: %+v %v", view, err)
	}
	if _, err := s.Command(ctx, owner, project, agent.Command{RequestID: "stop-1", Action: "stop"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Context(ctx, run.Token); !errors.Is(err, agent.ErrRunExpired) {
		t.Fatalf("stopped token: %v", err)
	}
	if _, err := s.Claim(ctx, task.ID); !errors.Is(err, agent.ErrConflict) {
		t.Fatalf("stopped task claimed: %v", err)
	}
}

func TestAgentDeletionCancelsQueuedGenerationAndDetachesLateResult(t *testing.T) {
	s, _, owner, project := agentStore(t)
	ctx := context.Background()
	task, err := s.Enqueue(ctx, owner, project, "remove-generation")
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.Claim(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	created := json.RawMessage(`{"name":"Canvas","nodes":[{"id":"generated","type":"image","position":{"x":0,"y":0},"data":{"type":"image","label":"Result"}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1},"history":{"schema":1}}`)
	if _, err = s.CommitCanvas(ctx, run.Token, agent.Commit{CallID: "create", BaseVersion: 1, Operations: json.RawMessage(`[{"kind":"create","node":{"id":"generated","type":"image","position":{"x":0,"y":0},"data":{"type":"image","label":"Result"}}}]`), Snapshot: created}); err != nil {
		t.Fatal(err)
	}
	gen := generationpostgres.New(s.DB)
	queued, err := gen.Create(ctx, owner, "queued-generation", "hash", generation.Input{ProjectID: project, NodeID: "generated", Model: "runninghub/krea2", Prompt: "cat", Width: 1024, Height: 1024})
	if err != nil {
		t.Fatal(err)
	}
	removed := json.RawMessage(`{"name":"Canvas","nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1},"history":{"schema":1}}`)
	if _, err = s.CommitCanvas(ctx, run.Token, agent.Commit{CallID: "delete", BaseVersion: 2, Operations: json.RawMessage(`[{"kind":"delete","id":"generated"}]`), Snapshot: removed}); err != nil {
		t.Fatal(err)
	}
	got, _, err := gen.Get(ctx, queued.ID)
	if err != nil || got.Status != generation.Canceled {
		t.Fatalf("queued task after node delete: %+v %v", got, err)
	}
	var mappings int64
	if err = s.DB.Raw(`SELECT count(*) FROM generation_node_results WHERE owner_id=? AND project_id=? AND node_id='generated'`, owner, project).Scan(&mappings).Error; err != nil || mappings != 0 {
		t.Fatalf("late result mapping: %d %v", mappings, err)
	}
}

func TestRunnerMessagesStepsAndQuestionSurviveResume(t *testing.T) {
	s, _, owner, project := agentStore(t)
	ctx := context.Background()
	task, err := s.Command(ctx, owner, project, agent.Command{RequestID: "send", Action: "send", Text: "帮我规划", ModelID: "gemini", CanvasVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.Claim(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	start := agent.StepStart{CallID: "read-1", Name: "read_canvas", Arguments: json.RawMessage(`{}`)}
	step, err := s.StartStep(ctx, run.Token, start)
	if err != nil || step.Status != "running" {
		t.Fatalf("step start: %+v %v", step, err)
	}
	if _, err := s.StartStep(ctx, run.Token, agent.StepStart{CallID: "read-1", Name: "read_canvas", Arguments: json.RawMessage(`{"changed":true}`)}); !errors.Is(err, agent.ErrRequestConflict) {
		t.Fatalf("step identity: %v", err)
	}
	step, err = s.FinishStep(ctx, run.Token, agent.StepFinish{CallID: "read-1", Status: "completed", Result: json.RawMessage(`{"nodes":[]}`)})
	if err != nil || step.Status != "completed" {
		t.Fatalf("step finish: %+v %v", step, err)
	}
	if err := s.AppendReply(ctx, run.Token, "reply-1", "先规划三幕"); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendReply(ctx, run.Token, "reply-1", "先规划三幕"); err != nil {
		t.Fatal(err)
	}
	if err := s.AppendReply(ctx, run.Token, "reply-1", "修改回复"); !errors.Is(err, agent.ErrRequestConflict) {
		t.Fatalf("reply identity: %v", err)
	}
	q := agent.Question{ID: "question-1", Text: "需要竖屏吗？", Options: []string{"是", "否"}}
	if err := s.AskQuestion(ctx, run.Token, q); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Context(ctx, run.Token); !errors.Is(err, agent.ErrRunExpired) {
		t.Fatalf("waiting token: %v", err)
	}
	answer, err := s.Command(ctx, owner, project, agent.Command{RequestID: "answer", Action: "answer", QuestionID: "question-1", Text: "是"})
	if err != nil || answer.Status != "queued" {
		t.Fatalf("answer: %+v %v", answer, err)
	}
	resumed, err := s.Claim(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	context, err := s.Context(ctx, resumed.Token)
	if err != nil || len(context.Messages) != 3 || len(context.Steps) != 1 || context.Steps[0].Status != "completed" || context.Task.Question == nil || context.Task.Question.Answer != "是" {
		t.Fatalf("resumed context: %+v %v", context, err)
	}
}

func TestMessageSentDuringRunQueuesAnotherTurn(t *testing.T) {
	s, _, owner, project := agentStore(t)
	ctx := context.Background()
	task, err := s.Command(ctx, owner, project, agent.Command{RequestID: "first", Action: "send", Text: "first", ModelID: "gemini", CanvasVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.Claim(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Command(ctx, owner, project, agent.Command{RequestID: "second", Action: "send", Text: "second", ModelID: "gemini", CanvasVersion: 1}); err != nil {
		t.Fatal(err)
	}
	if err := s.Finish(ctx, run.Token, "completed"); err != nil {
		t.Fatal(err)
	}
	view, err := s.Snapshot(ctx, owner, project)
	if err != nil || len(view.Tasks) != 1 || view.Tasks[0].Status != "queued" || len(view.Messages) != 2 {
		t.Fatalf("follow-up: %+v %v", view, err)
	}
}

func TestUserReferenceGrantsExistingNodeEditForOnlyThatTask(t *testing.T) {
	s, resources, owner, project := agentStore(t)
	ctx := context.Background()
	start := json.RawMessage(`{"name":"Canvas","nodes":[{"id":"existing","type":"text","position":{"x":0,"y":0},"data":{"type":"text","label":"Original"}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1},"history":{"schema":1}}`)
	if _, err := resources.SaveCanvas(ctx, owner, project, resource.SaveCanvas{RequestID: "setup", BaseVersion: 1, Snapshot: start}); err != nil {
		t.Fatal(err)
	}
	task, err := s.Command(ctx, owner, project, agent.Command{RequestID: "referenced", Action: "send", Text: "修改这个节点", ModelID: "gemini", CanvasVersion: 2, References: []agent.Reference{{NodeID: "existing"}}})
	if err != nil {
		t.Fatal(err)
	}
	run, err := s.Claim(ctx, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	next := json.RawMessage(`{"name":"Canvas","nodes":[{"id":"existing","type":"text","position":{"x":0,"y":0},"data":{"type":"text","label":"Changed","generationContentVersion":1}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1},"history":{"schema":1}}`)
	if _, err := s.CommitCanvas(ctx, run.Token, agent.Commit{CallID: "edit-existing", BaseVersion: 2, Operations: json.RawMessage(`[{"kind":"update","id":"existing","data":{"label":"Changed"}}]`), Snapshot: next}); err != nil {
		t.Fatalf("referenced edit: %v", err)
	}
}
