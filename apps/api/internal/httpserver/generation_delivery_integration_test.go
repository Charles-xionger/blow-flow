//go:build integration

package httpserver

import (
	"blow-flow/api/internal/account"
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/generation"
	generationpostgres "blow-flow/api/internal/generation/postgres"
	"context"
	"fmt"
	"github.com/pressly/goose/v3"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGenerationDeliveryVisibleThroughGoAPI(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("TEST_DATABASE_URL required")
	}
	_, admin, err := database.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("api_delivery_%d", time.Now().UnixNano())
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
	migrations, _ := filepath.Abs("../../migrations")
	if err = goose.Up(pool, migrations); err != nil {
		t.Fatal(err)
	}
	owner := "00000000-0000-0000-0000-000000000009"
	if err = db.Exec(`INSERT INTO users(id,email,status,created_at,updated_at) VALUES(?,'api-delivery@example.com','active',now(),now())`, owner).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`INSERT INTO projects(id,owner_id,name,snapshot,version,created_at,updated_at) VALUES('project',?,'Project','{}'::jsonb,1,now(),now())`, owner).Error; err != nil {
		t.Fatal(err)
	}
	store := generationpostgres.New(db)
	ctx := context.Background()
	input := generation.Input{ProjectID: "project", Model: "runninghub/krea2", Prompt: "cat", Width: 1024, Height: 1024, Seed: 42}
	task, err := store.Create(ctx, owner, "key", "hash", input)
	if err != nil {
		t.Fatal(err)
	}
	submission, ok, err := store.ClaimSubmission(ctx, task.ID)
	if err != nil || !ok {
		t.Fatal(err)
	}
	if err = store.ResolveSubmission(ctx, task.ID, submission.Token, "provider-id", nil); err != nil {
		t.Fatal(err)
	}
	claim, ok, err := store.ClaimDelivery(ctx, task.ID)
	if err != nil || !ok {
		t.Fatal(err)
	}
	if err = store.ProviderSucceeded(ctx, claim, "https://provider.test/result.png", "png", nil); err != nil {
		t.Fatal(err)
	}
	claim, ok, err = store.ClaimDelivery(ctx, task.ID)
	if err != nil || !ok {
		t.Fatal(err)
	}
	if err = store.Delivered(ctx, claim, "https://project-oss/result.png"); err != nil {
		t.Fatal(err)
	}
	service := generation.Service{Store: store}
	router := NewWithDependencies(Dependencies{Accounts: &accountServiceStub{resolved: account.User{ID: owner, Status: account.StatusActive}}, IdentityVerifier: verifierStub{}, Generation: service})
	for path, wants := range map[string][]string{
		"/v1/generation/tasks/" + task.ID:             {`"status":"completed"`, `"stage":"delivered"`, `"resultUrl":"https://project-oss/result.png"`},
		"/v1/generation/tasks/" + task.ID + "/events": {`"type":"provider_succeeded"`, `"type":"delivered"`},
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer valid")
		router.ServeHTTP(rec, req)
		if rec.Code != 200 {
			t.Fatalf("%s: %d %s", path, rec.Code, rec.Body.String())
		}
		for _, want := range wants {
			if !strings.Contains(rec.Body.String(), want) {
				t.Fatalf("%s: missing %s in %s", path, want, rec.Body.String())
			}
		}
		if strings.Contains(rec.Body.String(), "provider.test") || strings.Contains(rec.Body.String(), "provider-id") || strings.Contains(rec.Body.String(), `"percent"`) {
			t.Fatalf("leaked private/unverified data: %s", rec.Body.String())
		}
	}
}
