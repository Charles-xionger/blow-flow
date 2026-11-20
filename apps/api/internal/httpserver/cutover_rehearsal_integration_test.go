//go:build integration

package httpserver

import (
	"blow-flow/api/internal/account"
	accountpostgres "blow-flow/api/internal/account/postgres"
	agentpostgres "blow-flow/api/internal/agent/postgres"
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/generation"
	generationpostgres "blow-flow/api/internal/generation/postgres"
	"blow-flow/api/internal/generation/queue"
	"blow-flow/api/internal/identity/creatorauth"
	"blow-flow/api/internal/identity/session"
	"blow-flow/api/internal/resource"
	resourcepostgres "blow-flow/api/internal/resource/postgres"
	"blow-flow/api/internal/script"
	scriptpostgres "blow-flow/api/internal/script/postgres"
	"blow-flow/api/internal/skill"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type rehearsalScriptModels struct{}

type rehearsalArtifacts struct{ runID string }

func (a rehearsalArtifacts) Save(_ context.Context, source, _, fileType string) (string, error) {
	if !strings.HasPrefix(source, "https://fake-provider.test/") {
		return "", generation.ErrInvalid
	}
	kind := "image"
	if fileType == "mp4" {
		kind = "video"
	}
	return "https://assets.rehearsal.test/" + a.runID + "/" + kind + "." + fileType, nil
}

func (rehearsalScriptModels) Validate(string, bool) error { return nil }

// TestImportedCutoverAPIJourney is invoked only by the guarded rehearsal script.
// It exercises the imported owner and leaves Go-only writes for its delta manifest.
func TestImportedCutoverAPIJourney(t *testing.T) {
	runID := strings.TrimPrefix(os.Getenv("COMPOSE_PROJECT_NAME"), "rehearsal_")
	if len(runID) != 12 || len(os.Getenv("COMPOSE_PROJECT_NAME")) != len("rehearsal_")+12 || strings.Trim(runID, "0123456789abcdef") != "" {
		t.Fatal("rehearsal Compose project required")
	}
	owner, filename := os.Getenv("REHEARSAL_OWNER_ID"), os.Getenv("REHEARSAL_EXPORT_FILE")
	email, password := os.Getenv("REHEARSAL_CREATOR_EMAIL"), os.Getenv("REHEARSAL_CREATOR_PASSWORD")
	if owner == "" || filename == "" || email == "" || password == "" || os.Getenv("TEST_DATABASE_URL") == "" {
		t.Fatal("rehearsal owner, export, creator credentials and database required")
	}
	// Model availability is checked when the confirmation is prepared. These
	// disposable values never reach a provider: the test drives store transitions.
	t.Setenv("RUNNINGHUB_API_KEY", "rehearsal-fake-key")
	t.Setenv("RUNNINGHUB_BASE_URL", "https://fake-provider.test")
	content, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	var exported struct {
		Projects []struct {
			ID string `json:"id"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(content, &exported); err != nil || len(exported.Projects) == 0 {
		t.Fatalf("fixture project missing: %v", err)
	}
	db, pool, err := database.Open(os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	resources := &resource.Service{Repository: resourcepostgres.New(db)}
	agents := agentpostgres.New(db)
	generationStore := generationpostgres.New(db)
	scriptStore := scriptpostgres.New(db)
	key := []byte("rehearsal-disposable-signing-key-32-bytes")
	auth, err := creatorauth.New(db, key, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	accounts := account.NewService(accountpostgres.New(db, time.Now), account.InitialAdministrator{}, time.Now)
	runnerKey := []byte("rehearsal-runner-key-32-bytes-long")
	makeRouter := func(id string) http.Handler {
		accountService := AccountService(accounts)
		verifier := IdentityVerifier(auth)
		if id != owner {
			accountService = &accountServiceStub{resolved: account.User{ID: id, Status: account.StatusActive}}
			verifier = verifierStub{}
		}
		return NewWithDependencies(Dependencies{
			Accounts: accountService, IdentityVerifier: verifier, CreatorAuth: auth,
			Captcha: &captchaStub{}, RefreshSessions: &session.Store{DB: db, Now: time.Now, Key: key},
			Resources: resources, AgentCommands: agents, AgentRuns: agents, AgentRunnerKey: runnerKey,
			Skills:     skill.New(db),
			Generation: generation.Service{Store: generationStore, Resources: generationpostgres.Resources{DB: db}},
			Scripts:    &script.Service{Repository: scriptStore, Models: rehearsalScriptModels{}},
		})
	}
	owned := makeRouter(owner)
	loginBody, _ := json.Marshal(map[string]string{"email": email, "password": password, "captchaId": "challenge-1", "captchaAnswer": "1234"})
	loginRequest := httptest.NewRequest("POST", "/v1/auth/user/login", bytes.NewReader(loginBody))
	loginRequest.Header.Set("Content-Type", "application/json")
	loginResponse := httptest.NewRecorder()
	owned.ServeHTTP(loginResponse, loginRequest)
	if loginResponse.Code != 200 {
		t.Fatalf("imported creator login: status=%d body=%s", loginResponse.Code, loginResponse.Body.String())
	}
	var login struct {
		AccessToken string       `json:"accessToken"`
		User        account.User `json:"user"`
	}
	if err := json.Unmarshal(loginResponse.Body.Bytes(), &login); err != nil || login.User.ID != owner || login.AccessToken == "" {
		t.Fatalf("creator login owner mismatch: user=%+v err=%v", login.User, err)
	}
	ownerToken := login.AccessToken
	call := func(router http.Handler, method, path string, body any, headers map[string]string, want int) map[string]any {
		t.Helper()
		var input []byte
		if body != nil {
			input, _ = json.Marshal(body)
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(input))
		token := ownerToken
		if override := headers["Authorization"]; override != "" {
			token = override
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		for k, v := range headers {
			if k == "Authorization" {
				continue
			}
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("%s %s: status=%d body=%s", method, path, rec.Code, rec.Body.String())
		}
		var result map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &result)
		return result
	}
	other := makeRouter("00000000-0000-4000-8000-000000000099")
	importedID := exported.Projects[0].ID
	call(owned, "GET", "/v1/workspace", nil, nil, 200)
	call(owned, "GET", "/v1/projects/"+importedID, nil, nil, 200)
	call(other, "GET", "/v1/projects/"+importedID, nil, nil, 404)
	call(other, "GET", "/v1/agent/projects/"+importedID, nil, nil, 404)
	media := call(owned, "GET", "/v1/assets/fixture-media-oss", nil, nil, 200)
	if media["id"] != "fixture-media-oss" || media["url"] != os.Getenv("REHEARSAL_MEDIA_URL") {
		t.Fatalf("imported external media not accessible to owner: %v", media)
	}
	call(other, "GET", "/v1/assets/fixture-media-oss", nil, nil, 404)

	projectID := "go-rehearsal-" + runID
	project := call(owned, "POST", "/v1/projects", map[string]any{"id": projectID, "name": "Go rehearsal"}, nil, 201)
	if project["version"] != float64(1) {
		t.Fatalf("new project version: %v", project)
	}
	snapshot := map[string]any{"name": "Go rehearsal", "nodes": []any{}, "edges": []any{}, "viewport": map[string]any{"x": 0, "y": 0, "zoom": 1}}
	save := map[string]any{"requestId": "rehearsal-save", "baseVersion": 1, "snapshot": snapshot}
	receipt := call(owned, "PUT", "/v1/projects/"+projectID+"/canvas", save, nil, 200)
	replayed := call(owned, "PUT", "/v1/projects/"+projectID+"/canvas", save, nil, 200)
	if receipt["version"] != float64(2) || replayed["version"] != float64(2) {
		t.Fatalf("save replay changed version: %v %v", receipt, replayed)
	}
	// Rebuild the router to model a restarted API with no process-local state.
	owned = makeRouter(owner)
	view := call(owned, "GET", "/v1/projects/"+projectID, nil, nil, 200)
	if view["version"] != float64(2) {
		t.Fatalf("canvas not visible after restart: %v", view)
	}
	call(other, "GET", "/v1/projects/"+projectID, nil, nil, 404)

	command := map[string]any{"requestId": "rehearsal-agent-send", "action": "send", "modelId": "gemini-flash", "text": "Sketch a scene and prepare image and video", "canvasVersion": 2}
	agentTask := call(owned, "POST", "/v1/agent/projects/"+projectID+"/commands", command, nil, 200)
	agentReplay := call(owned, "POST", "/v1/agent/projects/"+projectID+"/commands", command, nil, 200)
	if agentTask["id"] == nil || agentReplay["id"] != agentTask["id"] {
		t.Fatalf("agent replay created duplicate task: %v %v", agentTask, agentReplay)
	}
	state := call(owned, "GET", "/v1/agent/projects/"+projectID, nil, nil, 200)
	if len(state["messages"].([]any)) == 0 {
		t.Fatal("agent message not persisted")
	}
	call(other, "GET", "/v1/agent/projects/"+projectID, nil, nil, 404)

	server := httptest.NewServer(owned)
	defer server.Close()
	runNode := func(phase, batchID string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, "pnpm", "exec", "tsx", "tests/fixtures/go-cutover-runner.ts", agentTask["id"].(string), phase, batchID)
		cmd.Dir = "../../../web"
		cmd.Env = append(os.Environ(), "REHEARSAL_GO_URL="+server.URL, "AGENT_RUNNER_KEY="+string(runnerKey), "GEMINI_API_KEY=rehearsal-fake-model-key", "RUNNINGHUB_API_KEY=rehearsal-fake-key", "RUNNINGHUB_BASE_URL=https://fake-provider.test")
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("Node Pi Runner %s: %v\n%s", phase, err, output)
		}
	}
	runNode("prepare", "")
	projectView := call(owned, "GET", "/v1/projects/"+projectID, nil, nil, 200)
	if projectView["version"] != float64(3) {
		var steps string
		_ = db.Raw(`SELECT coalesce(json_agg(t),'[]'::json)::text FROM (SELECT name,status,result FROM agent_tool_steps WHERE task_id=? ORDER BY created_at) t`, agentTask["id"]).Scan(&steps).Error
		t.Fatalf("Node Runner canvas edit not visible: %v steps=%s", projectView, steps)
	}
	var batchID string
	if err := db.Raw(`SELECT id FROM agent_generation_batches WHERE task_id=?`, agentTask["id"]).Scan(&batchID).Error; err != nil || batchID == "" {
		t.Fatalf("Node Runner generation batch: %q %v", batchID, err)
	}
	var beforeApproval int64
	if err := db.Raw(`SELECT count(*) FROM generation_tasks WHERE owner_id=? AND project_id=?`, owner, projectID).Scan(&beforeApproval).Error; err != nil || beforeApproval != 0 {
		t.Fatalf("generation submitted before confirmation: %d %v", beforeApproval, err)
	}
	state = call(owned, "GET", "/v1/agent/projects/"+projectID, nil, nil, 200)
	questions := state["tasks"].([]any)[0].(map[string]any)["question"].(map[string]any)
	if questions["id"] != "rehearsal-generate" {
		t.Fatalf("confirmation not visible to creator: %v", questions)
	}
	approval := map[string]any{"requestId": "rehearsal-approve", "action": "answer", "questionId": "rehearsal-generate", "text": "确认生成"}
	call(owned, "POST", "/v1/agent/projects/"+projectID+"/commands", approval, nil, 200)
	call(owned, "POST", "/v1/agent/projects/"+projectID+"/commands", approval, nil, 200)
	var taskIDsJSON string
	if err := db.Raw(`SELECT generation_task_ids::text FROM agent_generation_batches WHERE id=?`, batchID).Scan(&taskIDsJSON).Error; err != nil {
		t.Fatal(err)
	}
	var taskIDs []string
	if err := json.Unmarshal([]byte(taskIDsJSON), &taskIDs); err != nil || len(taskIDs) != 2 {
		t.Fatalf("approved task IDs: %s %v", taskIDsJSON, err)
	}
	var submissions atomic.Int64
	queryCount := map[string]int{}
	var queryMu sync.Mutex
	var provider *httptest.Server
	provider = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/task/openapi/create":
			submissions.Add(1)
			var request struct {
				WorkflowID string `json:"workflowId"`
			}
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
				return
			}
			id := 123
			if request.WorkflowID == "2116745173157138433" {
				id = 124
			}
			_, _ = fmt.Fprintf(w, `{"code":0,"data":{"taskId":%d}}`, id)
		case "/task/openapi/outputs":
			var request struct {
				TaskID string `json:"taskId"`
			}
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
				return
			}
			queryMu.Lock()
			queryCount[request.TaskID]++
			n := queryCount[request.TaskID]
			queryMu.Unlock()
			if n == 1 {
				_, _ = fmt.Fprintf(w, `{"code":0,"data":{"netWssUrl":"%s/ws","taskStatus":"RUNNING"}}`, strings.Replace(provider.URL, "http://", "ws://", 1))
				return
			}
			kind, node, extension := "image", "103", "png"
			if request.TaskID == "124" {
				kind, node, extension = "video", "148", "mp4"
			}
			_, _ = fmt.Fprintf(w, `{"code":0,"data":[{"fileUrl":"https://fake-provider.test/%s.%s","fileType":"%s","nodeId":"%s"}]}`, kind, extension, extension, node)
		case "/ws":
			upgrader := websocket.Upgrader{}
			connection, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				t.Error(err)
				return
			}
			defer connection.Close()
			_ = connection.WriteJSON(map[string]any{"type": "progress", "data": map[string]any{"value": 1, "max": 2}})
			_ = connection.WriteJSON(map[string]any{"type": "execution_success"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer provider.Close()
	providers := queue.Providers{RunningHub: queue.Krea2{BaseURL: provider.URL, APIKey: "rehearsal-fake-key", Client: provider.Client()}}
	worker := queue.SubmissionWorker{Store: generationStore, Provider: providers}
	deliveryWorker := queue.DeliveryWorker{Store: generationStore, Provider: providers, Artifacts: rehearsalArtifacts{runID}}
	for i, id := range taskIDs {
		kind, extension := "image", "png"
		if i == 1 {
			kind, extension = "video", "mp4"
		}
		if err := worker.ProcessOne(context.Background(), id); err != nil {
			t.Fatalf("%s worker submit: %v", kind, err)
		}
		if err := deliveryWorker.ProcessOne(context.Background(), id); err != nil {
			t.Fatalf("%s worker query/progress: %v", kind, err)
		}
		if err := deliveryWorker.ProcessOne(context.Background(), id); err != nil {
			t.Fatalf("%s worker save: %v", kind, err)
		}
		resultURL := "https://assets.rehearsal.test/" + runID + "/" + kind + "." + extension
		final := call(makeRouter(owner), "GET", "/v1/generation/tasks/"+id, nil, nil, 200)
		if final["status"] != "completed" || final["resultUrl"] != resultURL {
			t.Fatalf("%s result unavailable after worker: %v", kind, final)
		}
		call(other, "GET", "/v1/generation/tasks/"+id, nil, nil, 404)
		if err := worker.ProcessOne(context.Background(), id); err != nil {
			t.Fatalf("%s duplicate wakeup: %v", kind, err)
		}
	}
	if submissions.Load() != 2 {
		t.Fatalf("duplicate paid submissions: %d", submissions.Load())
	}
	runNode("finish", batchID)
	state = call(owned, "GET", "/v1/agent/projects/"+projectID, nil, nil, 200)
	if state["tasks"].([]any)[0].(map[string]any)["status"] != "completed" {
		t.Fatalf("Node Pi Runner did not complete resumed task: %v", state["tasks"])
	}
	for _, id := range taskIDs {
		final := call(owned, "GET", "/v1/generation/tasks/"+id, nil, nil, 200)
		if final["status"] != "completed" {
			t.Fatalf("Runner finished before delivery: %v", final)
		}
		var progressEvents int64
		if err := db.Raw(`SELECT count(*) FROM generation_task_events WHERE task_id=? AND event_type='progress'`, id).Scan(&progressEvents).Error; err != nil || progressEvents == 0 {
			t.Fatalf("worker progress missing for %s: %d %v", id, progressEvents, err)
		}
	}
	scriptInput := script.Create{RequestID: "rehearsal-script", CanvasID: projectID, NodeID: "rehearsal-script", Input: script.Input{Model: "fake-script-model", Requirements: "Write a scene", Preset: "free"}}
	scriptTask := call(owned, "POST", "/v1/script/tasks", scriptInput, nil, 202)
	scriptID, _ := scriptTask["id"].(string)
	if scriptID == "" {
		t.Fatalf("script task missing: %v", scriptTask)
	}
	claimedScript, err := scriptStore.Claim(context.Background(), scriptID, time.Minute)
	if err != nil || claimedScript == nil {
		t.Fatalf("fake script claim: %v %v", claimedScript, err)
	}
	if ok, err := scriptStore.Append(context.Background(), scriptID, claimedScript.Lease, "The paper city wakes at dawn."); err != nil || !ok {
		t.Fatalf("fake script content: %v %v", ok, err)
	}
	if err := scriptStore.Finish(context.Background(), scriptID, claimedScript.Lease, "completed", ""); err != nil {
		t.Fatal(err)
	}
	scriptFinal := call(makeRouter(owner), "GET", "/v1/script/tasks/"+scriptID, nil, nil, 200)
	if scriptFinal["status"] != "completed" || scriptFinal["outputSaved"] != true || scriptFinal["text"] != "The paper city wakes at dawn." {
		t.Fatalf("script result unavailable after restart: %v", scriptFinal)
	}
	call(other, "GET", "/v1/script/tasks/"+scriptID, nil, nil, 404)
	view = call(owned, "GET", "/v1/projects/"+projectID, nil, nil, 200)
	encodedView, _ := json.Marshal(view)
	for _, expected := range []string{"The paper city wakes at dawn.", "assets.rehearsal.test/" + runID + "/image.png", "assets.rehearsal.test/" + runID + "/video.mp4"} {
		if !bytes.Contains(encodedView, []byte(expected)) {
			t.Fatalf("saved project missing %q: %s", expected, encodedView)
		}
	}
	var count int64
	if err := db.Raw(`SELECT count(*) FROM generation_tasks WHERE owner_id=? AND project_id=?`, owner, projectID).Scan(&count).Error; err != nil || count != 2 {
		t.Fatalf("single authoritative image and video rows: %d %v", count, err)
	}
	t.Logf("imported project=%s, Go project=%s, agent=%v, image/video=2, script=%s", importedID, projectID, agentTask["id"], scriptID)
}
