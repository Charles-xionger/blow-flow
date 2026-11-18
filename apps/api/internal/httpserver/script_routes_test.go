package httpserver

import (
	"blow-flow/api/internal/account"
	"blow-flow/api/internal/script"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type scriptModelsStub struct{}

func (scriptModelsStub) Validate(string, bool) error { return nil }

type scriptRepositoryStub struct {
	owner string
	input script.Create
}

func (s *scriptRepositoryStub) LookupRequest(context.Context, string, script.Create) (script.Task, bool, error) {
	return script.Task{}, false, nil
}

func (s *scriptRepositoryStub) Create(_ context.Context, owner string, input script.Create) (script.Task, error) {
	s.owner = owner
	s.input = input
	return script.Task{ID: "task-1", RequestID: input.RequestID, CanvasID: input.CanvasID, NodeID: input.NodeID, Input: input.Input, Status: "queued", Revision: 1}, nil
}
func (s *scriptRepositoryStub) Get(_ context.Context, owner, id string) (script.Task, error) {
	if owner != s.owner || id != "task-1" {
		return script.Task{}, script.ErrNotFound
	}
	return script.Task{ID: id, Status: "queued", Revision: 1}, nil
}
func (s *scriptRepositoryStub) List(_ context.Context, owner, project, node string) ([]script.Task, error) {
	if owner != s.owner {
		return []script.Task{}, nil
	}
	return []script.Task{{ID: "task-1", CanvasID: project, NodeID: node}}, nil
}
func (s *scriptRepositoryStub) Stop(ctx context.Context, owner, id string) (script.Task, error) {
	return s.Get(ctx, owner, id)
}
func TestScriptRouteAcceptsLargeInputAndScopesOwner(t *testing.T) {
	repo := &scriptRepositoryStub{}
	router := NewWithDependencies(Dependencies{Accounts: &accountServiceStub{resolved: account.User{ID: "creator-1", Role: account.RoleUser, Status: account.StatusActive}}, IdentityVerifier: verifierStub{}, Scripts: &script.Service{Repository: repo, Models: scriptModelsStub{}}})
	input := script.Create{RequestID: "req", CanvasID: "project", NodeID: "script-node", Input: script.Input{Model: "model", Requirements: strings.Repeat("文", 20_000), Preset: "free"}}
	body, _ := json.Marshal(input)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/script/tasks", strings.NewReader(string(body)))
	req.Header.Set("Authorization", "Bearer valid")
	req.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(w, req)
	if w.Code != http.StatusAccepted || repo.owner != "creator-1" || len(repo.input.Input.Requirements) != len(input.Input.Requirements) {
		t.Fatalf("status=%d owner=%q length=%d", w.Code, repo.owner, len(repo.input.Input.Requirements))
	}
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/v1/script/tasks/task-1", nil)
	req.Header.Set("Authorization", "Bearer valid")
	router.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("get status %d", w.Code)
	}
}
