package httpserver

import (
	"blow-flow/api/internal/account"
	"blow-flow/api/internal/generation"
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGenerationSSEStartsWithAuthorizedSnapshot(t *testing.T) {
	s := &generationStub{last: generation.Task{ID: "task-1", Status: generation.Running, Stage: "generating", Version: 7}}
	r := NewWithDependencies(Dependencies{Accounts: &accountServiceStub{resolved: account.User{ID: "owner-1", Status: account.StatusActive}}, IdentityVerifier: verifierStub{}, Generation: s})
	server := httptest.NewServer(r)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/v1/generation/tasks/task-1/events", nil)
	req.Header.Set("Authorization", "Bearer valid")
	req.Header.Set("Accept", "text/event-stream")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("status=%d content-type=%s", response.StatusCode, response.Header.Get("Content-Type"))
	}
	line, err := bufio.NewReader(response.Body).ReadString('\n')
	if err != nil || line != "id: 7\n" {
		t.Fatalf("first SSE line=%q err=%v", line, err)
	}
}

func TestGenerationSSEClosesOnServerShutdown(t *testing.T) {
	s := &generationStub{last: generation.Task{ID: "task-1", Status: generation.Running, Version: 1}}
	stop := make(chan struct{})
	r := NewWithDependencies(Dependencies{Accounts: &accountServiceStub{resolved: account.User{ID: "owner-1", Status: account.StatusActive}}, IdentityVerifier: verifierStub{}, Generation: s, GenerationStreamClose: stop})
	server := httptest.NewServer(r)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/v1/generation/tasks/task-1/events", nil)
	req.Header.Set("Authorization", "Bearer valid")
	req.Header.Set("Accept", "text/event-stream")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line == "\n" {
			break
		}
	}
	close(stop)
	_, err = reader.ReadString('\n')
	if err == nil {
		t.Fatal("stream remained open after shutdown")
	}
}
