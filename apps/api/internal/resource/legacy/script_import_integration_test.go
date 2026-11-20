//go:build integration

package legacy

import (
	"blow-flow/api/internal/database"
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pressly/goose/v3"
)

func TestImportLegacyScriptTasksPreservesCheckpointAndInterruptsActiveWork(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("TEST_DATABASE_URL required")
	}
	_, admin, err := database.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("script_import_%d", time.Now().UnixNano())
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
	owner := "00000000-0000-0000-0000-000000000051"
	if err = db.Exec(`INSERT INTO users(id,email,status,created_at,updated_at) VALUES(?,?,'active',now(),now())`, owner, "legacy@example.com").Error; err != nil {
		t.Fatal(err)
	}
	workflow := `{"version":1,"steps":[{"key":"plan","label":"规划镜头","status":"completed","attempts":1}],"details":{},"prompts":{}}`
	id := "00000000-0000-4000-8000-000000000052"
	export := Export{SchemaVersion: 1, Projects: []Project{{ID: "project", Name: "Project", Data: `{"name":"Project","nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`, Version: 1, CreatedAt: 1000, UpdatedAt: 1000}}, ScriptTasks: []ScriptTask{{ID: id, RequestID: "request-1", CanvasID: "project", NodeID: "script-node", Input: `{"model":"deepseek-v4-pro-ga-260813","requirements":"write"}`, Status: "running", Text: "draft", Pipeline: &workflow, Phase: "writing", Revision: 3, CreatedAt: 1000, UpdatedAt: 2000}}, ScriptRequests: []ScriptRequest{{RequestID: "request-1", TaskID: id, CanvasID: "project", NodeID: "script-node", Input: `{"model":"deepseek-v4-pro-ga-260813","requirements":"write"}`}, {RequestID: "old-request", TaskID: id, CanvasID: "project", NodeID: "script-node", Input: `{"model":"deepseek-v4-pro-ga-260813","requirements":"write"}`}}}
	if err = Apply(context.Background(), db, owner, "", export); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Status, Text string
		Workflow     []byte
	}
	if err = db.Raw(`SELECT status,text,workflow FROM script_tasks WHERE id=?`, id).Scan(&got).Error; err != nil {
		t.Fatal(err)
	}
	if got.Status != "interrupted" || got.Text != "draft" || string(got.Workflow) == "" {
		t.Fatalf("imported %+v", got)
	}
	var importedStatus string
	if err = db.Raw(`SELECT status FROM script_task_events WHERE task_id=? AND event_type='imported'`, id).Scan(&importedStatus).Error; err != nil || importedStatus != "interrupted" {
		t.Fatalf("imported event status=%q %v", importedStatus, err)
	}
	var aliases int64
	if err = db.Raw(`SELECT count(*) FROM script_requests WHERE task_id=?`, id).Scan(&aliases).Error; err != nil || aliases != 2 {
		t.Fatalf("aliases=%d %v", aliases, err)
	}
	if err = Apply(context.Background(), db, owner, "", export); err != nil {
		t.Fatalf("exact repeat import rejected: %v", err)
	}
	var projects int64
	if err = db.Raw(`SELECT count(*) FROM projects`).Scan(&projects).Error; err != nil || projects != 1 {
		t.Fatalf("rollback projects=%d %v", projects, err)
	}
}
