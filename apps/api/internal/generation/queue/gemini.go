package queue

import (
	"blow-flow/api/internal/generation"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path"
	"strings"
	"time"
)

type InlineStager interface {
	StageInlineResult(context.Context, string, string, []byte) error
	InlineResult(context.Context, string) ([]byte, string, error)
}
type Gemini struct {
	BaseURL, APIKey string
	Client          *http.Client
	Stage           InlineStager
}

func (p Gemini) SubmitTask(ctx context.Context, taskID string, input generation.Input) (string, error) {
	if input.Model != generation.GeminiImageModel || !generation.ValidInput(input) || p.BaseURL == "" || p.APIKey == "" || p.Stage == nil {
		return "", generation.ErrInvalid
	}
	parts := []map[string]any{{"text": input.Prompt}}
	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 180 * time.Second}
	}
	safe := *client
	safe.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	for _, ref := range input.References {
		body, filename, err := referenceBytes(ctx, client, ref)
		if err != nil {
			return "", generation.ErrSubmissionRejected
		}
		if _, err := inspectReference(ctx, body, filename, "image"); err != nil {
			return "", generation.ErrSubmissionRejected
		}
		mime := "image/png"
		switch strings.ToLower(path.Ext(filename)) {
		case ".jpg", ".jpeg":
			mime = "image/jpeg"
		case ".webp":
			mime = "image/webp"
		}
		parts = append(parts, map[string]any{"inlineData": map[string]string{"mimeType": mime, "data": base64.StdEncoding.EncodeToString(body)}})
	}
	ratio := ""
	for _, r := range [][2]int{{1, 1}, {16, 9}, {9, 16}, {4, 3}, {3, 4}} {
		if input.Width*r[1] == input.Height*r[0] {
			ratio = fmt.Sprintf("%d:%d", r[0], r[1])
			break
		}
	}
	size := fmt.Sprintf("%dK", max(input.Width, input.Height)/1024)
	body, _ := json.Marshal(map[string]any{"contents": []any{map[string]any{"role": "user", "parts": parts}}, "generationConfig": map[string]any{"responseModalities": []string{"IMAGE"}, "imageConfig": map[string]string{"aspectRatio": ratio, "imageSize": size}}})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(p.BaseURL, "/")+"/v1beta/models/"+input.Model+":generateContent", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-goog-api-key", p.APIKey)
	res, err := safe.Do(req)
	if err != nil {
		return "", ErrSubmissionUncertain
	}
	defer res.Body.Close()
	switch res.StatusCode {
	case 400, 401, 403, 404, 422, 429:
		return "", fmt.Errorf("%w: HTTP %d", ErrSubmissionRejected, res.StatusCode)
	}
	if res.StatusCode != 200 {
		return "", ErrSubmissionUncertain
	}
	var reply struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					InlineData *struct {
						MimeType string `json:"mimeType"`
						Data     string `json:"data"`
					} `json:"inlineData"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 70<<20)).Decode(&reply) != nil {
		return "", ErrSubmissionUncertain
	}
	for _, candidate := range reply.Candidates {
		for _, part := range candidate.Content.Parts {
			if part.InlineData == nil {
				continue
			}
			kind := ""
			switch part.InlineData.MimeType {
			case "image/png":
				kind = "png"
			case "image/jpeg":
				kind = "jpeg"
			default:
				return "", ErrSubmissionUncertain
			}
			decoded, err := base64.StdEncoding.DecodeString(part.InlineData.Data)
			if err != nil || len(decoded) == 0 || len(decoded) > 50<<20 {
				return "", ErrSubmissionUncertain
			}
			if http.DetectContentType(decoded) != part.InlineData.MimeType {
				return "", ErrSubmissionUncertain
			}
			if err := p.Stage.StageInlineResult(ctx, taskID, kind, decoded); err != nil {
				return "", err
			}
			return "inline:" + taskID, nil
		}
	}
	return "", ErrSubmissionUncertain
}
