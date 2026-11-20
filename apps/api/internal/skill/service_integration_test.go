//go:build integration

package skill

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"blow-flow/api/internal/database"
	"github.com/pressly/goose/v3"
)

func TestPersonalSkillsPersistAndStayWithTheirOwners(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("TEST_DATABASE_URL required")
	}
	_, admin, err := database.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("skill_%d", time.Now().UnixNano())
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
	defer pool.Close()
	if err = goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	dir, _ := filepath.Abs("../../migrations")
	if err = goose.Up(pool, dir); err != nil {
		t.Fatal(err)
	}
	a, b := "00000000-0000-0000-0000-000000000071", "00000000-0000-0000-0000-000000000072"
	for _, id := range []string{a, b} {
		if err = db.Exec(`INSERT INTO users(id,email,status,created_at,updated_at) VALUES(?,?, 'active',now(),now())`, id, id+"@example.com").Error; err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	service := New(db)
	binary := []byte{0, 255, 1, 2}
	input := Upload{Name: "scene-helper", Description: "Drafts scenes", Instructions: "Write three beats", Resources: map[string]string{"assets/pixel.bin": base64.StdEncoding.EncodeToString(binary)}}
	if _, err = service.Upload(ctx, a, input); err != nil {
		t.Fatal(err)
	}
	input.Instructions = "Write four beats"
	if _, err = service.Upload(ctx, b, input); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Upload(ctx, a, input); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate upload: %v", err)
	}
	if _, err = service.Upload(ctx, a, Upload{Name: "screenplay", Description: "x", Instructions: "x"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("built-in upload: %v", err)
	}
	if err = service.Delete(ctx, a, "screenplay"); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("built-in delete: %v", err)
	}
	if err = service.Delete(ctx, b, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing delete: %v", err)
	}
	restarted := New(db)
	detail, err := restarted.Get(ctx, a, "scene-helper")
	if err != nil || detail.Instructions != "Write three beats" || len(detail.Resources) != 1 {
		t.Fatalf("restart detail=%+v err=%v", detail, err)
	}
	var persisted struct{ Content []byte }
	if err = db.Raw(`SELECT content FROM user_skill_resources WHERE owner_id=? AND skill_name=? AND path=?`, a, "scene-helper", "assets/pixel.bin").Scan(&persisted).Error; err != nil || string(persisted.Content) != string(binary) {
		t.Fatalf("resource bytes=%v err=%v", persisted.Content, err)
	}
	if err = restarted.Delete(ctx, a, "scene-helper"); err != nil {
		t.Fatal(err)
	}
	if _, err = restarted.Get(ctx, a, "scene-helper"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted account still sees skill: %v", err)
	}
	if detail, err = restarted.Get(ctx, b, "scene-helper"); err != nil || detail.Instructions != "Write four beats" {
		t.Fatalf("other owner changed: %+v %v", detail, err)
	}
}
