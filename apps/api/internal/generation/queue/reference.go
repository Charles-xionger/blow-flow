package queue

import (
	"blow-flow/api/internal/generation"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"time"
)

type referenceInfo struct {
	Duration           float64
	HasAlpha, HasAudio bool
}
type probeStream struct {
	CodecType string `json:"codec_type"`
	CodecName string `json:"codec_name"`
	PixFmt    string `json:"pix_fmt"`
	Duration  string `json:"duration"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
}

func referenceBytes(ctx context.Context, client *http.Client, ref generation.Reference) ([]byte, string, error) {
	u, err := url.Parse(ref.URL)
	if err != nil {
		return nil, "", generation.ErrInvalid
	}
	ext := strings.ToLower(strings.TrimPrefix(path.Ext(u.Path), "."))
	allowed := map[string][]string{"image": {"png", "jpg", "jpeg", "webp"}, "video": {"mp4", "avi", "mov", "mkv"}, "audio": {"mp3", "wav", "flac"}}
	valid := false
	for _, v := range allowed[ref.Kind] {
		if v == ext {
			valid = true
		}
	}
	if !valid {
		return nil, "", generation.ErrInvalid
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, ref.URL, nil)
	if err != nil {
		return nil, "", err
	}
	if client == nil {
		client = &http.Client{Timeout: 60 * time.Second}
	}
	safe := *client
	safe.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := safe.Do(request)
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, "", errors.New("reference download failed")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, (30<<20)+1))
	if err != nil {
		return nil, "", err
	}
	if len(body) == 0 || len(body) > 30<<20 {
		return nil, "", generation.ErrInvalid
	}
	return body, path.Base(u.Path), nil
}
func inspectReference(ctx context.Context, body []byte, filename, kind string) (referenceInfo, error) {
	dir, err := os.MkdirTemp("", "generation-reference-")
	if err != nil {
		return referenceInfo{}, err
	}
	defer os.RemoveAll(dir)
	file := filepath.Join(dir, "input"+path.Ext(filename))
	if err := os.WriteFile(file, body, 0600); err != nil {
		return referenceInfo{}, err
	}
	probeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	binary := os.Getenv("FFPROBE_PATH")
	if binary == "" {
		binary = "ffprobe"
	}
	output, err := exec.CommandContext(probeCtx, binary, "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", file).Output()
	if err != nil {
		return referenceInfo{}, errors.New("reference media probe failed")
	}
	var info struct {
		Streams []probeStream `json:"streams"`
		Format  struct {
			Duration   string `json:"duration"`
			FormatName string `json:"format_name"`
		} `json:"format"`
	}
	if len(output) > 256<<10 || json.Unmarshal(output, &info) != nil {
		return referenceInfo{}, generation.ErrInvalid
	}
	result := referenceInfo{}
	var visual *probeStream
	for i := range info.Streams {
		stream := &info.Streams[i]
		if stream.CodecType == "audio" {
			result.HasAudio = true
		}
		if stream.CodecType == "video" && visual == nil {
			visual = stream
		}
	}
	if kind == "audio" && !result.HasAudio || kind != "audio" && visual == nil {
		return referenceInfo{}, generation.ErrInvalid
	}
	if kind == "image" {
		if visual.Width <= 14 || visual.Height <= 14 || visual.Width*visual.Height > 36_000_000 || visual.Width > 16*visual.Height || visual.Height > 16*visual.Width {
			return referenceInfo{}, generation.ErrInvalid
		}
		switch visual.CodecName {
		case "png", "mjpeg", "webp":
		default:
			return referenceInfo{}, generation.ErrInvalid
		}
		pix := strings.ToLower(visual.PixFmt)
		result.HasAlpha = strings.Contains(pix, "rgba") || strings.Contains(pix, "yuva") || strings.Contains(pix, "ya8")
		if strings.EqualFold(path.Ext(filename), ".png") {
			decoded, err := png.Decode(bytes.NewReader(body))
			if err != nil {
				return referenceInfo{}, generation.ErrInvalid
			}
			if opacity, ok := decoded.(interface{ Opaque() bool }); ok {
				result.HasAlpha = !opacity.Opaque()
			}
		}
	}
	if kind == "video" {
		raw := visual.Duration
		if raw == "" {
			raw = info.Format.Duration
		}
		if _, err := fmt.Sscan(raw, &result.Duration); err != nil || result.Duration < 5.0/24 || result.Duration > 15.1 {
			return referenceInfo{}, generation.ErrInvalid
		}
	}
	return result, nil
}
