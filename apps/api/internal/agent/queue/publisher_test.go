package queue

import (
	"context"
	"errors"
	"testing"
)

type storeStub struct {
	ids    []string
	marked []string
}

func (s *storeStub) Unpublished(context.Context) ([]string, error) { return s.ids, nil }
func (s *storeStub) MarkPublished(_ context.Context, id string) error {
	s.marked = append(s.marked, id)
	return nil
}

type queueStub struct {
	sent []string
	fail string
}

func (q *queueStub) Publish(_ context.Context, id string) error {
	if id == q.fail {
		return errors.New("unconfirmed")
	}
	q.sent = append(q.sent, id)
	return nil
}

func TestOutboxMarksOnlyConfirmedMessages(t *testing.T) {
	s := &storeStub{ids: []string{"one", "two"}}
	q := &queueStub{fail: "two"}
	if err := (Outbox{Store: s, Queue: q}).PublishPending(context.Background()); err == nil {
		t.Fatal("expected publish failure")
	}
	if len(q.sent) != 1 || q.sent[0] != "one" || len(s.marked) != 1 || s.marked[0] != "one" {
		t.Fatalf("sent=%v marked=%v", q.sent, s.marked)
	}
}
