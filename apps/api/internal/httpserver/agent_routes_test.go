package httpserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"blow-flow/api/internal/account"
	"blow-flow/api/internal/agent"
)

type agentCommandsStub struct {
	owner, project string
	called         int
}

func (s *agentCommandsStub) Snapshot(_ context.Context, owner, project string) (agent.Snapshot, error) {
	s.owner, s.project = owner, project
	return agent.Snapshot{Tasks: []agent.Task{}, Messages: []agent.Message{}}, nil
}
func (s *agentCommandsStub) Command(_ context.Context, owner, project string, input agent.Command) (agent.Task, error) {
	s.owner, s.project = owner, project
	s.called++
	return agent.Task{ID: "agent-task", ProjectID: project, ModelID: input.ModelID, Status: "queued"}, nil
}
func TestAgentCommandsRequireAuthenticatedOwner(t *testing.T) {
	s := &agentCommandsStub{}
	r := NewWithDependencies(Dependencies{Accounts: &accountServiceStub{resolved: account.User{ID: "owner-1", Status: account.StatusActive}}, IdentityVerifier: verifierStub{}, AgentCommands: s})
	call := func(method, path, token, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		r.ServeHTTP(w, req)
		return w
	}
	if got := call(http.MethodPost, "/v1/agent/projects/project-a/commands", "", `{"requestId":"r","action":"send"}`); got.Code != 401 || s.called != 0 {
		t.Fatalf("anonymous: %d", got.Code)
	}
	if got := call(http.MethodGet, "/v1/agent/projects/project-a", "valid", ""); got.Code != 200 || s.owner != "owner-1" || s.project != "project-a" {
		t.Fatalf("snapshot: %d %s", got.Code, got.Body.String())
	}
	if got := call(http.MethodPost, "/v1/agent/projects/project-a/commands", "valid", `{"requestId":"r","action":"send","modelId":"gemini","text":"hello","canvasVersion":1}`); got.Code != 200 || s.called != 1 {
		t.Fatalf("command: %d %s", got.Code, got.Body.String())
	}
}
