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

const (
	Queued      Status = "queued"
	Running     Status = "running"
	Completed   Status = "completed"
	Canceled    Status = "canceled"
	Failed      Status = "failed"
	NeedsReview Status = "needs_review"
)

var (
	ErrInvalid            = errors.New("invalid generation input")
	ErrForbidden          = errors.New("forbidden")
	ErrNotFound           = errors.New("task not found")
	ErrConflict           = errors.New("idempotency conflict")
	ErrSubmissionRejected = errors.New("provider rejected submission before execution")
)

type Actor struct {
	ID    string
	Admin bool
}
type Input struct {
	ProjectID    string   `json:"projectId"`
	ReferenceIDs []string `json:"referenceIds,omitempty"`
	Model        string   `json:"model"`
	Prompt       string   `json:"prompt"`
	Width        int      `json:"width"`
	Height       int      `json:"height"`
	Seed         int64    `json:"seed,omitempty"`
}
type Task struct {
	ID        string    `json:"id"`
	Status    Status    `json:"status"`
	Model     string    `json:"model"`
	ProjectID string    `json:"projectId"`
	ResultURL string    `json:"resultUrl,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
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
	if actor.ID == "" || len(key) < 1 || len(key) > 200 || strings.TrimSpace(input.ProjectID) == "" || strings.TrimSpace(input.Prompt) == "" || len(input.Prompt) > 8000 || input.Width < 64 || input.Width > 8192 || input.Height < 64 || input.Height > 8192 || input.Width%8 != 0 || input.Height%8 != 0 || input.Model != "runninghub/krea2" || len(input.ReferenceIDs) > 0 || input.Seed != 0 {
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
func NewID() (string, error) {
	var b [16]byte
	_, err := rand.Read(b[:])
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
