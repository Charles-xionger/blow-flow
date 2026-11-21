package queue

import (
	"blow-flow/api/internal/generation"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Seedream struct {
	BaseURL, APIKey string
	Client          *http.Client
}

func (p Seedream) Submit(ctx context.Context, input generation.Input) (string, error) {
	result, err := p.submit(ctx, input)
	return result.ID, err
}

func (p Seedream) submit(ctx context.Context, input generation.Input) (submissionResult, error) {
	if (input.Model != generation.Seedream55Model && input.Model != generation.Seedream50Model) || !generation.ValidInput(input) {
		return submissionResult{}, generation.ErrInvalid
	}
	if p.BaseURL == "" || p.APIKey == "" {
		return submissionResult{}, generation.ErrInvalid
	}
	images := make([]string, 0, len(input.References))
	for _, r := range input.References {
		body, filename, err := referenceBytes(ctx, p.Client, r)
		if err != nil {
			return submissionResult{}, generation.ErrSubmissionRejected
		}
		info, err := inspectReference(ctx, body, filename, "image")
		if err != nil {
			return submissionResult{}, generation.ErrSubmissionRejected
		}
		if input.Model == generation.Seedream50Model && input.ImageOptions != nil && input.ImageOptions.Background == "transparent" && !info.HasAlpha {
			return submissionResult{}, generation.ErrInvalid
		}
		images = append(images, r.URL)
	}
	format, optimize, background := "png", "standard", "opaque"
	watermark := false
	if o := input.ImageOptions; o != nil {
		if o.OutputFormat != "" {
			format = o.OutputFormat
		}
		if o.PromptOptimization != "" {
			optimize = o.PromptOptimization
		}
		if o.Background != "" {
			background = o.Background
		}
		watermark = o.Watermark
	}
	body := map[string]any{"model": input.Model, "prompt": input.Prompt, "size": fmt.Sprintf("%dx%d", input.Width, input.Height), "response_format": "url", "output_format": format, "watermark": watermark, "background": background, "optimize_prompt_options": map[string]string{"mode": optimize}}
	if len(images) > 0 {
		body["image"] = images
	}
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(p.BaseURL, "/")+"/api/v3/images/generations", bytes.NewReader(raw))
	if err != nil {
		return submissionResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.APIKey)
	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 180 * time.Second}
	}
	safe := *client
	safe.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := safe.Do(req)
	if err != nil {
		return submissionResult{}, ErrSubmissionUncertain
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case 400, 401, 403, 404, 422, 429:
		return submissionResult{}, fmt.Errorf("%w: HTTP %d", ErrSubmissionRejected, response.StatusCode)
	}
	if response.StatusCode != 200 {
		return submissionResult{}, ErrSubmissionUncertain
	}
	var reply struct {
		Data []struct {
			URL   string          `json:"url"`
			Size  string          `json:"size"`
			Error json.RawMessage `json:"error"`
		} `json:"data"`
		Usage json.RawMessage `json:"usage"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&reply) != nil {
		return submissionResult{}, ErrSubmissionUncertain
	}
	var size string
	var outputs int
	for _, image := range reply.Data {
		if image.URL != "" || (image.Size != "" && (len(image.Error) == 0 || string(image.Error) == "null")) {
			outputs++
			size = image.Size
		}
	}
	result := submissionResult{Usage: seedreamUsage(input.Model, reply.Usage, size, outputs, len(images) == 0)}
	if len(reply.Data) != 1 {
		return result, ErrSubmissionUncertain
	}
	u, err := url.Parse(reply.Data[0].URL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return result, ErrSubmissionUncertain
	}
	result.ID = "direct:" + format + ":" + reply.Data[0].URL
	return result, nil
}
