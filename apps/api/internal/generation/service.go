package generation

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type Status string
type Priority string
type CircuitState string

const (
	PriorityNormal    Priority = "normal"
	PriorityExpedited Priority = "expedited"
)

const (
	CircuitNormal  CircuitState = "normal"
	CircuitPaused  CircuitState = "paused"
	CircuitProbing CircuitState = "probing"
)

const (
	Queued        Status = "queued"
	Running       Status = "running"
	Completed     Status = "completed"
	Canceled      Status = "canceled"
	Failed        Status = "failed"
	NeedsReview   Status = "needs_review"
	QueryFailed   Status = "query_failed"
	SaveExhausted Status = "save_exhausted"
)

var (
	ErrInvalid             = errors.New("invalid generation input")
	ErrForbidden           = errors.New("forbidden")
	ErrNotFound            = errors.New("task not found")
	ErrConflict            = errors.New("idempotency conflict")
	ErrSubmissionRejected  = errors.New("provider rejected submission before execution")
	ErrUserQueueFull       = errors.New("user generation queue full")
	ErrModelQueueFull      = errors.New("model generation queue full")
	ErrConnectionQueueFull = errors.New("connection generation queue full")
)

type Actor struct {
	ID    string
	Admin bool
}
type Input struct {
	ProjectID    string            `json:"projectId"`
	NodeID       string            `json:"nodeId,omitempty"`
	ReferenceIDs []string          `json:"referenceIds,omitempty"`
	Model        string            `json:"model"`
	Prompt       string            `json:"prompt"`
	Width        int               `json:"width"`
	Height       int               `json:"height"`
	Seed         int64             `json:"seed,omitempty"`
	Duration     int               `json:"duration,omitempty"`
	References   []Reference       `json:"references,omitempty"`
	InstanceType string            `json:"instanceType,omitempty"`
	ImageOptions *ImageOptions     `json:"imageOptions,omitempty"`
	Workflow     *WorkflowSnapshot `json:"workflow,omitempty"`
}
type Reference struct {
	Kind     string `json:"kind"`
	URL      string `json:"url"`
	UseAudio bool   `json:"useAudio,omitempty"`
}
type ImageOptions struct {
	OutputFormat       string `json:"outputFormat,omitempty"`
	Watermark          bool   `json:"watermark,omitempty"`
	PromptOptimization string `json:"promptOptimization,omitempty"`
	Background         string `json:"background,omitempty"`
}
type Task struct {
	ID             string    `json:"id"`
	Version        int64     `json:"version"`
	Status         Status    `json:"status"`
	Priority       Priority  `json:"priority"`
	Model          string    `json:"model"`
	ProjectID      string    `json:"projectId"`
	NodeID         string    `json:"nodeId,omitempty"`
	ResultURL      string    `json:"resultUrl,omitempty"`
	AttachedNodeID string    `json:"attachedNodeId,omitempty"`
	AttachmentNote string    `json:"attachmentNote,omitempty"`
	Stage          string    `json:"stage"`
	Percent        *float64  `json:"percent,omitempty"`
	FailureCode    string    `json:"failureCode,omitempty"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
}
type Event struct {
	ID         int64     `json:"id"`
	Type       string    `json:"type"`
	Stage      string    `json:"stage,omitempty"`
	OccurredAt time.Time `json:"occurredAt"`
}
type Operations struct {
	QueueLength       int64             `json:"queueLength"`
	OldestWaitSeconds float64           `json:"oldestWaitSeconds"`
	NeedsReview       int64             `json:"needsReview"`
	Stages            []StageMetric     `json:"stages"`
	Failures          []FailureMetric   `json:"failures"`
	Workers           []WorkerHeartbeat `json:"workers"`
	Circuits          []CircuitStatus   `json:"circuits"`
}
type StageMetric struct {
	Stage          string  `json:"stage"`
	AverageSeconds float64 `json:"averageSeconds"`
	Samples        int64   `json:"samples"`
}
type FailureMetric struct {
	Code  string `json:"code"`
	Count int64  `json:"count"`
}
type WorkerHeartbeat struct {
	ID     string    `json:"id"`
	SeenAt time.Time `json:"seenAt"`
}
type CircuitStatus struct {
	ConnectionID        string       `json:"connectionId"`
	State               CircuitState `json:"state"`
	ConsecutiveFailures int          `json:"consecutiveFailures"`
	LastReason          string       `json:"lastReason,omitempty"`
	NextProbeAt         *time.Time   `json:"nextProbeAt,omitempty"`
}
type Resources interface {
	OwnsProject(context.Context, string, string) (bool, error)
	OwnsReference(context.Context, string, string) (bool, error)
}
type Store interface {
	Create(context.Context, string, string, string, Input) (Task, error)
	Get(context.Context, string) (Task, string, error)
	Cancel(context.Context, string, string) (Task, error)
}
type Service struct {
	Store     Store
	Resources Resources
}

func (s Service) Create(ctx context.Context, actor Actor, key string, input Input) (Task, error) {
	if ConnectionForModel(input.Model) == "" && input.Workflow == nil {
		snapshot, _, err := ResolveModel(input.Model)
		if err != nil {
			return Task{}, ErrInvalid
		}
		input.Workflow = snapshot
	}
	if ConnectionForModel(input.Model) != "" && input.Workflow != nil {
		return Task{}, ErrInvalid
	}
	if actor.ID == "" || len(key) < 1 || len(key) > 200 || strings.TrimSpace(input.ProjectID) == "" || len(input.NodeID) > 200 || !ValidInput(input) || input.Seed != 0 {
		return Task{}, ErrInvalid
	}
	if s.Resources == nil {
		return Task{}, ErrForbidden
	}
	ok, err := s.Resources.OwnsProject(ctx, actor.ID, input.ProjectID)
	if err != nil {
		return Task{}, err
	}
	if !ok {
		return Task{}, ErrForbidden
	}
	b, _ := json.Marshal(input)
	h := sha256.Sum256(b)
	var seedBytes [6]byte
	if _, err := rand.Read(seedBytes[:]); err != nil {
		return Task{}, err
	}
	for _, part := range seedBytes {
		input.Seed = input.Seed<<8 | int64(part)
	}
	return s.Store.Create(ctx, actor.ID, key, hex.EncodeToString(h[:]), input)
}
func (s Service) Get(ctx context.Context, a Actor, id string) (Task, error) {
	t, owner, err := s.Store.Get(ctx, id)
	if err != nil {
		return Task{}, err
	}
	if owner != a.ID && !a.Admin {
		return Task{}, ErrNotFound
	}
	return t, nil
}
func (s Service) Cancel(ctx context.Context, a Actor, id string) (Task, error) {
	_, owner, err := s.Store.Get(ctx, id)
	if err != nil {
		return Task{}, err
	}
	if owner != a.ID {
		return Task{}, ErrNotFound
	}
	return s.Store.Cancel(ctx, id, owner)
}
func (s Service) Events(ctx context.Context, a Actor, id string, after int64) ([]Event, error) {
	if _, err := s.Get(ctx, a, id); err != nil {
		return nil, err
	}
	source, ok := s.Store.(interface {
		Events(context.Context, string, int64) ([]Event, error)
	})
	if !ok {
		return nil, ErrNotFound
	}
	return source.Events(ctx, id, after)
}
func (s Service) Resume(ctx context.Context, a Actor, id string) (Task, error) {
	if _, err := s.Get(ctx, a, id); err != nil {
		return Task{}, err
	}
	source, ok := s.Store.(interface {
		ResumeDelivery(context.Context, string) error
	})
	if !ok {
		return Task{}, ErrNotFound
	}
	if err := source.ResumeDelivery(ctx, id); err != nil {
		return Task{}, err
	}
	return s.Get(ctx, a, id)
}
func (s Service) Operations(ctx context.Context, a Actor) (Operations, error) {
	if !a.Admin || a.ID == "" {
		return Operations{}, ErrForbidden
	}
	source, ok := s.Store.(interface {
		Operations(context.Context, string) (Operations, error)
	})
	if !ok {
		return Operations{}, ErrNotFound
	}
	return source.Operations(ctx, a.ID)
}
func (s Service) SetPriority(ctx context.Context, a Actor, id string, priority Priority) (Task, error) {
	if !a.Admin || a.ID == "" {
		return Task{}, ErrForbidden
	}
	if priority != PriorityNormal && priority != PriorityExpedited {
		return Task{}, ErrInvalid
	}
	source, ok := s.Store.(interface {
		SetPriority(context.Context, string, string, Priority) (Task, error)
	})
	if !ok {
		return Task{}, ErrNotFound
	}
	return source.SetPriority(ctx, id, a.ID, priority)
}
func NewID() (string, error) {
	var b [16]byte
	_, err := rand.Read(b[:])
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
