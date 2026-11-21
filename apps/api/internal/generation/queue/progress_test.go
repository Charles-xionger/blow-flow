package queue

import (
	"context"
	"fmt"
	"github.com/gorilla/websocket"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestKrea2QueryUsesOriginalTaskAndVerifiesOutput(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/task/openapi/outputs" {
			t.Errorf("path=%s", r.URL.Path)
		}
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), `"taskId":"original"`) {
			t.Errorf("body=%s", body)
		}
		calls++
		if calls == 1 {
			_, _ = w.Write([]byte(`{"code":0,"data":{"netWssUrl":"wss://example.test/ws"}}`))
		} else if calls <= 3 {
			_, _ = w.Write([]byte(`{"code":0,"data":[{"fileUrl":"https://example.test/result.png","fileType":"png","nodeId":"103","consumeCoins":"17"},{"fileUrl":"https://example.test/result.mp4","fileType":"mp4","nodeId":"148","chargedPoint":"1.28","consumeMoney":null,"settleMode":"POINT","apiKey":"secret"}]}`))
		} else {
			_, _ = w.Write([]byte(`{"code":0,"data":[{"fileUrl":"invalid","fileType":"mp4","nodeId":"148","chargedPoint":"1.28"}]}`))
		}
	}))
	defer server.Close()
	p := Krea2{BaseURL: server.URL, APIKey: "key", Client: server.Client()}
	first, err := p.Query(context.Background(), "original")
	if err != nil || first.WSSURL == "" || first.OutputURL != "" {
		t.Fatalf("first=%+v %v", first, err)
	}
	second, err := p.Query(context.Background(), "original")
	if err != nil || second.OutputURL != "https://example.test/result.png" || second.Usage != nil {
		t.Fatalf("second=%+v %v", second, err)
	}
	video, err := (H3{p}).Query(context.Background(), "original")
	if err != nil || video.OutputURL != "https://example.test/result.mp4" || video.Usage == nil ||
		string(video.Usage.Fields["chargedPoint"]) != `"1.28"` || string(video.Usage.Fields["consumeMoney"]) != "null" ||
		video.Usage.Amount != "" || len(video.Usage.Fields) != 3 {
		t.Fatalf("H3 result=%+v usage=%+v error=%v", video, video.Usage, err)
	}
	invalid, err := (H3{p}).Query(context.Background(), "original")
	if err == nil || invalid.OutputURL != "" || invalid.Usage == nil || string(invalid.Usage.Fields["chargedPoint"]) != `"1.28"` {
		t.Fatalf("H3 invalid output=%+v usage=%+v error=%v", invalid, invalid.Usage, err)
	}
}

func TestKrea2WatchAcceptsOnlyVerifiedStepProgress(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		for _, msg := range []string{`{"type":"progress","data":{"node":"10","value":50,"max":100}}`, `{"type":"progress","data":{"node":"10","value":110,"max":100}}`, `{"type":"execution_success","data":{}}`} {
			if err := conn.WriteMessage(websocket.TextMessage, []byte(msg)); err != nil {
				t.Error(err)
				return
			}
		}
	}))
	defer server.Close()
	var got []Progress
	err := (Krea2{}).Watch(context.Background(), "ws"+strings.TrimPrefix(server.URL, "http"), func(p Progress) error { got = append(got, p); return nil })
	if err != nil || len(got) != 2 || got[0].Percent == nil || *got[0].Percent != 50 || !got[1].Completed {
		t.Fatalf("events=%+v err=%v", got, err)
	}
}

func TestKrea2QueryClassifiesDocumentedQueuedRunningAndFailedCodes(t *testing.T) {
	code := 813
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(fmt.Sprintf(`{"code":%d}`, code))) }))
	defer server.Close()
	p := Krea2{BaseURL: server.URL, APIKey: "key", Client: server.Client()}
	for _, tc := range []struct {
		code   int
		stage  string
		failed bool
	}{{813, "waiting_provider", false}, {804, "generating", false}, {805, "", true}} {
		code = tc.code
		got, err := p.Query(context.Background(), "original")
		if err != nil || got.Stage != tc.stage || got.Failed != tc.failed {
			t.Fatalf("code %d: %+v %v", code, got, err)
		}
	}
}
