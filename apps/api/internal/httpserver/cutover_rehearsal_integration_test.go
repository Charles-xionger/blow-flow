//go:build integration

package httpserver

import (
	"blow-flow/api/internal/account"
	accountpostgres "blow-flow/api/internal/account/postgres"
	agentpostgres "blow-flow/api/internal/agent/postgres"
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/generation"
	generationpostgres "blow-flow/api/internal/generation/postgres"
	"blow-flow/api/internal/identity/creatorauth"
	"blow-flow/api/internal/identity/session"
	"blow-flow/api/internal/resource"
	resourcepostgres "blow-flow/api/internal/resource/postgres"
	"blow-flow/api/internal/script"
	scriptpostgres "blow-flow/api/internal/script/postgres"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

type rehearsalScriptModels struct{}

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

	command := map[string]any{"requestId": "rehearsal-agent-send", "action": "send", "modelId": "gemini", "text": "Sketch a scene and prepare image and video", "canvasVersion": 2}
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

	claimed := call(owned, "POST", "/internal/agent/tasks/"+agentTask["id"].(string)+"/claim", nil, map[string]string{"Authorization": string(runnerKey)}, 200)
	runToken, _ := claimed["token"].(string)
	if runToken == "" {
		t.Fatalf("agent run token missing: %v", claimed)
	}
	runHeaders := map[string]string{"Authorization": runToken}
	canvas := map[string]any{"name": "Go rehearsal", "nodes": []any{
		map[string]any{"id": "rehearsal-image", "type": "image", "position": map[string]any{"x": 0, "y": 0}, "data": map[string]any{"type": "textToImage", "prompt": "A paper city"}},
		map[string]any{"id": "rehearsal-video", "type": "video", "position": map[string]any{"x": 500, "y": 0}, "data": map[string]any{"type": "textToVideo", "prompt": "A moving paper city"}},
		map[string]any{"id": "rehearsal-script", "type": "script", "position": map[string]any{"x": 1000, "y": 0}, "data": map[string]any{"type": "script", "prompt": []any{map[string]any{"text": "Write a scene"}}}},
	}, "edges": []any{}, "viewport": map[string]any{"x": 0, "y": 0, "zoom": 1}}
	operations := []any{
		map[string]any{"kind": "create", "node": canvas["nodes"].([]any)[0]},
		map[string]any{"kind": "create", "node": canvas["nodes"].([]any)[1]},
		map[string]any{"kind": "create", "node": canvas["nodes"].([]any)[2]},
	}
	tool := map[string]any{"callId": "rehearsal-create-nodes", "label": "Create rehearsal nodes", "baseVersion": 2, "operations": operations, "snapshot": canvas}
	ack := call(owned, "PUT", "/internal/agent/run/canvas", tool, runHeaders, 200)
	if ack["version"] != float64(3) {
		t.Fatalf("agent canvas operation missing: %v", ack)
	}
	call(owned, "PUT", "/internal/agent/run/canvas", tool, runHeaders, 200)
	projectView := call(owned, "GET", "/v1/projects/"+projectID, nil, nil, 200)
	if projectView["version"] != float64(3) {
		t.Fatalf("agent canvas edit not viewable: %v", projectView)
	}
	call(owned, "POST", "/internal/agent/run/steps/start", map[string]any{"callId": "rehearsal-generate", "name": "prepare_generation", "arguments": map[string]any{}}, runHeaders, 200)
	batch := call(owned, "POST", "/internal/agent/run/generation/prepare", map[string]any{"callId": "rehearsal-generate", "items": []any{
		map[string]any{"nodeId": "rehearsal-image", "modelId": "runninghub/krea2", "input": map[string]any{"prompt": "A paper city", "width": 1024, "height": 1024}},
		map[string]any{"nodeId": "rehearsal-video", "modelId": "runninghub/h3", "input": map[string]any{"prompt": "A moving paper city", "width": 1280, "height": 736, "duration": 7}},
	}}, runHeaders, 200)
	if batch["status"] != "pending" {
		t.Fatalf("generation was not held for confirmation: %v", batch)
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
	resumed := call(owned, "POST", "/internal/agent/tasks/"+agentTask["id"].(string)+"/claim", nil, map[string]string{"Authorization": string(runnerKey)}, 200)
	runHeaders["Authorization"] = resumed["token"].(string)
	approved := call(owned, "GET", "/internal/agent/run/generation/batches/"+batch["id"].(string), nil, runHeaders, 200)
	tasks := approved["tasks"].([]any)
	if len(tasks) != 2 || approved["status"] != "approved" {
		t.Fatalf("confirmed batch did not create image and video: %v", approved)
	}

	for i, raw := range tasks {
		item := raw.(map[string]any)
		id := item["id"].(string)
		kind, extension := "image", "png"
		if i == 1 {
			kind, extension = "video", "mp4"
		}
		claim, ok, err := generationStore.ClaimSubmission(context.Background(), id)
		if err != nil || !ok {
			t.Fatalf("fake %s submission claim: %v %v", kind, ok, err)
		}
		if err := generationStore.ResolveSubmission(context.Background(), id, claim.Token, "fake-"+kind+"-"+runID, nil); err != nil {
			t.Fatal(err)
		}
		delivery, ok, err := generationStore.ClaimDelivery(context.Background(), id)
		if err != nil || !ok {
			t.Fatalf("fake %s provider claim: %v %v", kind, ok, err)
		}
		if err := generationStore.ProviderSucceeded(context.Background(), delivery, "https://fake-provider.test/"+kind+"."+extension, extension); err != nil {
			t.Fatal(err)
		}
		delivery, ok, err = generationStore.ClaimDelivery(context.Background(), id)
		if err != nil || !ok {
			t.Fatalf("%s result save claim: %v %v", kind, ok, err)
		}
		resultURL := "https://assets.rehearsal.test/" + runID + "/" + kind + "." + extension
		if err := generationStore.Delivered(context.Background(), delivery, resultURL); err != nil {
			t.Fatal(err)
		}
		final := call(makeRouter(owner), "GET", "/v1/generation/tasks/"+id, nil, nil, 200)
		if final["status"] != "completed" || final["resultUrl"] != resultURL {
			t.Fatalf("%s result unavailable after restart: %v", kind, final)
		}
		call(other, "GET", "/v1/generation/tasks/"+id, nil, nil, 404)
	}
	approved = call(owned, "GET", "/internal/agent/run/generation/batches/"+batch["id"].(string), nil, runHeaders, 200)
	for _, raw := range approved["tasks"].([]any) {
		if raw.(map[string]any)["status"] != "completed" {
			t.Fatalf("agent result did not reach completed: %v", approved)
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
