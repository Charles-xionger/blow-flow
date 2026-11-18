//go:build integration

package httpserver

import (
	"blow-flow/api/internal/account"
	"blow-flow/api/internal/database"
	generationpostgres "blow-flow/api/internal/generation/postgres"
	"blow-flow/api/internal/resource"
	resourcepostgres "blow-flow/api/internal/resource/postgres"
	"bytes"
	"context"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pressly/goose/v3"
)

type fakeResourceBlobs struct{ uploads int }

func (f *fakeResourceBlobs) Upload(_ context.Context, _, _ string, _ []byte, _ string) (string, string, error) {
	f.uploads++
	return "uploads/test.png", "https://example.test/test.png", nil
}
func (f *fakeResourceBlobs) Delete(context.Context, string) error { return nil }

func TestResourceHTTPAndGenerationOwnership(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	_, admin, err := database.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("resource_http_%d", time.Now().UnixNano())
	if _, err = admin.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec("DROP SCHEMA " + schema + " CASCADE")
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
	migrations, _ := filepath.Abs("../../migrations")
	if err = goose.Up(pool, migrations); err != nil {
		t.Fatal(err)
	}
	owner, other := "00000000-0000-0000-0000-000000000081", "00000000-0000-0000-0000-000000000082"
	for _, id := range []string{owner, other} {
		if err = db.Exec(`INSERT INTO users(id,email,status,created_at,updated_at) VALUES(?,?,'active',now(),now())`, id, id+"@example.test").Error; err != nil {
			t.Fatal(err)
		}
	}
	service := &resource.Service{Repository: resourcepostgres.New(db)}
	blobs := &fakeResourceBlobs{}
	router := func(id string) http.Handler {
		return NewWithDependencies(Dependencies{Accounts: &accountServiceStub{resolved: account.User{ID: id, Status: account.StatusActive}}, IdentityVerifier: verifierStub{}, Resources: service, ResourceBlobs: blobs})
	}
	request := func(handler http.Handler, method, path, body string, want int) string {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer valid")
		req.Header.Set("Content-Type", "application/json")
		handler.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("%s %s: %d %s", method, path, rec.Code, rec.Body.String())
		}
		return rec.Body.String()
	}
	if got := request(router(owner), "POST", "/v1/projects", `{"id":"p","name":"Project"}`, 201); !strings.Contains(got, `"version":1`) {
		t.Fatal(got)
	}
	request(router(owner), "POST", "/v1/folders", `{"id":"f","name":"Folder"}`, 201)
	request(router(owner), "PATCH", "/v1/projects/p", `{"action":"move","expectedVersion":1,"folderId":"f"}`, 200)
	snapshot := `{"name":"New","nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`
	request(router(owner), "PUT", "/v1/projects/p/canvas", `{"requestId":"r1","baseVersion":2,"snapshot":`+snapshot+`}`, 200)
	if got := request(router(owner), "PUT", "/v1/projects/p/canvas", `{"requestId":"r1","baseVersion":2,"snapshot":{"name":"Changed","nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}}`, 409); !strings.Contains(got, `"request_conflict"`) {
		t.Fatalf("request identity conflict: %s", got)
	}
	request(router(other), "GET", "/v1/projects/p", "", 404)
	request(router(other), "PUT", "/v1/projects/p/canvas", `{"requestId":"x","baseVersion":3,"snapshot":`+snapshot+`}`, 404)
	request(router(owner), "POST", "/v1/projects/p/deleted-nodes/check", `{"ids":["node-a"]}`, 200)
	request(router(other), "POST", "/v1/projects/p/deleted-nodes/check", `{"ids":["node-a"]}`, 404)
	if own, err := (generationpostgres.Resources{DB: db}).OwnsProject(context.Background(), owner, "p"); err != nil || !own {
		t.Fatalf("generation owner: %v %v", own, err)
	}
	if own, err := (generationpostgres.Resources{DB: db}).OwnsProject(context.Background(), other, "p"); err != nil || own {
		t.Fatalf("foreign generation: %v %v", own, err)
	}
	var payload bytes.Buffer
	multi := multipart.NewWriter(&payload)
	part, err := multi.CreateFormFile("file", "image.png")
	if err != nil {
		t.Fatal(err)
	}
	part.Write([]byte("\x89PNG\r\n\x1a\n"))
	multi.Close()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/projects/p/assets", &payload)
	req.Header.Set("Authorization", "Bearer valid")
	req.Header.Set("Content-Type", multi.FormDataContentType())
	router(owner).ServeHTTP(rec, req)
	if rec.Code != 201 || blobs.uploads != 1 {
		t.Fatalf("upload %d %s", rec.Code, rec.Body.String())
	}
	request(router(owner), "PATCH", "/v1/projects/p", `{"action":"trash","expectedVersion":3}`, 200)
	if own, err := (generationpostgres.Resources{DB: db}).OwnsProject(context.Background(), owner, "p"); err != nil || own {
		t.Fatalf("trashed generation: %v %v", own, err)
	}
}
