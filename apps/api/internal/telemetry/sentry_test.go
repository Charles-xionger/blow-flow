package telemetry

import (
	"context"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
)

type recorder struct{ events []*sentry.Event }

func (r *recorder) Flush(time.Duration) bool              { return true }
func (r *recorder) FlushWithContext(context.Context) bool { return true }
func (r *recorder) Configure(sentry.ClientOptions)        {}
func (r *recorder) SendEvent(e *sentry.Event)             { r.events = append(r.events, e) }
func (r *recorder) Close()                                {}

func TestSentryTransportReceivesOnlySanitizedError(t *testing.T) {
	transport := &recorder{}
	client, err := sentry.NewClient(sentry.ClientOptions{Dsn: "https://public@example.invalid/1", Transport: transport, BeforeSend: Scrub})
	if err != nil {
		t.Fatal(err)
	}
	hub := sentry.NewHub(client, sentry.NewScope())
	hub.CaptureEvent(&sentry.Event{Message: "secret prompt", User: sentry.User{Email: "private@test"},
		Extra: map[string]any{"token": "secret"}, Tags: map[string]string{"request_id": "123", "prompt": "secret"},
		Exception: []sentry.Exception{{Type: "TestError", Value: "secret", Stacktrace: &sentry.Stacktrace{Frames: []sentry.Frame{{Function: "test"}}}}},
	})
	if len(transport.events) != 1 {
		t.Fatalf("got %d events", len(transport.events))
	}
	event := transport.events[0]
	if event.Message != "" || event.User.Email != "" || len(event.Extra) != 0 || event.Exception[0].Value != "[redacted]" {
		t.Fatal("private content exported")
	}
	if event.Tags["request_id"] != "123" || len(event.Tags) != 1 || event.Exception[0].Stacktrace == nil {
		t.Fatal("diagnostic context lost")
	}
}
