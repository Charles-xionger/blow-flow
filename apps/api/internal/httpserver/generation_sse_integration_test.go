//go:build integration

package httpserver

import (
	"blow-flow/api/internal/account"
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/generation"
	generationpostgres "blow-flow/api/internal/generation/postgres"
	"blow-flow/api/internal/generation/progress"
	"bufio"
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

func TestGenerationSSEAcrossInstancesAndRedisFailure(t *testing.T) {
	dsn, redisURL := os.Getenv("TEST_DATABASE_URL"), os.Getenv("TEST_REDIS_URL")
	if dsn == "" || redisURL == "" {
		t.Fatal("TEST_DATABASE_URL and TEST_REDIS_URL required")
	}
	_, admin, err := database.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	schema := fmt.Sprintf("sse_%d", time.Now().UnixNano())
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
	owner := "00000000-0000-0000-0000-000000000041"
	if err = db.Exec(`INSERT INTO users(id,email,status,created_at,updated_at) VALUES(?,'sse@example.com','active',now(),now())`, owner).Error; err != nil {
		t.Fatal(err)
	}
	redisA, err := progress.Dial(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	defer redisA.Close()
	redisB, err := progress.Dial(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	defer redisB.Close()
	storeA, storeB := generationpostgres.New(db), generationpostgres.New(db)
	storeA.Notify = redisA.Publish
	storeB.Notify = redisB.Publish
	task, err := storeA.Create(context.Background(), owner, "sse-key", "hash", generation.Input{ProjectID: "p", Model: "runninghub/krea2", Prompt: "cat", Width: 1024, Height: 1024})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewWithDependencies(Dependencies{Accounts: &accountServiceStub{resolved: account.User{ID: owner, Status: account.StatusActive}}, IdentityVerifier: verifierStub{}, Generation: generation.Service{Store: storeB}, GenerationWakeups: redisB}))
	defer server.Close()
	serverA := httptest.NewServer(NewWithDependencies(Dependencies{Accounts: &accountServiceStub{resolved: account.User{ID: owner, Status: account.StatusActive}}, IdentityVerifier: verifierStub{}, Generation: generation.Service{Store: storeA}, GenerationWakeups: redisA}))
	defer serverA.Close()
	endpoint := server.URL + "/v1/generation/tasks/" + task.ID + "/events"
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	req.Header.Set("Authorization", "Bearer valid")
	req.Header.Set("Accept", "text/event-stream")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("SSE status=%d", response.StatusCode)
	}
	reader := bufio.NewReader(response.Body)
	initial := readSSE(t, reader)
	if !strings.Contains(initial, `"status":"queued"`) {
		t.Fatal(initial)
	}
	localReq, _ := http.NewRequestWithContext(ctx, "GET", serverA.URL+"/v1/generation/tasks/"+task.ID+"/events", nil)
	localReq.Header.Set("Authorization", "Bearer valid")
	localReq.Header.Set("Accept", "text/event-stream")
	localResponse, err := http.DefaultClient.Do(localReq)
	if err != nil {
		t.Fatal(err)
	}
	defer localResponse.Body.Close()
	localReader := bufio.NewReader(localResponse.Body)
	if first := readSSE(t, localReader); !strings.Contains(first, `"status":"queued"`) {
		t.Fatal(first)
	}
	redisA.Publish(context.Background(), task.ID) // duplicate wakeup must not duplicate the snapshot
	time.Sleep(50 * time.Millisecond)
	cancelViaAPI(t, serverA.URL, task.ID)
	changed := readSSE(t, reader)
	if !strings.Contains(changed, `"status":"canceled"`) || !strings.Contains(changed, `"version":2`) {
		t.Fatal(changed)
	}
	localChanged := readSSE(t, localReader)
	if !strings.Contains(localChanged, `"status":"canceled"`) {
		t.Fatal(localChanged)
	}
	response.Body.Close()
	second, err := storeA.Create(context.Background(), owner, "sse-key-2", "hash-2", generation.Input{ProjectID: "p", Model: "runninghub/krea2", Prompt: "dog", Width: 1024, Height: 1024})
	if err != nil {
		t.Fatal(err)
	}
	secondEndpoint := server.URL + "/v1/generation/tasks/" + second.ID + "/events"
	secondRequest, _ := http.NewRequestWithContext(ctx, "GET", secondEndpoint, nil)
	secondRequest.Header.Set("Authorization", "Bearer valid")
	secondRequest.Header.Set("Accept", "text/event-stream")
	secondResponse, err := http.DefaultClient.Do(secondRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer secondResponse.Body.Close()
	secondReader := bufio.NewReader(secondResponse.Body)
	if first := readSSE(t, secondReader); !strings.Contains(first, `"status":"queued"`) {
		t.Fatal(first)
	}
	// Redis disappears while the stream is open. A later database transition is found by polling.
	redisB.Close()
	cancelViaAPI(t, serverA.URL, second.ID)
	if recovered := readSSE(t, secondReader); !strings.Contains(recovered, `"status":"canceled"`) {
		t.Fatal(recovered)
	}
	// Redis is unavailable to this API instance; the next connection still gets the PostgreSQL snapshot.
	req, _ = http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	req.Header.Set("Authorization", "Bearer valid")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Last-Event-ID", "1")
	response, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if got := readSSE(t, bufio.NewReader(response.Body)); !strings.Contains(got, `"status":"canceled"`) {
		t.Fatal(got)
	}
	// A different resource owner cannot open the stream.
	other := httptest.NewServer(NewWithDependencies(Dependencies{Accounts: &accountServiceStub{resolved: account.User{ID: "00000000-0000-0000-0000-000000000042", Status: account.StatusActive}}, IdentityVerifier: verifierStub{}, Generation: generation.Service{Store: storeB}}))
	defer other.Close()
	req, _ = http.NewRequestWithContext(ctx, "GET", other.URL+"/v1/generation/tasks/"+task.ID+"/events", nil)
	req.Header.Set("Authorization", "Bearer valid")
	req.Header.Set("Accept", "text/event-stream")
	forbidden, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer forbidden.Body.Close()
	if forbidden.StatusCode != 404 {
		t.Fatalf("other owner status=%d", forbidden.StatusCode)
	}
	adminOther := httptest.NewServer(NewWithDependencies(Dependencies{Accounts: &accountServiceStub{resolved: account.User{ID: "00000000-0000-0000-0000-000000000043", Role: account.RoleAdmin, Status: account.StatusActive}}, IdentityVerifier: verifierStub{}, Generation: generation.Service{Store: storeB}}))
	defer adminOther.Close()
	adminReq, _ := http.NewRequestWithContext(ctx, "GET", adminOther.URL+"/v1/generation/tasks/"+task.ID+"/events", nil)
	adminReq.Header.Set("Authorization", "Bearer valid")
	adminReq.Header.Set("Accept", "text/event-stream")
	adminResponse, err := http.DefaultClient.Do(adminReq)
	if err != nil {
		t.Fatal(err)
	}
	defer adminResponse.Body.Close()
	if adminResponse.StatusCode != 404 {
		t.Fatalf("other admin status=%d", adminResponse.StatusCode)
	}
}
func readSSE(t *testing.T, r *bufio.Reader) string {
	t.Helper()
	var b strings.Builder
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		b.WriteString(line)
		if line == "\n" {
			return b.String()
		}
	}
}

func cancelViaAPI(t *testing.T, baseURL, id string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, baseURL+"/v1/generation/tasks/"+id+"/cancel", nil)
	req.Header.Set("Authorization", "Bearer valid")
	req.Header.Set("Accept", "text/event-stream")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("cancel status=%d", response.StatusCode)
	}
}
