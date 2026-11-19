//go:build integration

package postgres

import (
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/generation"
	generationpostgres "blow-flow/api/internal/generation/postgres"
	"blow-flow/api/internal/resource"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pressly/goose/v3"
)

func resourceStore(t *testing.T) (*Repository, string, string) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	_, admin, err := database.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := fmt.Sprintf("resources_%d", time.Now().UnixNano())
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
	migrations, _ := filepath.Abs("../../../migrations")
	if err = goose.Up(pool, migrations); err != nil {
		t.Fatal(err)
	}
	a, b := "00000000-0000-0000-0000-000000000031", "00000000-0000-0000-0000-000000000032"
	for _, owner := range []string{a, b} {
		if err = db.Exec(`INSERT INTO users(id,email,status,created_at,updated_at) VALUES(?,?, 'active',now(),now())`, owner, owner+"@example.com").Error; err != nil {
			t.Fatal(err)
		}
	}
	return New(db), a, b
}
func TestProjectOwnershipVersionReceiptsAndTrash(t *testing.T) {
	r, a, b := resourceStore(t)
	ctx := context.Background()
	svc := resource.Service{Repository: r}
	folder, err := svc.CreateFolder(ctx, a, "folder", "Shots")
	if err != nil {
		t.Fatal(err)
	}
	p, err := svc.CreateProject(ctx, a, "project", "Draft", &folder.ID)
	if err != nil || p.Version != 1 {
		t.Fatalf("create %+v %v", p, err)
	}
	if _, err = svc.GetProject(ctx, b, p.ID); !errors.Is(err, resource.ErrNotFound) {
		t.Fatalf("cross-user read: %v", err)
	}
	if _, err = svc.CreateProject(ctx, b, p.ID, "Stolen", nil); !errors.Is(err, resource.ErrDuplicate) {
		t.Fatalf("cross-user ID reuse: %v", err)
	}
	snapshot := []byte(`{"name":"Scene","nodes":[{"id":"node-a","position":{"x":0,"y":0},"data":{}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`)
	input := resource.SaveCanvas{RequestID: "save-1", BaseVersion: 1, Snapshot: snapshot}
	ack, err := svc.SaveCanvas(ctx, a, p.ID, input)
	if err != nil || ack.Version != 2 {
		t.Fatalf("save %+v %v", ack, err)
	}
	replay, err := svc.SaveCanvas(ctx, a, p.ID, input)
	if err != nil || replay.Version != 2 {
		t.Fatalf("replay %+v %v", replay, err)
	}
	input.Snapshot = []byte(`{"name":"Changed","nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`)
	if _, err = svc.SaveCanvas(ctx, a, p.ID, input); !errors.Is(err, resource.ErrRequestConflict) {
		t.Fatalf("idempotency conflict: %v", err)
	}
	input.RequestID = "save-2"
	if _, err = svc.SaveCanvas(ctx, a, p.ID, input); !errors.Is(err, resource.ErrConflict) {
		t.Fatalf("stale version: %v", err)
	}
	if _, err = svc.SaveCanvas(ctx, b, p.ID, resource.SaveCanvas{RequestID: "foreign", BaseVersion: 2, Snapshot: snapshot}); !errors.Is(err, resource.ErrNotFound) {
		t.Fatalf("cross-user save: %v", err)
	}
	trashed, err := svc.ChangeProject(ctx, a, p.ID, resource.ProjectChange{Action: "trash", ExpectedVersion: 2})
	if err != nil || trashed.Version != 3 {
		t.Fatalf("trash %+v %v", trashed, err)
	}
	if _, err = svc.GetProject(ctx, a, p.ID); !errors.Is(err, resource.ErrDeleted) {
		t.Fatalf("deleted read: %v", err)
	}
	if _, err = svc.SaveCanvas(ctx, a, p.ID, resource.SaveCanvas{RequestID: "save-1", BaseVersion: 1, Snapshot: snapshot}); !errors.Is(err, resource.ErrDeleted) {
		t.Fatalf("deleted replay: %v", err)
	}
	restored, err := svc.ChangeProject(ctx, a, p.ID, resource.ProjectChange{Action: "restore", ExpectedVersion: 3})
	if err != nil || restored.Version != 4 {
		t.Fatalf("restore %+v %v", restored, err)
	}
	if err = svc.DeleteFolder(ctx, a, folder.ID); err != nil {
		t.Fatal(err)
	}
	got, err := svc.GetProject(ctx, a, p.ID)
	if err != nil || got.FolderID != nil {
		t.Fatalf("folder deletion %+v %v", got, err)
	}
	if _, err = svc.SaveCanvas(ctx, a, p.ID, resource.SaveCanvas{RequestID: "delete-node", BaseVersion: got.Version, Snapshot: []byte(`{"name":"Scene","nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`)}); err != nil {
		t.Fatal(err)
	}
	deleted, err := svc.DeletedNodes(ctx, a, p.ID, []string{"node-a", "new-node"})
	if err != nil || len(deleted) != 1 || deleted[0] != "node-a" {
		t.Fatalf("deleted nodes=%v %v", deleted, err)
	}
	if _, err = svc.DeletedNodes(ctx, b, p.ID, []string{"node-a"}); !errors.Is(err, resource.ErrNotFound) {
		t.Fatalf("cross-user tombstone lookup: %v", err)
	}
}
func TestAssetIsOwnedBySameUserAndProject(t *testing.T) {
	r, a, b := resourceStore(t)
	ctx := context.Background()
	svc := resource.Service{Repository: r}
	if _, err := svc.CreateProject(ctx, a, "p", "P", nil); err != nil {
		t.Fatal(err)
	}
	asset, err := svc.CreateAsset(ctx, a, resource.AssetInput{ProjectID: "p", Kind: "image", ObjectKey: "uploads/a/p/x.png", URL: "https://example.com/x.png", SizeBytes: 10})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = svc.GetAsset(ctx, b, asset.ID); !errors.Is(err, resource.ErrNotFound) {
		t.Fatalf("cross-user asset: %v", err)
	}
	if _, err = svc.CreateAsset(ctx, b, resource.AssetInput{ProjectID: "p", Kind: "image", ObjectKey: "x", URL: "https://example.com/x", SizeBytes: 10}); !errors.Is(err, resource.ErrNotFound) {
		t.Fatalf("foreign project asset: %v", err)
	}
	if _, err = svc.ChangeProject(ctx, a, "p", resource.ProjectChange{Action: "trash", ExpectedVersion: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.GetAsset(ctx, a, asset.ID); err != nil {
		t.Fatalf("asset should retain its own lifecycle after trash: %v", err)
	}
}

func TestImportedCanvasReceiptReplaysNextCanonicalDigest(t *testing.T) {
	r, owner, _ := resourceStore(t)
	ctx := context.Background()
	svc := resource.Service{Repository: r}
	if _, err := svc.CreateProject(ctx, owner, "legacy", "<scene>", nil); err != nil {
		t.Fatal(err)
	}
	const digest = "170bc182fb6bf6b3d7150631b174aa84ce812dec93fd435fab163863c81576fb"
	if err := r.DB.Exec(`INSERT INTO project_save_receipts(project_id,request_id,digest,version) VALUES('legacy','old-request',?,2)`, digest).Error; err != nil {
		t.Fatal(err)
	}
	if err := r.DB.Exec(`UPDATE projects SET version=2 WHERE id='legacy'`).Error; err != nil {
		t.Fatal(err)
	}
	snapshot := []byte(`{"viewport":{"zoom":1,"y":0,"x":0},"edges":[],"nodes":[],"name":"<scene>"}`)
	receipt, err := svc.SaveCanvas(ctx, owner, "legacy", resource.SaveCanvas{RequestID: "old-request", BaseVersion: 1, Snapshot: snapshot})
	if err != nil || receipt.Version != 2 {
		t.Fatalf("legacy replay: %+v %v", receipt, err)
	}
}

func TestWorkspaceCountAndCoverFollowCanvasChanges(t *testing.T) {
	r, owner, _ := resourceStore(t)
	ctx := context.Background()
	svc := resource.Service{Repository: r}
	f, err := svc.CreateFolder(ctx, owner, "f", "Folder")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = svc.CreateProject(ctx, owner, "p", "Project", &f.ID); err != nil {
		t.Fatal(err)
	}
	view, err := svc.Workspace(ctx, owner, false)
	if err != nil || len(view.Folders) != 1 || view.Folders[0].ProjectCount != 1 {
		t.Fatalf("workspace %+v %v", view, err)
	}
	first := []byte(`{"name":"Project","nodes":[{"id":"image","type":"textToImage","position":{"x":0,"y":0},"data":{"imageSrc":"https://oss.test/a.png"}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`)
	if _, err = svc.SaveCanvas(ctx, owner, "p", resource.SaveCanvas{RequestID: "a", BaseVersion: 1, Snapshot: first}); err != nil {
		t.Fatal(err)
	}
	p, err := svc.GetProject(ctx, owner, "p")
	if err != nil || p.CoverURL == nil || *p.CoverURL != "https://oss.test/a.png" {
		t.Fatalf("first cover %+v %v", p.CoverURL, err)
	}
	second := []byte(`{"name":"Project","nodes":[{"id":"image","type":"textToImage","position":{"x":0,"y":0},"data":{"imageSrc":"https://oss.test/b.png"}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`)
	if _, err = svc.SaveCanvas(ctx, owner, "p", resource.SaveCanvas{RequestID: "b", BaseVersion: 2, Snapshot: second}); err != nil {
		t.Fatal(err)
	}
	p, err = svc.GetProject(ctx, owner, "p")
	if err != nil || p.CoverURL == nil || *p.CoverURL != "https://oss.test/b.png" {
		t.Fatalf("changed cover %+v %v", p.CoverURL, err)
	}
	if _, err = svc.ChangeProject(ctx, owner, "p", resource.ProjectChange{Action: "trash", ExpectedVersion: 3}); err != nil {
		t.Fatal(err)
	}
	view, err = svc.Workspace(ctx, owner, true)
	if err != nil || len(view.Folders) != 1 || view.Folders[0].ProjectCount != 0 {
		t.Fatalf("trash count %+v %v", view, err)
	}
}

func TestUserCanvasDeletionCancelsQueuedGenerationAndDetachesResult(t *testing.T) {
	r, owner, _ := resourceStore(t)
	r.OnNodesRemoved = generationpostgres.DetachRemovedNodes
	ctx := context.Background()
	svc := resource.Service{Repository: r}
	if _, err := svc.CreateProject(ctx, owner, "p-deletion", "Canvas", nil); err != nil {
		t.Fatal(err)
	}
	withNode := []byte(`{"name":"Canvas","nodes":[{"id":"canvas-node","position":{"x":0,"y":0},"data":{"generationNodeId":"generation-node"}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`)
	if _, err := svc.SaveCanvas(ctx, owner, "p-deletion", resource.SaveCanvas{RequestID: "add", BaseVersion: 1, Snapshot: withNode}); err != nil {
		t.Fatal(err)
	}
	store := generationpostgres.New(r.DB)
	task, err := store.Create(ctx, owner, "queued-deletion", "hash", generation.Input{ProjectID: "p-deletion", NodeID: "generation-node", Model: "runninghub/krea2", Prompt: "cat", Width: 1024, Height: 1024})
	if err != nil {
		t.Fatal(err)
	}
	withoutNode := []byte(`{"name":"Canvas","nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`)
	if _, err := svc.SaveCanvas(ctx, owner, "p-deletion", resource.SaveCanvas{RequestID: "remove", BaseVersion: 2, Snapshot: withoutNode}); err != nil {
		t.Fatal(err)
	}
	got, _, err := store.Get(ctx, task.ID)
	if err != nil || got.Status != generation.Canceled {
		t.Fatalf("task: %+v %v", got, err)
	}
	var n int64
	if err := r.DB.Raw(`SELECT count(*) FROM generation_node_results WHERE owner_id=? AND project_id='p-deletion' AND node_id='generation-node'`, owner).Scan(&n).Error; err != nil || n != 0 {
		t.Fatalf("mapping=%d %v", n, err)
	}
}
