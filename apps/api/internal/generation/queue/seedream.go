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
	if (input.Model != generation.Seedream55Model && input.Model != generation.Seedream50Model) || !generation.ValidInput(input) {
		return "", generation.ErrInvalid
	}
	if p.BaseURL == "" || p.APIKey == "" {
		return "", generation.ErrInvalid
	}
	images := make([]string, 0, len(input.References))
	for _, r := range input.References {
		body, filename, err := referenceBytes(ctx, p.Client, r)
		if err != nil {
			return "", generation.ErrSubmissionRejected
		}
		info, err := inspectReference(ctx, body, filename, "image")
		if err != nil {
			return "", generation.ErrSubmissionRejected
		}
		if input.Model == generation.Seedream50Model && input.ImageOptions != nil && input.ImageOptions.Background == "transparent" && !info.HasAlpha {
			return "", generation.ErrInvalid
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
		return "", err
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
		return "", submissionTransportError(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return "", submissionHTTPError(response)
	}
	var reply struct {
		Data []struct {
			URL string `json:"url"`
		} `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&reply) != nil || len(reply.Data) != 1 {
		return "", ErrSubmissionUncertain
	}
	u, err := url.Parse(reply.Data[0].URL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
		return "", ErrSubmissionUncertain
	}
	return "direct:" + format + ":" + reply.Data[0].URL, nil
}
