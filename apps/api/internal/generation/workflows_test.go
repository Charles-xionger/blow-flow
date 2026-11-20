package generation

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestFrozenWorkflowSurvivesAdminConfigChange(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "generation.json")
	t.Setenv("GENERATION_CONFIG_PATH", path)
	t.Setenv("CUSTOM_KEY", "secret")
	config := map[string]any{"connections": []any{map[string]any{"id": "custom", "baseUrl": "https://example.test", "apiKeyEnv": "CUSTOM_KEY", "concurrency": 2, "requestTimeoutMs": 1000, "pollIntervalMs": 1000, "queryTimeoutMs": 1000, "maxQueryErrors": 3}}, "models": []any{map[string]any{"id": "custom/image", "name": "Custom", "category": "IMAGE", "adapter": "runninghub-workflow", "version": "1", "connectionId": "custom", "workflowId": "123", "workflow": map[string]any{"1": map[string]any{"inputs": map[string]any{"prompt": "", "width": 1024, "height": 1024, "seed": 0, "custom": false}, "class_type": "Output"}}, "outputNode": "1", "mapping": map[string]any{"prompt": map[string]any{"nodeId": "1", "fieldName": "prompt"}, "width": map[string]any{"nodeId": "1", "fieldName": "width"}, "height": map[string]any{"nodeId": "1", "fieldName": "height"}, "seed": map[string]any{"nodeId": "1", "fieldName": "seed"}, "customResolution": map[string]any{"nodeId": "1", "fieldName": "custom"}}, "capabilities": map[string]any{"prompt": true, "referenceImages": false, "dimensions": map[string]any{"min": 64, "max": 8192, "step": 8, "defaultWidth": 1024, "defaultHeight": 1024}}}}}
	b, _ := json.Marshal(config)
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
	m, d, err := ResolveModel("custom/image")
	if err != nil || d == "" {
		t.Fatal(err)
	}
	in := Input{Model: m.ID, Prompt: "cat", Width: 1024, Height: 1024, Workflow: m}
	if !ValidInput(in) || !ModelConfigured(m.ID) || ModelCategory(m.ID) != "IMAGE" {
		t.Fatal("custom model unavailable")
	}
	if err := os.WriteFile(path, []byte(`{"connections":[],"models":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	if !ValidInput(in) {
		t.Fatal("approved snapshot changed with admin config")
	}
	if _, _, err := ResolveModel("custom/image"); err == nil {
		t.Fatal("removed model resolved")
	}
	in.Workflow.Digest = "bad"
	if ValidInput(in) {
		t.Fatal("tampered snapshot accepted")
	}
}
