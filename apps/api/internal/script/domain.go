package script

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	ErrInvalid     = errors.New("invalid script request")
	ErrNotFound    = errors.New("script task not found")
	ErrConflict    = errors.New("script task conflict")
	ErrUnavailable = errors.New("script model unavailable")
)

type Reference struct {
	NodeID  string `json:"nodeId"`
	Label   string `json:"label"`
	Type    string `json:"type"`
	Content string `json:"content"`
}
type Limits struct {
	Duration int `json:"duration"`
	MaxShots int `json:"maxShots"`
}
type Input struct {
	OutputMode   string      `json:"outputMode,omitempty"`
	Storyboard   *Limits     `json:"storyboard,omitempty"`
	Model        string      `json:"model"`
	Requirements string      `json:"requirements"`
	Instruction  string      `json:"instruction"`
	Preset       string      `json:"preset"`
	References   []Reference `json:"references"`
}
type Create struct {
	RequestID string `json:"requestId"`
	CanvasID  string `json:"canvasId"`
	NodeID    string `json:"nodeId"`
	Input     Input  `json:"input"`
}
type Task struct {
	ID           string          `json:"id"`
	RequestID    string          `json:"requestId"`
	CanvasID     string          `json:"canvasId"`
	NodeID       string          `json:"nodeId"`
	Input        Input           `json:"input"`
	Status       string          `json:"status"`
	Phase        string          `json:"phase"`
	Text         string          `json:"text"`
	Workflow     json.RawMessage `json:"workflow,omitempty"`
	OutputNodeID string          `json:"outputNodeId,omitempty"`
	Revision     int64           `json:"revision"`
	CreatedAt    int64           `json:"createdAt"`
	UpdatedAt    int64           `json:"updatedAt"`
	Error        string          `json:"error,omitempty"`
}

type ModelCatalog interface {
	Validate(model string, images bool) error
}
type Repository interface {
	LookupRequest(context.Context, string, Create) (Task, bool, error)
	Create(context.Context, string, Create) (Task, error)
	Get(context.Context, string, string) (Task, error)
	List(context.Context, string, string, string) ([]Task, error)
	Stop(context.Context, string, string) (Task, error)
}
type Service struct {
	Repository Repository
	Models     ModelCatalog
}

func (s Service) Create(ctx context.Context, owner string, request Create) (Task, error) {
	if !validID(owner) || !validID(request.RequestID) || !validID(request.CanvasID) || !validID(request.NodeID) {
		return Task{}, ErrInvalid
	}
	if err := request.Input.Validate(); err != nil {
		return Task{}, err
	}
	if s.Models == nil || s.Repository == nil {
		return Task{}, ErrUnavailable
	}
	if prior, found, err := s.Repository.LookupRequest(ctx, owner, request); err != nil {
		return Task{}, err
	} else if found {
		return prior, nil
	}
	images := false
	for _, r := range request.Input.References {
		if r.Type == "image" {
			images = true
		}
	}
	if err := s.Models.Validate(request.Input.Model, images); err != nil {
		return Task{}, ErrUnavailable
	}
	return s.Repository.Create(ctx, owner, request)
}
func (s Service) Get(ctx context.Context, owner, id string) (Task, error) {
	if !validID(owner) || !validID(id) {
		return Task{}, ErrInvalid
	}
	return s.Repository.Get(ctx, owner, id)
}
func (s Service) List(ctx context.Context, owner, project, node string) ([]Task, error) {
	if !validID(owner) || !validID(project) || node != "" && !validID(node) {
		return nil, ErrInvalid
	}
	return s.Repository.List(ctx, owner, project, node)
}
func (s Service) Stop(ctx context.Context, owner, id string) (Task, error) {
	if !validID(owner) || !validID(id) {
		return Task{}, ErrInvalid
	}
	return s.Repository.Stop(ctx, owner, id)
}

func validID(v string) bool { return v != "" && len(v) <= 200 && strings.TrimSpace(v) == v }
func (in Input) Validate() error {
	if !validID(in.Model) || len(in.Requirements) > 100_000 || len(in.Instruction) > 100_000 || len(in.Preset) > 100 || len(in.References) > 100 {
		return ErrInvalid
	}
	if strings.TrimSpace(in.Requirements) == "" && len(in.References) == 0 {
		return ErrInvalid
	}
	if in.OutputMode != "" && in.OutputMode != "board" && in.OutputMode != "workflow" && in.OutputMode != "shots" {
		return ErrInvalid
	}
	if in.OutputMode == "shots" {
		return ErrUnavailable
	} // Historical outputs are imported; new presets use the fixed workflow.
	if in.OutputMode == "board" || in.OutputMode == "workflow" {
		l := in.Storyboard
		if l == nil || l.Duration < 5 || l.Duration > 600 || l.MaxShots < 1 || l.MaxShots > 40 || l.Duration > l.MaxShots*15 {
			return ErrInvalid
		}
	}
	for _, r := range in.References {
		if !validID(r.NodeID) || len(r.Label) > 200 || len(r.Content) > 200_000 || strings.TrimSpace(r.Content) == "" || (r.Type != "text" && r.Type != "image") {
			return ErrInvalid
		}
	}
	return nil
}
func Prompt(in Input) string {
	parts := []string{in.Instruction}
	images := 0
	for i, r := range in.References {
		if r.Type == "text" {
			parts = append(parts, fmt.Sprintf("参考 %d「%s」:\n%s", i+1, r.Label, r.Content))
		} else {
			images++
			parts = append(parts, fmt.Sprintf("参考 %d「%s」（图片%d）", i+1, r.Label, images))
		}
	}
	if strings.TrimSpace(in.Requirements) != "" {
		parts = append(parts, "创作要求：\n"+in.Requirements)
	}
	return strings.Join(parts, "\n\n")
}

type Claimed struct {
	Task  Task
	Lease string
	Owner string
}
type ExecutorStore interface {
	Get(context.Context, string, string) (Task, error)
	Claim(context.Context, string, time.Duration) (*Claimed, error)
	Heartbeat(context.Context, string, string, time.Duration) (bool, error)
	Append(context.Context, string, string, string) (bool, error)
	SetPhase(context.Context, string, string, string) (bool, error)
	UpdateWorkflow(context.Context, string, string, Workflow, bool) (bool, error)
	Finish(context.Context, string, string, string, string) error
	Recover(context.Context) error
	Pending(context.Context) ([]string, error)
	Unpublished(context.Context) ([]string, error)
	MarkPublished(context.Context, string) error
}
