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
	"net/http"
	"strings"
	"time"
)

//go:embed krea2_workflow.json
var krea2Workflow []byte

var ErrSubmissionRejected = generation.ErrSubmissionRejected
var ErrSubmissionUncertain = errors.New("provider submission result uncertain")

type Krea2 struct {
	BaseURL, APIKey string
	Client          *http.Client
}
type nodeOverride struct {
	NodeID     string `json:"nodeId"`
	FieldName  string `json:"fieldName"`
	FieldValue any    `json:"fieldValue"`
}

func (p Krea2) Submit(ctx context.Context, input generation.Input) (string, error) {
	if input.Model != generation.Krea2Model || !generation.ValidInput(input) {
		return "", generation.ErrInvalid
	}
	if p.BaseURL == "" || p.APIKey == "" {
		return "", generation.ErrInvalid
	}
	var graph map[string]struct {
		Inputs map[string]any `json:"inputs"`
	}
	if err := json.Unmarshal(krea2Workflow, &graph); err != nil {
		return "", err
	}
	overrides := []nodeOverride{{"102", "prompt", input.Prompt}, {"10", "custom_width", input.Width}, {"10", "custom_height", input.Height}, {"97", "seed", input.Seed}, {"10", "use_custom_resolution", true}}
	for _, n := range overrides {
		node := graph[n.NodeID]
		node.Inputs[n.FieldName] = n.FieldValue
		graph[n.NodeID] = node
	}
	workflow, err := json.Marshal(graph)
	if err != nil {
		return "", err
	}
	body, err := json.Marshal(struct {
		APIKey       string         `json:"apiKey"`
		WorkflowID   string         `json:"workflowId"`
		Workflow     string         `json:"workflow"`
		Nodes        []nodeOverride `json:"nodeInfoList"`
		InstanceType string         `json:"instanceType,omitempty"`
	}{p.APIKey, "2109340746494357505", string(workflow), overrides, input.InstanceType})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(p.BaseURL, "/")+"/task/openapi/create", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.APIKey)
	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	copyClient := *client
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := copyClient.Do(req)
	if err != nil {
		return "", submissionTransportError(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", submissionHTTPError(response)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", ErrSubmissionUncertain
	}
	var reply struct {
		Code int `json:"code"`
		Data struct {
			TaskID json.Number `json:"taskId"`
		} `json:"data"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&reply); err != nil {
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
