package agent

import (
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
	ID        string    `json:"id"`
	OwnerID   string    `json:"-"`
	ProjectID string    `json:"projectId"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Run struct {
	Task       Task      `json:"task"`
	RunID      string    `json:"runId"`
	Token      string    `json:"token"`
	LeaseUntil time.Time `json:"leaseUntil"`
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
