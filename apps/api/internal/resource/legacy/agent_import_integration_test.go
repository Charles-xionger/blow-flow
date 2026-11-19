//go:build integration

package legacy

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"blow-flow/api/internal/agent"
	agentpostgres "blow-flow/api/internal/agent/postgres"
	"blow-flow/api/internal/database"
	"github.com/pressly/goose/v3"
)

func TestImportLegacyAgentHistoryWithoutReplayingGeneration(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("TEST_DATABASE_URL required")
	}
	_, admin, err := database.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("agent_import_%d", time.Now().UnixNano())
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
	owner := "00000000-0000-0000-0000-000000000091"
	if err = db.Exec(`INSERT INTO users(id,email,status,created_at,updated_at) VALUES(?,'agent-import@example.com','active',now(),now())`, owner).Error; err != nil {
		t.Fatal(err)
	}
	taskID := "00000000-0000-4000-8000-000000000092"
	messageID := "00000000-0000-4000-8000-000000000093"
	export := Export{SchemaVersion: 1, Projects: []Project{{ID: "project", Name: "Project", Data: `{"name":"Project","nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`, Version: 1, CreatedAt: 1000, UpdatedAt: 1000}}, AgentTasks: []LegacyAgentTask{{ID: taskID, ProjectID: "project", Status: "waiting", Data: `{"id":"` + taskID + `","projectId":"project","modelId":"gemini","status":"waiting","createdAt":1000,"question":{"id":"approve","text":"生成？","options":["确认生成"],"scope":{"kind":"generation","items":[]}},"steps":[{"id":"step","name":"prepare_generation","args":{},"status":"completed","result":{"waiting":true}}]}`}}, AgentMessages: []LegacyAgentMessage{{ID: messageID, ProjectID: "project", TaskID: taskID, Data: `{"id":"` + messageID + `","taskId":"` + taskID + `","role":"user","text":"画一只猫","references":[],"createdAt":1000}`}}, AgentReceipts: []LegacyAgentReceipt{{ProjectID: "project", RequestID: "send-1", Digest: "old-digest", TaskID: taskID}}, AgentGenerationBatches: []LegacyAgentBatch{{ID: "old-batch", TaskID: taskID, Data: `{"id":"old-batch","taskId":"` + taskID + `","projectId":"project","status":"pending","items":[]}`}}}
	otherTaskID := "00000000-0000-4000-8000-000000000094"
	export.Projects = append(export.Projects, Project{ID: "other", Name: "Other", Data: `{"name":"Other","nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`, Version: 1, CreatedAt: 1000, UpdatedAt: 1000})
	export.AgentTasks = append(export.AgentTasks, LegacyAgentTask{ID: otherTaskID, ProjectID: "other", Status: "completed", Data: `{"id":"` + otherTaskID + `","projectId":"other","modelId":"gemini","status":"completed","createdAt":1000,"steps":[]}`})
	export.AgentReceipts = append(export.AgentReceipts, LegacyAgentReceipt{ProjectID: "other", RequestID: "send-1", Digest: "other-digest", TaskID: otherTaskID})
	export.AgentCanvasReceipts = []LegacyAgentCanvasReceipt{{ProjectID: "project", Identity: "old-edit", Digest: "canvas-digest", Result: `{"version":2}`}}
	if err = Apply(context.Background(), db, owner, "", export); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Status   string
		Question []byte
	}
	if err = db.Raw(`SELECT status,question FROM agent_tasks WHERE id=?`, taskID).Scan(&got).Error; err != nil {
		t.Fatal(err)
	}
	if got.Status != "interrupted" || string(got.Question) != "null" {
		t.Fatalf("unsafe imported task: %+v", got)
	}
	for table, want := range map[string]int64{"agent_messages": 1, "agent_tool_steps": 1, "agent_command_receipts": 0, "agent_legacy_command_receipts": 2, "agent_legacy_canvas_receipts": 1, "agent_legacy_generation_batches": 1, "agent_legacy_task_snapshots": 2, "generation_tasks": 0, "generation_outbox": 0} {
		var n int64
		if err = db.Raw(`SELECT count(*) FROM ` + table).Scan(&n).Error; err != nil || n != want {
			t.Fatalf("%s=%d want %d: %v", table, n, want, err)
		}
	}
	s := agentpostgres.New(db)
	view, err := s.Snapshot(context.Background(), owner, "project")
	if err != nil || len(view.LegacyGenerationBatches) != 1 || !view.Tasks[0].LegacyImported {
		t.Fatalf("legacy snapshot: %+v %v", view, err)
	}
	if _, err = s.Claim(context.Background(), taskID); !errors.Is(err, agent.ErrConflict) {
		t.Fatalf("legacy claim: %v", err)
	}
	if _, err = s.Command(context.Background(), owner, "project", agent.Command{RequestID: "send-1", Action: "send", Text: "retry", ModelID: "gemini", CanvasVersion: 1}); !errors.Is(err, agent.ErrRequestConflict) {
		t.Fatalf("legacy receipt replay: %v", err)
	}
	if _, err = s.Command(context.Background(), owner, "project", agent.Command{RequestID: "new-send", Action: "send", Text: "new work", ModelID: "gemini", CanvasVersion: 1}); err != nil {
		t.Fatalf("new work blocked: %v", err)
	}
	if err = Apply(context.Background(), db, owner, "", export); err == nil {
		t.Fatal("duplicate import accepted")
	}
}
