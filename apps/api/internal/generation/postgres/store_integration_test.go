//go:build integration

package postgres

import (
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/generation"
	"context"
	"fmt"
	"github.com/pressly/goose/v3"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestConcurrentCreateIsOneTaskAndOneOutbox(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("TEST_DATABASE_URL required")
	}
	_, admin, err := database.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("generation_%d", time.Now().UnixNano())
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
	owner := "00000000-0000-0000-0000-000000000001"
	if err = db.Exec(`INSERT INTO users(id,email,status,created_at,updated_at) VALUES(?,'test@example.com','active',now(),now())`, owner).Error; err != nil {
		t.Fatal(err)
	}
	s := New(db)
	ctx := context.Background()
	var ids [12]string
	var wg sync.WaitGroup
	for i := range ids {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			task, err := s.Create(ctx, owner, "concurrent-key", "same-hash", generation.Input{ProjectID: "p", Model: "runninghub/krea2", Prompt: "cat", Width: 1024, Height: 1024})
			if err != nil {
				t.Error(err)
				return
			}
			ids[i] = task.ID
		}(i)
	}
	wg.Wait()
	for _, id := range ids {
		if id == "" || id != ids[0] {
			t.Fatalf("ids=%v", ids)
		}
	}
	var n int64
	db.Raw(`SELECT count(*) FROM generation_outbox WHERE task_id=?`, ids[0]).Scan(&n)
	if n != 1 {
		t.Fatalf("outbox rows=%d", n)
	}
	db.Raw(`SELECT count(*) FROM generation_task_events WHERE task_id=?`, ids[0]).Scan(&n)
	if n != 1 {
		t.Fatalf("event rows=%d", n)
	}
	_, err = s.Create(ctx, owner, "concurrent-key", "different-hash", generation.Input{ProjectID: "p", Model: "runninghub/krea2", Prompt: "dog", Width: 1024, Height: 1024})
	if err != generation.ErrConflict {
		t.Fatalf("conflict=%v", err)
	}
	canceled, err := s.Cancel(ctx, ids[0], owner)
	if err != nil || canceled.Status != generation.Canceled {
		t.Fatalf("cancel=%+v %v", canceled, err)
	}
	if err = db.Exec(`CREATE FUNCTION reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox unavailable'; END $$`).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`CREATE TRIGGER reject_outbox BEFORE INSERT ON generation_outbox FOR EACH ROW EXECUTE FUNCTION reject_outbox()`).Error; err != nil {
		t.Fatal(err)
	}
	_, err = s.Create(ctx, owner, "rollback-key", "hash", generation.Input{ProjectID: "p", Model: "runninghub/krea2", Prompt: "cat", Width: 1024, Height: 1024})
	if err == nil {
		t.Fatal("expected outbox failure")
	}
	db.Raw(`SELECT count(*) FROM generation_tasks WHERE idempotency_key='rollback-key'`).Scan(&n)
	if n != 0 {
		t.Fatalf("orphan tasks=%d", n)
	}
	_, claimed, err := s.Claim(ctx, ids[0])
	if err != nil || claimed {
		t.Fatalf("late claim=%v %v", claimed, err)
	}
}
