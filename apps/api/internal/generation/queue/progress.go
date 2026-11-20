package queue

import (
	"blow-flow/api/internal/generation"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

type Observation struct {
	WSSURL    string
	OutputURL string
	FileType  string
	Failed    bool
	Stage     string
}
type Progress struct {
	Stage     string
	Percent   *float64
	Completed bool
}

// Query is authoritative for output. The socket can only suggest that this query is due.
func (p Krea2) Query(ctx context.Context, taskID string) (Observation, error) {
	return p.query(ctx, taskID, "103", false)
}
func (p H3) Query(ctx context.Context, taskID string) (Observation, error) {
	return p.Krea2.query(ctx, taskID, "148", true)
}
func (p Krea2) query(ctx context.Context, taskID, outputNode string, video bool) (Observation, error) {
	if taskID == "" || p.BaseURL == "" || p.APIKey == "" {
		return Observation{}, generation.ErrInvalid
	}
	body, _ := json.Marshal(map[string]string{"apiKey": p.APIKey, "taskId": taskID})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(p.BaseURL, "/")+"/task/openapi/outputs", bytes.NewReader(body))
	if err != nil {
		return Observation{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.APIKey)
	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	safe := *client
	safe.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := safe.Do(req)
	if err != nil {
		return Observation{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return Observation{}, fmt.Errorf("runninghub outputs HTTP %d", res.StatusCode)
	}
	var reply struct {
		Code int             `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&reply); err != nil {
		return Observation{}, err
	}
	if reply.Code == 804 {
		return Observation{Stage: "generating"}, nil
	}
	if reply.Code == 813 {
		return Observation{Stage: "waiting_provider"}, nil
	}
	if reply.Code == 805 {
		return Observation{Failed: true}, nil
	}
	if reply.Code != 0 {
		return Observation{}, fmt.Errorf("runninghub outputs code %d", reply.Code)
	}
	var files []struct {
		FileURL  string `json:"fileUrl"`
		FileType string `json:"fileType"`
		NodeID   string `json:"nodeId"`
	}
	if len(reply.Data) > 0 && reply.Data[0] == '[' {
		if err := json.Unmarshal(reply.Data, &files); err != nil {
			return Observation{}, err
		}
		var output *struct {
			FileURL  string `json:"fileUrl"`
			FileType string `json:"fileType"`
			NodeID   string `json:"nodeId"`
		}
		for i := range files {
			if files[i].NodeID == outputNode {
				output = &files[i]
				break
			}
		}
		if output == nil || output.FileURL == "" {
			return Observation{}, errors.New("runninghub returned empty result")
		}
		u, err := url.Parse(output.FileURL)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			return Observation{}, errors.New("runninghub returned invalid result URL")
		}
		if (!video && output.FileType != "png" && output.FileType != "jpg" && output.FileType != "jpeg") || (video && output.FileType != "mp4" && output.FileType != "video/mp4") {
			return Observation{}, errors.New("runninghub returned unsupported image format")
		}
		fileType := output.FileType
		if video {
			fileType = "mp4"
		}
		return Observation{OutputURL: output.FileURL, FileType: fileType}, nil
	}
	var pending struct {
		NetWSSURL  string `json:"netWssUrl"`
		TaskStatus string `json:"taskStatus"`
	}
	if len(reply.Data) > 0 && reply.Data[0] == '{' {
		if err := json.Unmarshal(reply.Data, &pending); err != nil {
			return Observation{}, err
		}
	}
	if pending.TaskStatus == "FAILED" {
		return Observation{Failed: true}, nil
	}
	if pending.NetWSSURL != "" {
		u, err := url.Parse(pending.NetWSSURL)
		if err == nil && (u.Scheme == "wss" || u.Scheme == "ws") && u.Host != "" {
			return Observation{WSSURL: pending.NetWSSURL, Stage: "generating"}, nil
		}
	}
	return Observation{}, nil
}

// Watch reads a bounded socket window. A missing socket or a disconnect never decides task outcome.
func (p Krea2) Watch(ctx context.Context, socketURL string, emit func(Progress) error) error {
	u, err := url.Parse(socketURL)
	if err != nil || (u.Scheme != "wss" && u.Scheme != "ws") || u.Host == "" {
		return errors.New("invalid runninghub socket URL")
	}
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	conn, _, err := dialer.DialContext(ctx, socketURL, nil)
	if err != nil {
		return err
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		var msg struct {
			Type string `json:"type"`
			Data struct {
				Node  string  `json:"node"`
				Value float64 `json:"value"`
				Max   float64 `json:"max"`
			} `json:"data"`
		}
		if json.Unmarshal(raw, &msg) != nil {
			continue
		}
		progress := Progress{}
		switch msg.Type {
		case "progress":
			if msg.Data.Max <= 0 || msg.Data.Value < 0 || msg.Data.Value > msg.Data.Max {
				continue
			}
			value := 100 * msg.Data.Value / msg.Data.Max
			progress.Stage = "generating"
			progress.Percent = &value
		case "executing", "execution_cached":
			progress.Stage = "generating"
		case "execution_success":
			progress.Stage = "generating"
			progress.Completed = true
		default:
			continue
		}
		if err := emit(progress); err != nil {
			return err
		}
		if progress.Completed {
			return nil
		}
		_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	}
}
