package httpserver

import (
	"blow-flow/api/internal/account"
	"blow-flow/api/internal/generation"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type generationStub struct {
	created int
	last    generation.Task
}

func (s *generationStub) Create(_ context.Context, _ generation.Actor, _ string, _ generation.Input) (generation.Task, error) {
	s.created++
	return s.last, nil
}
func (s *generationStub) Get(_ context.Context, _ generation.Actor, _ string) (generation.Task, error) {
	return s.last, nil
}
func (s *generationStub) Cancel(_ context.Context, _ generation.Actor, _ string) (generation.Task, error) {
	return s.last, nil
}
func TestGenerationCreateRequiresAuthenticatedOwnerAndReturnsTaskID(t *testing.T) {
	s := &generationStub{last: generation.Task{ID: "task-1", Status: generation.Queued}}
	r := NewWithDependencies(Dependencies{Accounts: &accountServiceStub{resolved: account.User{ID: "owner-1", Status: account.StatusActive}}, IdentityVerifier: verifierStub{}, Generation: s})
	body := `{"projectId":"project-1","model":"runninghub/krea2","prompt":"A cat","width":1024,"height":1024}`
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/generation/tasks", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "key-1")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized || s.created != 0 {
		t.Fatalf("unauthenticated: %d %d", w.Code, s.created)
	}
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/v1/generation/tasks", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer valid")
	req.Header.Set("Idempotency-Key", "key-1")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusAccepted || !strings.Contains(w.Body.String(), `"id":"task-1"`) || s.created != 1 {
		t.Fatalf("created: %d %s count=%d", w.Code, w.Body.String(), s.created)
	}
}

func TestGenerationQueryAndCancelExposeOnlyPublicTask(t *testing.T) {
	s := &generationStub{last: generation.Task{ID: "task-1", Status: generation.Queued, Model: "runninghub/krea2", ProjectID: "project-1"}}
	r := NewWithDependencies(Dependencies{Accounts: &accountServiceStub{resolved: account.User{ID: "owner-1", Status: account.StatusActive}}, IdentityVerifier: verifierStub{}, Generation: s})
	for _, tc := range []struct{ method, path string }{{http.MethodGet, "/v1/generation/tasks/task-1"}, {http.MethodPost, "/v1/generation/tasks/task-1/cancel"}} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(tc.method, tc.path, nil)
		req.Header.Set("Authorization", "Bearer valid")
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"id":"task-1"`) || strings.Contains(w.Body.String(), "prompt") || strings.Contains(w.Body.String(), "secret") {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, w.Code, w.Body.String())
		}
	}
}

func (s *generationStub) Events(_ context.Context, _ generation.Actor, _ string, after int64) ([]generation.Event, error) {
	if after >= 8 {
		return []generation.Event{}, nil
	}
	return []generation.Event{{ID: 8, Type: "provider_succeeded"}}, nil
}
func (s *generationStub) Resume(_ context.Context, _ generation.Actor, _ string) (generation.Task, error) {
	return s.last, nil
}
func TestGenerationEventsAndTaskExposeStageWithoutUnverifiedPercent(t *testing.T) {
	s := &generationStub{last: generation.Task{ID: "task-1", Status: generation.Running, Stage: "generating"}}
	r := NewWithDependencies(Dependencies{Accounts: &accountServiceStub{resolved: account.User{ID: "owner-1", Status: account.StatusActive}}, IdentityVerifier: verifierStub{}, Generation: s})
	for _, path := range []string{"/v1/generation/tasks/task-1", "/v1/generation/tasks/task-1/events?after=0"} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer valid")
		r.ServeHTTP(w, req)
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"stage":"generating"`) || strings.Contains(w.Body.String(), `"percent"`) {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/v1/generation/tasks/task-1/events?after=8", nil)
	req.Header.Set("Authorization", "Bearer valid")
	r.ServeHTTP(w, req)
	if w.Code != 200 || strings.Contains(w.Body.String(), "provider_succeeded") {
		t.Fatalf("cursor: %s", w.Body.String())
	}
}
