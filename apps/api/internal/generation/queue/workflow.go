package queue

import (
	"blow-flow/api/internal/generation"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

// WorkflowProvider submits the frozen admin graph. The key is looked up at
// execution; no credential is copied into the persisted task snapshot.
func (p Providers) submitWorkflow(ctx context.Context, in generation.Input) (string, error) {
	if !generation.ValidInput(in) || in.Workflow == nil {
		return "", generation.ErrInvalid
	}
	m := in.Workflow
	key := os.Getenv(m.Connection.APIKeyEnv)
	if key == "" {
		return "", generation.ErrInvalid
	}
	graph := make(map[string]generation.WorkflowNode, len(m.Workflow))
	raw, err := json.Marshal(m.Workflow)
	if err != nil {
		return "", err
	}
	if err = json.Unmarshal(raw, &graph); err != nil {
		return "", err
	}
	values := map[string]any{"prompt": in.Prompt, "width": in.Width, "height": in.Height, "seed": in.Seed, "duration": in.Duration, "customResolution": true}
	overrides := make([]nodeOverride, 0, len(m.Mapping))
	for _, field := range []string{"prompt", "width", "height", "seed", "customResolution", "duration"} {
		mapping, ok := m.Mapping[field]
		if !ok {
			continue
		}
		node := graph[mapping.NodeID]
		node.Inputs[mapping.FieldName] = values[field]
		graph[mapping.NodeID] = node
		overrides = append(overrides, nodeOverride{mapping.NodeID, mapping.FieldName, values[field]})
	}
	if m.Category == "VIDEO" {
		refs := m.References
		target := graph[refs.NodeID]
		for k := range target.Inputs {
			if strings.HasPrefix(k, "ref_images.") || strings.HasPrefix(k, "ref_videos.") || strings.HasPrefix(k, "ref_video_audios.") || strings.HasPrefix(k, "ref_audios.") {
				delete(target.Inputs, k)
			}
		}
		next := 1000
		for id := range graph {
			var n int
			if _, e := fmt.Sscanf(id, "%d", &n); e == nil && n >= next {
				next = n + 1
			}
		}
		counts := map[string]int{}
		uploader := H3{Krea2{BaseURL: m.Connection.BaseURL, APIKey: key, Client: p.RunningHub.Client}}
		for _, ref := range in.References {
			name, e := uploader.upload(ctx, ref)
			if e != nil {
				return "", e
			}
			loaderID, field, prefix := refs.ImageLoader, "image", "ref_images.ref_image_"
			if ref.Kind == "video" {
				loaderID, field, prefix = refs.VideoLoader, "video", "ref_videos.ref_video_"
			}
			if ref.Kind == "audio" {
				loaderID, field, prefix = refs.AudioLoader, "audio", "ref_audios.ref_audio_"
			}
			source := graph[loaderID]
			b, _ := json.Marshal(source)
			var loader generation.WorkflowNode
			if e = json.Unmarshal(b, &loader); e != nil {
				return "", e
			}
			loader.Inputs[field] = name
			if ref.Kind == "video" {
				loader.Inputs["force_rate"] = 24
				loader.Inputs["frame_load_cap"] = max(5, in.Duration*24)
				loader.Inputs["skip_first_frames"] = 0
				loader.Inputs["select_every_nth"] = 1
			}
			id := fmt.Sprint(next)
			next++
			graph[id] = loader
			index := counts[ref.Kind]
			counts[ref.Kind]++
			target.Inputs[prefix+fmt.Sprint(index)] = []any{id, 0}
			if ref.Kind == "video" && ref.UseAudio {
				target.Inputs["ref_video_audios.ref_video_audio_"+fmt.Sprint(index)] = []any{id, 2}
			}
		}
		graph[refs.NodeID] = target
		keep := map[string]bool{}
		var visit func(string)
		visit = func(id string) {
			if keep[id] {
				return
			}
			node, ok := graph[id]
			if !ok {
				return
			}
			keep[id] = true
			for _, value := range node.Inputs {
				if a, ok := value.([]any); ok && len(a) == 2 {
					if child, ok := a[0].(string); ok {
						visit(child)
					}
				}
			}
		}
		visit(m.OutputNode)
		for id := range graph {
			if !keep[id] {
				delete(graph, id)
			}
		}
	}
	graphJSON, err := json.Marshal(graph)
	if err != nil {
		return "", err
	}
	body := map[string]any{"apiKey": key, "workflowId": m.WorkflowID, "workflow": string(graphJSON), "nodeInfoList": overrides}
	if in.InstanceType == "plus" {
		body["instanceType"] = "plus"
	}
	data, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(m.Connection.BaseURL, "/")+"/task/openapi/create", bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	client := p.RunningHub.Client
	if client == nil {
		client = &http.Client{Timeout: time.Duration(m.Connection.RequestTimeoutMS) * time.Millisecond}
	}
	safe := *client
	safe.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := safe.Do(req)
	if err != nil {
		return "", ErrSubmissionUncertain
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return "", ErrSubmissionUncertain
	}
	answer, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", ErrSubmissionUncertain
	}
	var reply struct {
		Code int `json:"code"`
		Data struct {
			TaskID json.Number `json:"taskId"`
		} `json:"data"`
	}
	decoder := json.NewDecoder(bytes.NewReader(answer))
	decoder.UseNumber()
	if err = decoder.Decode(&reply); err != nil {
		return "", ErrSubmissionUncertain
	}
	if reply.Code == 0 && reply.Data.TaskID.String() != "" {
		return reply.Data.TaskID.String(), nil
	}
	switch reply.Code {
	case 301, 380, 412, 415, 416, 421, 433, 435, 436, 801, 802, 803, 806, 810, 811, 812:
		return "", fmt.Errorf("%w: code %d", ErrSubmissionRejected, reply.Code)
	}
	return "", ErrSubmissionUncertain
}
