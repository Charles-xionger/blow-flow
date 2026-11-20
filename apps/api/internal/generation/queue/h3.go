package queue

import (
	"blow-flow/api/internal/generation"
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"
)

//go:embed h3_workflow.json
var h3Workflow []byte

type H3 struct{ Krea2 }

type workflowNode = generation.WorkflowNode

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
	if err := attachReferences(ctx, graph, generation.WorkflowReferences{NodeID: "136", ImageLoader: "199", VideoLoader: "185", AudioLoader: "182"}, input, frames, p); err != nil {
		return "", generation.ErrSubmissionRejected
	}
	pruneReferenceGraph(graph, "148")
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

func (p H3) upload(ctx context.Context, ref generation.Reference) (string, referenceInfo, error) {
	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	safe := *client
	safe.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	bytesValue, filename, err := referenceBytes(ctx, client, ref)
	if err != nil {
		return "", referenceInfo{}, err
	}
	info, err := inspectReference(ctx, bytesValue, filename, ref.Kind)
	if err != nil {
		return "", referenceInfo{}, err
	}
	if ref.Kind == "video" && ref.UseAudio && !info.HasAudio {
		return "", referenceInfo{}, generation.ErrInvalid
	}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	_ = form.WriteField("apiKey", p.APIKey)
	_ = form.WriteField("fileType", "input")
	part, err := form.CreateFormFile("file", filename)
	if err != nil {
		return "", referenceInfo{}, err
	}
	if _, err = part.Write(bytesValue); err != nil {
		return "", referenceInfo{}, err
	}
	if err = form.Close(); err != nil {
		return "", referenceInfo{}, err
	}
	uploadReq, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(p.BaseURL, "/")+"/task/openapi/upload", &body)
	if err != nil {
		return "", referenceInfo{}, err
	}
	uploadReq.Header.Set("Content-Type", form.FormDataContentType())
	uploadReq.Header.Set("Authorization", "Bearer "+p.APIKey)
	uploadResponse, err := safe.Do(uploadReq)
	if err != nil {
		return "", referenceInfo{}, err
	}
	defer uploadResponse.Body.Close()
	if uploadResponse.StatusCode != 200 {
		return "", referenceInfo{}, generation.ErrSubmissionRejected
	}
	var reply struct {
		Code int `json:"code"`
		Data struct {
			FileName string `json:"fileName"`
		} `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(uploadResponse.Body, 1<<20)).Decode(&reply) != nil || reply.Code != 0 || reply.Data.FileName == "" {
		return "", referenceInfo{}, generation.ErrSubmissionRejected
	}
	return reply.Data.FileName, info, nil
}
