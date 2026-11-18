package textmodel

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestArkStreamRequiresCompletedEventAndDoesNotExposeKey(t *testing.T) {
	complete := true
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/responses" || r.Header.Get("Authorization") != "Bearer secret" {
			t.Errorf("unexpected request %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n"))
		if complete {
			_, _ = w.Write([]byte("data: {\"type\":\"response.completed\"}\n\n"))
		}
	}))
	defer server.Close()
	c := Client{HTTP: server.Client(), ArkKey: "secret", ArkURL: server.URL}
	var output string
	err := c.Stream(context.Background(), Request{Model: "deepseek-v4-pro-ga-260813", Prompt: "write"}, func(delta string) error { output += delta; return nil })
	if err != nil || output != "hello" {
		t.Fatalf("complete %q %v", output, err)
	}
	complete = false
	output = ""
	err = c.Stream(context.Background(), Request{Model: "deepseek-v4-pro-ga-260813", Prompt: "write"}, func(delta string) error { output += delta; return nil })
	if !errors.Is(err, ErrIncomplete) || output != "hello" || strings.Contains(err.Error(), "secret") {
		t.Fatalf("incomplete %q %v", output, err)
	}
}
func TestGeminiStreamAndModelValidation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/models/gemini-3.8-flash:streamGenerateContent" || r.URL.Query().Get("alt") != "sse" || r.Header.Get("x-goog-api-key") != "secret" {
			t.Errorf("unexpected request %s", r.URL.String())
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hi\"}]}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"!\"}]},\"finishReason\":\"STOP\"}]}\n\n"))
	}))
	defer server.Close()
	c := Client{HTTP: server.Client(), GeminiKey: "secret", GeminiURL: server.URL}
	var output string
	err := c.Stream(context.Background(), Request{Model: "gemini-3.8-flash", Prompt: "write"}, func(delta string) error { output += delta; return nil })
	if err != nil || output != "Hi!" {
		t.Fatalf("gemini %q %v", output, err)
	}
	if c.Validate("unknown", false) == nil || c.Validate("deepseek-v4-pro-ga-260813", true) == nil {
		t.Fatal("invalid model accepted")
	}
}
