package httpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"blow-flow/api/internal/agent"
)

type agentRunsStub struct {
	claimed  bool
	runToken string
}

func (s *agentRunsStub) Claim(_ context.Context, id string) (agent.Run, error) {
	s.claimed = true
	return agent.Run{Task: agent.Task{ID: id, ProjectID: "project-a", Status: "running"}, RunID: "run-id", Token: s.runToken}, nil
}
func (s *agentRunsStub) Heartbeat(_ context.Context, token string) (time.Time, error) {
	if token != s.runToken {
		return time.Time{}, agent.ErrRunExpired
	}
	return time.Now(), nil
}
func (s *agentRunsStub) ReadCanvas(_ context.Context, token string) (agent.Canvas, error) {
	if token != s.runToken {
		return agent.Canvas{}, agent.ErrRunExpired
	}
	return agent.Canvas{Snapshot: json.RawMessage(`{"name":"Canvas","nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`), Version: 1}, nil
}
func (s *agentRunsStub) DeletedNodes(_ context.Context, token string, _ []string) ([]string, error) {
	if token != s.runToken {
		return nil, agent.ErrRunExpired
	}
	return []string{}, nil
}
func (s *agentRunsStub) CanvasReceipt(_ context.Context, token, callID string) (agent.CanvasReceipt, bool, error) {
	if token != s.runToken {
		return agent.CanvasReceipt{}, false, agent.ErrRunExpired
	}
	return agent.CanvasReceipt{Version: 2}, callID == "c", nil
}
func (s *agentRunsStub) CommitCanvas(_ context.Context, token string, _ agent.Commit) (agent.CanvasReceipt, error) {
	if token != s.runToken {
		return agent.CanvasReceipt{}, agent.ErrRunExpired
	}
	return agent.CanvasReceipt{Version: 2}, nil
}
func (s *agentRunsStub) Finish(_ context.Context, token, status string) error {
	if token != s.runToken {
		return agent.ErrRunExpired
	}
	if status != "completed" {
		return agent.ErrInvalid
	}
	return nil
}

func TestInternalAgentRoutesRequireServiceKeyThenScopedRunToken(t *testing.T) {
	serviceKey := []byte(strings.Repeat("s", 32))
	runs := &agentRunsStub{runToken: "run-secret"}
	router := NewWithDependencies(Dependencies{AgentRuns: runs, AgentRunnerKey: serviceKey})
	call := func(method, path, token, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		router.ServeHTTP(w, req)
		return w
	}
	if got := call(http.MethodPost, "/internal/agent/tasks/task-1/claim", "run-secret", ""); got.Code != 401 || runs.claimed {
		t.Fatalf("run token claimed task: %d", got.Code)
	}
	if got := call(http.MethodPost, "/internal/agent/tasks/task-1/claim", string(serviceKey), ""); got.Code != 200 || !runs.claimed {
		t.Fatalf("service claim: %d", got.Code)
	}
	if got := call(http.MethodGet, "/internal/agent/run/canvas", string(serviceKey), ""); got.Code != 401 {
		t.Fatalf("service key read canvas: %d", got.Code)
	}
	if got := call(http.MethodGet, "/internal/agent/run/canvas", runs.runToken, ""); got.Code != 200 || !strings.Contains(got.Body.String(), `"version":1`) {
		t.Fatalf("run read: %d %s", got.Code, got.Body.String())
	}
	if got := call(http.MethodPost, "/internal/agent/run/deleted-nodes/check", string(serviceKey), `{"ids":["a"]}`); got.Code != 401 {
		t.Fatalf("service key checked deleted nodes: %d", got.Code)
	}
	if got := call(http.MethodPost, "/internal/agent/run/deleted-nodes/check", runs.runToken, `{"ids":["a"]}`); got.Code != 200 {
		t.Fatalf("run deleted nodes: %d", got.Code)
	}
	if got := call(http.MethodGet, "/internal/agent/run/canvas/receipt/c", runs.runToken, ""); got.Code != 200 || !strings.Contains(got.Body.String(), `"version":2`) {
		t.Fatalf("run receipt: %d %s", got.Code, got.Body.String())
	}
	if got := call(http.MethodGet, "/internal/agent/run/canvas/receipt/missing", runs.runToken, ""); got.Code != 404 {
		t.Fatalf("missing receipt: %d", got.Code)
	}
	if got := call(http.MethodPut, "/internal/agent/run/canvas", runs.runToken, `{"callId":"c","baseVersion":1,"operations":[],"snapshot":{}}`); got.Code != 200 {
		t.Fatalf("run commit: %d %s", got.Code, got.Body.String())
	}
	if got := call(http.MethodPost, "/internal/agent/run/finish", runs.runToken, `{"status":"completed"}`); got.Code != 204 {
		t.Fatalf("finish: %d", got.Code)
	}
}
