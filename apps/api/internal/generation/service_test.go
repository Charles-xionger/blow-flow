package generation

import (
	"context"
	"errors"
	"testing"
)

type resourcesStub struct{ project, reference bool }

func (r resourcesStub) OwnsProject(context.Context, string, string) (bool, error) {
	return r.project, nil
}
func (r resourcesStub) OwnsReference(context.Context, string, string) (bool, error) {
	return r.reference, nil
}

type storeStub struct {
	task    Task
	owner   string
	created int
}

func (s *storeStub) Create(_ context.Context, _, _, _ string, _ Input) (Task, error) {
	s.created++
	return s.task, nil
}
func (s *storeStub) Get(context.Context, string) (Task, string, error) { return s.task, s.owner, nil }
func (s *storeStub) Cancel(context.Context, string, string) (Task, error) {
	s.task.Status = Canceled
	return s.task, nil
}
func TestGenerationChecksResourceOwnerAndHidesOtherUsersTask(t *testing.T) {
	ctx := context.Background()
	store := &storeStub{task: Task{ID: "task", Status: Queued}, owner: "owner"}
	s := Service{Store: store, Resources: resourcesStub{project: true, reference: false}}
	input := Input{ProjectID: "project", ReferenceIDs: []string{"ref"}, Model: "runninghub/krea2", Prompt: "cat", Width: 1024, Height: 1024}
	if _, err := s.Create(ctx, Actor{ID: "owner"}, "key", input); !errors.Is(err, ErrInvalid) || store.created != 0 {
		t.Fatalf("reference ownership: %v, creates=%d", err, store.created)
	}
	s.Resources = resourcesStub{project: true, reference: true}
	input.ReferenceIDs = nil
	if _, err := s.Create(ctx, Actor{ID: "owner"}, "key", input); err != nil || store.created != 1 {
		t.Fatalf("create: %v, creates=%d", err, store.created)
	}
	if _, err := s.Get(ctx, Actor{ID: "other"}, "task"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other user query: %v", err)
	}
	if _, err := s.Cancel(ctx, Actor{ID: "other", Admin: true}, "task"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other user cancel: %v", err)
	}
	if _, err := s.Get(ctx, Actor{ID: "admin", Admin: true}, "task"); err != nil {
		t.Fatalf("admin query: %v", err)
	}
}
