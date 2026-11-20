package queue

import (
	"blow-flow/api/internal/generation"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestCustomImageAndVideoUseFrozenWorkflow(t *testing.T) {
	for _, category := range []string{"IMAGE", "VIDEO"} {
		t.Run(category, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != "/task/openapi/create" {
					t.Fatal(r.URL.Path)
				}
				var body struct {
					WorkflowID string         `json:"workflowId"`
					Workflow   string         `json:"workflow"`
					Nodes      []nodeOverride `json:"nodeInfoList"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if body.WorkflowID != "custom-123" {
					t.Fatal(body.WorkflowID)
				}
				var graph map[string]generation.WorkflowNode
				if err := json.Unmarshal([]byte(body.Workflow), &graph); err != nil {
					t.Fatal(err)
				}
				if graph["1"].Inputs["prompt"] != "cat" || graph["1"].Inputs["width"] != float64(1024) {
					t.Fatal(graph)
				}
				if category == "VIDEO" && graph["1"].Inputs["duration"] != float64(7) {
					t.Fatal(graph)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"code":0,"data":{"taskId":1234567890123456789}}`))
			}))
			defer server.Close()
			mapping := map[string]any{}
			inputs := map[string]any{"prompt": "", "width": 0, "height": 0, "seed": 0}
			for _, key := range []string{"prompt", "width", "height", "seed"} {
				mapping[key] = map[string]any{"nodeId": "1", "fieldName": key}
			}
			cap := map[string]any{"prompt": true, "referenceImages": category == "VIDEO", "dimensions": map[string]any{"min": 32, "max": 4096, "step": 32, "defaultWidth": 1024, "defaultHeight": 1024}}
			model := map[string]any{"id": "custom/test", "name": "Custom", "category": category, "adapter": "runninghub-workflow", "version": "1", "connectionId": "custom", "workflowId": "custom-123", "outputNode": "1", "mapping": mapping, "capabilities": cap}
			if category == "VIDEO" {
				inputs["duration"] = 0
				mapping["duration"] = map[string]any{"nodeId": "1", "fieldName": "duration"}
				cap["video"] = map[string]any{"minDuration": 5, "maxDuration": 15, "defaultDuration": 7, "fps": 24, "maxImages": 0, "maxVideos": 0, "maxAudios": 0}
				model["references"] = map[string]any{"nodeId": "1", "imageLoader": "2", "videoLoader": "3", "audioLoader": "4"}
			}
			graph := map[string]any{"1": map[string]any{"inputs": inputs, "class_type": "Output"}}
			for _, id := range []string{"2", "3", "4"} {
				graph[id] = map[string]any{"inputs": map[string]any{}, "class_type": "Loader"}
			}
			model["workflow"] = graph
			config := map[string]any{"connections": []any{map[string]any{"id": "custom", "baseUrl": server.URL, "apiKeyEnv": "CUSTOM_KEY", "concurrency": 2, "requestTimeoutMs": 1000, "pollIntervalMs": 1000, "queryTimeoutMs": 1000, "maxQueryErrors": 3}}, "models": []any{model}}
			b, _ := json.Marshal(config)
			path := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(path, b, 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("GENERATION_CONFIG_PATH", path)
			t.Setenv("CUSTOM_KEY", "secret")
			snapshot, _, err := generation.ResolveModel("custom/test")
			if err != nil {
				t.Fatal(err)
			}
			input := generation.Input{Model: "custom/test", Prompt: "cat", Width: 1024, Height: 1024, Seed: 42, Workflow: snapshot}
			if category == "VIDEO" {
				input.Duration = 7
			}
			if err := os.WriteFile(path, []byte(`{"connections":[],"models":[]}`), 0600); err != nil {
				t.Fatal(err)
			}
			id, err := (Providers{RunningHub: Krea2{Client: server.Client()}}).Submit(context.Background(), input)
			if err != nil || id != "1234567890123456789" || calls != 1 {
				t.Fatalf("id=%q calls=%d err=%v", id, calls, err)
			}
		})
	}
}
