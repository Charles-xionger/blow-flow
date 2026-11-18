package queue

import (
	"blow-flow/api/internal/generation"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestKrea2SubmitMapsConfirmedWorkflow(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/task/openapi/create" || r.Header.Get("Authorization") != "Bearer secret" {
			t.Errorf("request path or auth: %s", r.URL.Path)
		}
		var body struct {
			APIKey     string `json:"apiKey"`
			WorkflowID string `json:"workflowId"`
			Workflow   string `json:"workflow"`
			Nodes      []struct {
				NodeID     string `json:"nodeId"`
				FieldName  string `json:"fieldName"`
				FieldValue any    `json:"fieldValue"`
			} `json:"nodeInfoList"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.APIKey != "secret" || body.WorkflowID != "2109340746494357505" {
			t.Errorf("body IDs: %+v", body)
		}
		var graph map[string]struct {
			Inputs map[string]any `json:"inputs"`
		}
		if err := json.Unmarshal([]byte(body.Workflow), &graph); err != nil {
			t.Error(err)
		}
		if graph["102"].Inputs["prompt"] != "a cat" || graph["10"].Inputs["custom_width"] != float64(1024) || graph["10"].Inputs["custom_height"] != float64(768) || graph["97"].Inputs["seed"] != float64(42) || graph["10"].Inputs["use_custom_resolution"] != true {
			t.Errorf("graph mapping: %+v", graph)
		}
		if len(body.Nodes) != 5 {
			t.Errorf("node overrides: %+v", body.Nodes)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"code":0,"data":{"taskId":"1910246754753896450"}}`))
	}))
	defer server.Close()
	p := Krea2{BaseURL: server.URL, APIKey: "secret", Client: server.Client()}
	id, err := p.Submit(context.Background(), generation.Input{Model: "runninghub/krea2", Prompt: "a cat", Width: 1024, Height: 768, Seed: 42})
	if err != nil || id != "1910246754753896450" || calls != 1 {
		t.Fatalf("submit=%q %v calls=%d", id, err, calls)
	}
}
