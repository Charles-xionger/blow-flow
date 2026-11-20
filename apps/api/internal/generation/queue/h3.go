package queue

import (
	"blow-flow/api/internal/generation"
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
)

//go:embed h3_workflow.json
var h3Workflow []byte

type H3 struct{ Krea2 }

type workflowNode struct {
	Inputs    map[string]any `json:"inputs"`
	ClassType string         `json:"class_type"`
}

func (p H3) Submit(ctx context.Context, input generation.Input) (string, error) {
	if input.Model != generation.H3Model || !generation.ValidInput(input) {
		return "", generation.ErrInvalid
	}
	if p.BaseURL == "" || p.APIKey == "" {
		return "", generation.ErrInvalid
	}
	var graph map[string]workflowNode
	if err := json.Unmarshal(h3Workflow, &graph); err != nil {
		return "", err
	}
	frames := max(5, input.Duration*24)
	frames += ((5 - frames%17) + 17) % 17
	overrides := []nodeOverride{{"238", "value", input.Prompt}, {"136", "width", input.Width}, {"136", "height", input.Height}, {"129", "noise_seed", input.Seed}, {"227", "value", input.Duration}}
	for _, o := range overrides {
		n := graph[o.NodeID]
		n.Inputs[o.FieldName] = o.FieldValue
		graph[o.NodeID] = n
	}
	target := graph["136"]
	for key := range target.Inputs {
		if strings.HasPrefix(key, "ref_images.") || strings.HasPrefix(key, "ref_videos.") || strings.HasPrefix(key, "ref_video_audios.") || strings.HasPrefix(key, "ref_audios.") {
			delete(target.Inputs, key)
		}
	}
	counts := map[string]int{}
	next := 1000
	for _, ref := range input.References {
		name, err := p.upload(ctx, ref)
		if err != nil {
			return "", err
		}
		loaderID := "199"
		field := "image"
		prefix := "ref_images.ref_image_"
		if ref.Kind == "video" {
			loaderID = "185"
			field = "video"
			prefix = "ref_videos.ref_video_"
		}
		if ref.Kind == "audio" {
			loaderID = "182"
			field = "audio"
			prefix = "ref_audios.ref_audio_"
		}
		id := fmt.Sprint(next)
		next++
		loader := graph[loaderID]
		copyInputs := make(map[string]any, len(loader.Inputs))
		for k, v := range loader.Inputs {
			copyInputs[k] = v
		}
		loader.Inputs = copyInputs
		loader.Inputs[field] = name
		if ref.Kind == "video" {
			loader.Inputs["force_rate"] = 24
			loader.Inputs["frame_load_cap"] = frames
			loader.Inputs["skip_first_frames"] = 0
			loader.Inputs["select_every_nth"] = 1
		}
		graph[id] = loader
		index := counts[ref.Kind]
		counts[ref.Kind]++
		target.Inputs[prefix+fmt.Sprint(index)] = []any{id, 0}
		if ref.Kind == "video" && ref.UseAudio {
			target.Inputs["ref_video_audios.ref_video_audio_"+fmt.Sprint(index)] = []any{id, 2}
		}
	}
	graph["136"] = target
	// The exported graph contains sample media. Keep only nodes reachable from the output.
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
		for _, v := range node.Inputs {
			a, ok := v.([]any)
			if ok && len(a) == 2 {
				if child, ok := a[0].(string); ok {
					visit(child)
				}
			}
		}
	}
	visit("148")
	for id := range graph {
		if !keep[id] {
			delete(graph, id)
		}
	}
	workflow, err := json.Marshal(graph)
	if err != nil {
		return "", err
	}
	body := map[string]any{"apiKey": p.APIKey, "workflowId": "2116745173157138433", "workflow": string(workflow), "nodeInfoList": overrides}
	if input.InstanceType == "plus" {
		body["instanceType"] = "plus"
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(p.BaseURL, "/")+"/task/openapi/create", bytes.NewReader(raw))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.APIKey)
	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
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
	var reply struct {
		Code int `json:"code"`
		Data struct {
			TaskID json.Number `json:"taskId"`
		} `json:"data"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	decoder.UseNumber()
	if decoder.Decode(&reply) != nil {
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

func (p H3) upload(ctx context.Context, ref generation.Reference) (string, error) {
	u, err := url.Parse(ref.URL)
	if err != nil {
		return "", generation.ErrInvalid
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ref.URL, nil)
	if err != nil {
		return "", err
	}
	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	safe := *client
	safe.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := safe.Do(req)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return "", errors.New("reference download failed")
	}
	bytesValue, err := io.ReadAll(io.LimitReader(response.Body, (30<<20)+1))
	if err != nil {
		return "", err
	}
	if len(bytesValue) == 0 || len(bytesValue) > 30<<20 {
		return "", generation.ErrInvalid
	}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	_ = form.WriteField("apiKey", p.APIKey)
	_ = form.WriteField("fileType", "input")
	part, err := form.CreateFormFile("file", path.Base(u.Path))
	if err != nil {
		return "", err
	}
	if _, err = part.Write(bytesValue); err != nil {
		return "", err
	}
	if err = form.Close(); err != nil {
		return "", err
	}
	uploadReq, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(p.BaseURL, "/")+"/task/openapi/upload", &body)
	if err != nil {
		return "", err
	}
	uploadReq.Header.Set("Content-Type", form.FormDataContentType())
	uploadReq.Header.Set("Authorization", "Bearer "+p.APIKey)
	uploadResponse, err := safe.Do(uploadReq)
	if err != nil {
		return "", err
	}
	defer uploadResponse.Body.Close()
	if uploadResponse.StatusCode != 200 {
		return "", errors.New("reference upload failed")
	}
	var reply struct {
		Code int `json:"code"`
		Data struct {
			FileName string `json:"fileName"`
		} `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(uploadResponse.Body, 1<<20)).Decode(&reply) != nil || reply.Code != 0 || reply.Data.FileName == "" {
		return "", errors.New("invalid reference upload response")
	}
	return reply.Data.FileName, nil
}
