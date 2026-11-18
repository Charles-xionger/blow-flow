package textmodel

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

var ErrModel = errors.New("text model unavailable")
var ErrIncomplete = errors.New("text model stream incomplete")

type Model struct {
	ID, Provider string
	Vision       bool
}
type PublicModel struct {
	ID        string `json:"id"`
	Provider  string `json:"provider"`
	Vision    bool   `json:"vision"`
	Available bool   `json:"available"`
}
type Client struct {
	HTTP                                 *http.Client
	ArkKey, GeminiKey, ArkURL, GeminiURL string
}
type Request struct {
	Model, Prompt string
	Images        []string
	JSON          bool
}
type Emit func(string) error

func FromEnv() *Client {
	return &Client{HTTP: &http.Client{Timeout: 10 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, ArkKey: os.Getenv("ARK_API_KEY"), GeminiKey: first(os.Getenv("GOOGLE_API_KEY"), os.Getenv("GEMINI_API_KEY")), ArkURL: first(os.Getenv("ARK_BASE_URL"), "https://ark.cn-beijing.volces.com/api/v3"), GeminiURL: first(os.Getenv("GEMINI_BASE_URL"), "https://generativelanguage.googleapis.com/v1beta")}
}
func first(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
func Lookup(id string) (Model, bool) {
	switch id {
	case "deepseek-v4-pro-ga-260813", "DeepSeek V4 Pro":
		return Model{"deepseek-v4-pro-ga-260813", "ark", false}, true
	case "doubao-seed-2-1-pro-260915", "Doubao Seed 2.1 Pro":
		return Model{"doubao-seed-2-1-pro-260915", "ark", true}, true
	case "gemini-3.8-flash", "Gemini 3.8 Flash":
		return Model{"gemini-3.8-flash", "gemini", true}, true
	case "gemini-4-argon", "Gemini 4 Argon":
		return Model{"gemini-4-argon", "gemini", true}, true
	case "gemini-3-flash-preview", "Gemini 3 Flash Preview":
		return Model{"gemini-3-flash-preview", "gemini", true}, true
	default:
		return Model{}, false
	}
}
func (c *Client) Validate(id string, images bool) error {
	m, ok := Lookup(id)
	if !ok || images && !m.Vision {
		return ErrModel
	}
	if m.Provider == "ark" && c.ArkKey == "" || m.Provider == "gemini" && c.GeminiKey == "" {
		return ErrModel
	}
	return nil
}
func (c *Client) Catalog() []PublicModel {
	ids := []string{"deepseek-v4-pro-ga-260813", "doubao-seed-2-1-pro-260915", "gemini-3.8-flash", "gemini-4-argon", "gemini-3-flash-preview"}
	result := make([]PublicModel, 0, len(ids))
	for _, id := range ids {
		m, _ := Lookup(id)
		result = append(result, PublicModel{ID: m.ID, Provider: m.Provider, Vision: m.Vision, Available: c.Validate(id, false) == nil})
	}
	return result
}
func (c *Client) Stream(ctx context.Context, r Request, emit Emit) error {
	m, ok := Lookup(r.Model)
	if !ok || c.Validate(r.Model, len(r.Images) > 0) != nil {
		return ErrModel
	}
	if c.HTTP == nil {
		c.HTTP = http.DefaultClient
	}
	var endpoint string
	var body any
	var keyHeader, key string
	if m.Provider == "ark" {
		endpoint = strings.TrimRight(c.ArkURL, "/") + "/responses"
		keyHeader = "Authorization"
		key = "Bearer " + c.ArkKey
		content := make([]any, 0, len(r.Images)+1)
		for _, u := range r.Images {
			content = append(content, map[string]any{"type": "input_image", "image_url": u})
		}
		content = append(content, map[string]any{"type": "input_text", "text": r.Prompt})
		body = map[string]any{"model": m.ID, "stream": true, "input": []any{map[string]any{"role": "user", "content": content}}}
		if r.JSON {
			body.(map[string]any)["thinking"] = map[string]string{"type": "disabled"}
			body.(map[string]any)["text"] = map[string]any{"format": map[string]string{"type": "json_object"}}
		}
	} else {
		endpoint = strings.TrimRight(c.GeminiURL, "/") + "/models/" + m.ID + ":streamGenerateContent?alt=sse"
		keyHeader = "x-goog-api-key"
		key = c.GeminiKey
		parts := []any{map[string]string{"text": r.Prompt}}
		for _, img := range r.Images {
			mime, data, err := parseImage(img)
			if err != nil {
				return err
			}
			parts = append(parts, map[string]any{"inline_data": map[string]string{"mime_type": mime, "data": data}})
		}
		body = map[string]any{"contents": []any{map[string]any{"role": "user", "parts": parts}}}
		if r.JSON {
			body.(map[string]any)["generationConfig"] = map[string]string{"responseMimeType": "application/json"}
		}
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(keyHeader, key)
	response, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("%w: provider HTTP %d", ErrModel, response.StatusCode)
	}
	return readSSE(response.Body, func(data []byte) error {
		var event struct {
			Type       string `json:"type"`
			Delta      string `json:"delta"`
			Candidates []struct {
				Content struct {
					Parts []struct {
						Text string `json:"text"`
					} `json:"parts"`
				} `json:"content"`
				FinishReason string `json:"finishReason"`
			} `json:"candidates"`
		}
		if json.Unmarshal(data, &event) != nil {
			return ErrIncomplete
		}
		if m.Provider == "ark" {
			switch event.Type {
			case "response.output_text.delta":
				return emit(event.Delta)
			case "response.completed":
				return errDone
			case "response.failed", "response.incomplete", "error":
				return ErrIncomplete
			}
			return nil
		}
		for _, candidate := range event.Candidates {
			for _, p := range candidate.Content.Parts {
				if p.Text != "" {
					if err := emit(p.Text); err != nil {
						return err
					}
				}
			}
			if candidate.FinishReason != "" {
				if candidate.FinishReason != "STOP" {
					return ErrIncomplete
				}
				return errDone
			}
		}
		return nil
	})
}

var errDone = errors.New("model stream complete")

func readSSE(reader io.Reader, handle func([]byte) error) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 16<<10), 4<<20)
	var data []string
	process := func() error {
		if len(data) == 0 {
			return nil
		}
		joined := strings.Join(data, "\n")
		data = nil
		if joined == "[DONE]" {
			return nil
		}
		return handle([]byte(joined))
	}
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			if err := process(); err != nil {
				if errors.Is(err, errDone) {
					return nil
				}
				return err
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if err := process(); err != nil {
		if errors.Is(err, errDone) {
			return nil
		}
		return err
	}
	return ErrIncomplete
}
func parseImage(value string) (string, string, error) {
	if !strings.HasPrefix(value, "data:image/") {
		return "", "", ErrModel
	}
	parts := strings.SplitN(value, ",", 2)
	if len(parts) != 2 || !strings.HasSuffix(parts[0], ";base64") {
		return "", "", ErrModel
	}
	mime := strings.TrimSuffix(strings.TrimPrefix(parts[0], "data:"), ";base64")
	if mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" {
		return "", "", ErrModel
	}
	if len(parts[1]) > 14<<20 {
		return "", "", ErrModel
	}
	if _, err := base64.StdEncoding.DecodeString(parts[1]); err != nil {
		return "", "", ErrModel
	}
	return mime, parts[1], nil
}
