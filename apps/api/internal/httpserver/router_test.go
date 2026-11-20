package httpserver

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthDistinguishesLiveFromReady(t *testing.T) {
	for _, tc := range []struct {
		name string
		ping func(context.Context) error
		want int
	}{
		{"not configured", nil, http.StatusServiceUnavailable},
		{"unreachable", func(context.Context) error { return errors.New("postgres://secret") }, http.StatusServiceUnavailable},
		{"ready", func(context.Context) error { return nil }, http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			router := New(tc.ping)
			for path, want := range map[string]int{"/health/live": 200, "/health/ready": tc.want} {
				w := httptest.NewRecorder()
				req := httptest.NewRequest("GET", path, nil)
				req.Header.Set("X-Request-ID", "untrusted\nvalue")
				router.ServeHTTP(w, req)
				if w.Code != want {
					t.Fatalf("%s: got %d, want %d", path, w.Code, want)
				}
				if w.Header().Get("X-Request-ID") == "" {
					t.Fatal("missing request id")
				}
				if strings.Contains(w.Body.String(), "secret") {
					t.Fatal("leaked dependency credentials")
				}
			}
		})
	}
}

func TestReadinessReportsDependencyFailuresWithoutLeakingErrors(t *testing.T) {
	router := NewWithDependencies(Dependencies{ReadinessChecks: map[string]Ping{
		"postgres": func(context.Context) error { return nil },
		"rabbitmq": func(context.Context) error { return errors.New("amqp://secret") },
		"redis":    nil,
	}})
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/health/ready", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d, want 503", w.Code)
	}
	if got := w.Body.String(); !strings.Contains(got, `"rabbitmq":"unavailable"`) || !strings.Contains(got, `"redis":"unavailable"`) || !strings.Contains(got, `"postgres":"ready"`) || strings.Contains(got, "secret") {
		t.Fatalf("unexpected readiness response: %s", got)
	}
}
