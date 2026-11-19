package agent

import (
	"blow-flow/api/internal/generation"
	"encoding/json"
	"errors"
	"time"
)

var (
	ErrInvalid         = errors.New("invalid agent request")
	ErrNotFound        = errors.New("agent task or project not found")
	ErrConflict        = errors.New("agent task state or canvas version conflict")
	ErrRequestConflict = errors.New("agent tool identity reused")
	ErrRunExpired      = errors.New("agent run expired or superseded")
	ErrForbidden       = errors.New("agent canvas operation not authorized")
)

type Task struct {
	ID             string    `json:"id"`
	OwnerID        string    `json:"-"`
	ProjectID      string    `json:"projectId"`
	ModelID        string    `json:"modelId"`
	Status         string    `json:"status"`
	Question       *Question `json:"question,omitempty"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
	LegacyImported bool      `json:"legacyImported,omitempty"`
	Steps          []Step    `json:"steps,omitempty"`
}

type Question struct {
	ID        string          `json:"id"`
	Text      string          `json:"text"`
	Options   []string        `json:"options"`
	Scope     json.RawMessage `json:"scope,omitempty"`
	Answer    string          `json:"answer,omitempty"`
	Cancelled bool            `json:"cancelled,omitempty"`
}

type GenerationItem struct {
	NodeID string `json:"nodeId"`
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

type GenerationBatch struct {
	ID     string            `json:"id"`
	Digest string            `json:"digest"`
	Status string            `json:"status"`
	Items  []GenerationItem  `json:"items"`
	Tasks  []generation.Task `json:"tasks"`
}

type Reference struct {
	NodeID   string `json:"nodeId,omitempty"`
	AssetID  string `json:"assetId,omitempty"`
	URL      string `json:"url,omitempty"`
	Data     string `json:"data,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
	Name     string `json:"name,omitempty"`
}

type Message struct {
	ID         string      `json:"id"`
	TaskID     string      `json:"taskId"`
	RunID      string      `json:"runId,omitempty"`
	Role       string      `json:"role"`
	Text       string      `json:"text"`
	References []Reference `json:"references"`
	CreatedAt  time.Time   `json:"createdAt"`
}

type Snapshot struct {
	Tasks                   []Task            `json:"tasks"`
	Messages                []Message         `json:"messages"`
	LegacyGenerationBatches []json.RawMessage `json:"legacyGenerationBatches,omitempty"`
}

type Command struct {
	RequestID     string      `json:"requestId"`
	Action        string      `json:"action"`
	Text          string      `json:"text,omitempty"`
	ModelID       string      `json:"modelId,omitempty"`
	QuestionID    string      `json:"questionId,omitempty"`
	References    []Reference `json:"references,omitempty"`
	CanvasVersion int64       `json:"canvasVersion,omitempty"`
}

type Run struct {
	Task       Task      `json:"task"`
	RunID      string    `json:"runId"`
	Token      string    `json:"token"`
	LeaseUntil time.Time `json:"leaseUntil"`
}

type RunContext struct {
	Task     Task      `json:"task"`
	Messages []Message `json:"messages"`
	Steps    []Step    `json:"steps"`
}

type Step struct {
	CallID    string          `json:"callId"`
	RunID     string          `json:"runId"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
	Status    string          `json:"status"`
	Result    json.RawMessage `json:"result,omitempty"`
	CreatedAt time.Time       `json:"createdAt"`
}

type StepStart struct {
	CallID    string          `json:"callId"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type StepFinish struct {
	CallID string          `json:"callId"`
	Status string          `json:"status"`
	Result json.RawMessage `json:"result"`
}

type Canvas struct {
	Snapshot json.RawMessage `json:"snapshot"`
	Version  int64           `json:"version"`
}

type Commit struct {
	CallID      string          `json:"callId"`
	Label       string          `json:"label"`
	BaseVersion int64           `json:"baseVersion"`
	Operations  json.RawMessage `json:"operations"`
	Snapshot    json.RawMessage `json:"snapshot"`
	Skipped     []string        `json:"skipped"`
}

type CanvasReceipt struct {
	Version      int64           `json:"version"`
	Label        string          `json:"label"`
	Skipped      []string        `json:"skipped"`
	Operations   json.RawMessage `json:"operations"`
	RemovedNodes json.RawMessage `json:"removedNodes"`
}
