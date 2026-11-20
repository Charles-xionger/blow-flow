package generation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestCircuitStateSerializesAsOpenAPIValues(t *testing.T) {
	for _, state := range []CircuitState{CircuitNormal, CircuitPaused, CircuitProbing} {
		encoded, err := json.Marshal(CircuitStatus{State: state})
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Contains(encoded, []byte(`"state":"`+string(state)+`"`)) {
			t.Fatalf("state %q encoded as %s", state, encoded)
		}
	}
}

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

func (s *storeStub) SetPriority(_ context.Context, id, actor string, priority Priority) (Task, error) {
	s.task.ID = id
	s.task.Priority = priority
	return s.task, nil
}

func (s *storeStub) Create(_ context.Context, _, _, _ string, _ Input) (Task, error) {
	s.created++
	return s.task, nil
}

func TestOnlyAdministratorsCanChangeQueuedTaskPriority(t *testing.T) {
	store := &storeStub{task: Task{ID: "task", Status: Queued, Priority: PriorityNormal}}
	s := Service{Store: store}
	if _, err := s.SetPriority(context.Background(), Actor{ID: "user"}, "task", PriorityExpedited); !errors.Is(err, ErrForbidden) {
		t.Fatalf("user priority: %v", err)
	}
	got, err := s.SetPriority(context.Background(), Actor{ID: "admin", Admin: true}, "task", PriorityExpedited)
	if err != nil || got.Priority != PriorityExpedited {
		t.Fatalf("admin priority: %+v %v", got, err)
	}
	if _, err = s.SetPriority(context.Background(), Actor{ID: "admin", Admin: true}, "task", Priority("urgent")); !errors.Is(err, ErrInvalid) {
		t.Fatalf("invalid priority: %v", err)
	}
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
