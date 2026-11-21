package queue

import (
	"blow-flow/api/internal/generation"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestH3TextSubmissionPrunesSampleReferences(t *testing.T) {
	var graph map[string]workflowNode
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/task/openapi/create" {
			t.Fatalf("path %s", r.URL.Path)
		}
		var body struct {
			Workflow   string `json:"workflow"`
			WorkflowID string `json:"workflowId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.WorkflowID != "2116745173157138433" {
			t.Fatal(body.WorkflowID)
		}
		if err := json.Unmarshal([]byte(body.Workflow), &graph); err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(`{"code":0,"data":{"taskId":123}}`))
	}))
	defer server.Close()
	id, err := (H3{Krea2{BaseURL: server.URL, APIKey: "key", Client: server.Client()}}).Submit(context.Background(), generation.Input{Model: generation.H3Model, Prompt: "motion", Width: 1280, Height: 736, Duration: 7, Seed: 42})
	if err != nil || id != "123" {
		t.Fatalf("id=%s err=%v", id, err)
	}
	if _, ok := graph["199"]; ok {
		t.Fatal("sample image remains")
	}
	if graph["136"].Inputs["ref_images.ref_image_0"] != nil {
		t.Fatal("sample reference remains")
	}
	if graph["227"].Inputs["value"] != float64(7) {
		t.Fatal("duration mapping")
	}
}

func TestSeedreamDirectResult(t *testing.T) {
	for _, tc := range []struct {
		name, model, background, size, amount, currency string
	}{
		{"5.5 uses the output dimensions", generation.Seedream55Model, "transparent", "2048x2048", "0.23", "CNY"},
		{"5.0 Pro uses its own tariff", generation.Seedream50Model, "opaque", "2048x2048", "0.60", "CNY"},
		{"missing size leaves cost pending", generation.Seedream55Model, "opaque", "", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					return
				}
				if body["model"] != tc.model || body["background"] != tc.background {
					t.Errorf("body %#v", body)
				}
				fmt.Fprintf(w, `{"data":[{"url":"https://provider.test/result.png","size":%q}],"usage":{"input_images":0,"generated_images":1,"output_tokens":16384}}`, tc.size)
			}))
			defer server.Close()
			provider := Providers{Seedream: Seedream{BaseURL: server.URL, APIKey: "key", Client: server.Client()}}
			result, err := provider.submitTask(context.Background(), "task-1", generation.Input{Model: tc.model, Prompt: "cat", Width: 1024, Height: 1024, ImageOptions: &generation.ImageOptions{Background: tc.background}})
			if err != nil {
				t.Fatal(err)
			}
			if result.Usage == nil || result.Usage.Amount != tc.amount || result.Usage.Currency != tc.currency || string(result.Usage.Fields["generated_images"]) != "1" {
				t.Fatalf("unexpected supplier usage: %+v", result.Usage)
			}
			got, err := provider.QueryModel(context.Background(), tc.model, result.ID)
			if err != nil || got.OutputURL != "https://provider.test/result.png" || got.FileType != "png" {
				t.Fatalf("got %#v err %v", got, err)
			}
		})
	}
}

type inlineStub struct {
	task, kind string
	body       []byte
}

func (s *inlineStub) StageInlineResult(_ context.Context, task, kind string, body []byte) error {
	s.task = task
	s.kind = kind
	s.body = body
	return nil
}
func (s *inlineStub) InlineResult(_ context.Context, task string) ([]byte, string, error) {
	if task != s.task {
		return nil, "", generation.ErrNotFound
	}
	return s.body, s.kind, nil
}

func TestGeminiStagesImageBeforeReturningProviderReceipt(t *testing.T) {
	png := []byte{137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 144, 119, 83, 222}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1beta/models/gemini-3-pro-image-preview:generateContent" {
			t.Fatal(r.URL.Path)
		}
		var body struct {
			GenerationConfig struct {
				ImageConfig struct{ AspectRatio, ImageSize string } `json:"imageConfig"`
			} `json:"generationConfig"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.GenerationConfig.ImageConfig.AspectRatio != "1:1" || body.GenerationConfig.ImageConfig.ImageSize != "1K" {
			t.Fatalf("config %#v", body)
		}
		w.Write([]byte(`{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"` + base64.StdEncoding.EncodeToString(png) + `"}}]}}]}`))
	}))
	defer server.Close()
	stage := &inlineStub{}
	id, err := (Providers{Gemini: Gemini{BaseURL: server.URL, APIKey: "key", Client: server.Client(), Stage: stage}}).SubmitTask(context.Background(), "task-1", generation.Input{Model: generation.GeminiImageModel, Prompt: "cat", Width: 1024, Height: 1024})
	if err != nil || id != "inline:task-1" || stage.task != "task-1" || stage.kind != "png" {
		t.Fatalf("id=%s err=%v staged=%#v", id, err, stage)
	}
}
