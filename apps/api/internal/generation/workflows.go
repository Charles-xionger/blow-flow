package generation

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
)

// WorkflowSnapshot is an admin-configured model and connection frozen when an
// approval is prepared. It contains no credential value, only an env key name.
type WorkflowSnapshot struct {
	ID           string                   `json:"id"`
	Name         string                   `json:"name"`
	Category     string                   `json:"category"`
	Adapter      string                   `json:"adapter"`
	Version      string                   `json:"version"`
	ConnectionID string                   `json:"connectionId"`
	WorkflowID   string                   `json:"workflowId"`
	Workflow     map[string]WorkflowNode  `json:"workflow"`
	OutputNode   string                   `json:"outputNode"`
	Mapping      map[string]WorkflowField `json:"mapping"`
	References   *WorkflowReferences      `json:"references,omitempty"`
	Capabilities WorkflowCapabilities     `json:"capabilities"`
	Connection   WorkflowConnection       `json:"connection"`
	Digest       string                   `json:"digest"`
}
type WorkflowNode struct {
	Inputs    map[string]any `json:"inputs"`
	ClassType string         `json:"class_type"`
}
type WorkflowField struct {
	NodeID    string `json:"nodeId"`
	FieldName string `json:"fieldName"`
}
type WorkflowReferences struct {
	NodeID      string `json:"nodeId"`
	ImageLoader string `json:"imageLoader"`
	VideoLoader string `json:"videoLoader"`
	AudioLoader string `json:"audioLoader"`
}
type WorkflowDimensions struct {
	Min           int `json:"min"`
	Max           int `json:"max"`
	Step          int `json:"step"`
	DefaultWidth  int `json:"defaultWidth"`
	DefaultHeight int `json:"defaultHeight"`
}
type WorkflowVideo struct {
	MinDuration     int `json:"minDuration"`
	MaxDuration     int `json:"maxDuration"`
	DefaultDuration int `json:"defaultDuration"`
	FPS             int `json:"fps"`
	MaxImages       int `json:"maxImages"`
	MaxVideos       int `json:"maxVideos"`
	MaxAudios       int `json:"maxAudios"`
}
type WorkflowCapabilities struct {
	Prompt          bool               `json:"prompt"`
	ReferenceImages bool               `json:"referenceImages"`
	Dimensions      WorkflowDimensions `json:"dimensions"`
	Video           *WorkflowVideo     `json:"video,omitempty"`
}
type WorkflowConnection struct {
	ID               string `json:"id"`
	BaseURL          string `json:"baseUrl"`
	APIKeyEnv        string `json:"apiKeyEnv"`
	Concurrency      int    `json:"concurrency"`
	RequestTimeoutMS int    `json:"requestTimeoutMs"`
	PollIntervalMS   int    `json:"pollIntervalMs"`
	QueryTimeoutMS   int    `json:"queryTimeoutMs"`
	MaxQueryErrors   int    `json:"maxQueryErrors"`
}

type workflowConfig struct {
	Connections []WorkflowConnection `json:"connections"`
	Models      []WorkflowSnapshot   `json:"models"`
}

func ResolveModel(modelID string) (*WorkflowSnapshot, string, error) {
	path := os.Getenv("GENERATION_CONFIG_PATH")
	if path == "" {
		return nil, "", ErrInvalid
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, "", err
	}
	var config workflowConfig
	if err = json.Unmarshal(raw, &config); err != nil {
		return nil, "", err
	}
	for _, m := range config.Models {
		if m.ID != modelID {
			continue
		}
		for _, c := range config.Connections {
			if c.ID == m.ConnectionID {
				m.Connection = c
				if !validWorkflowSnapshot(&m) {
					return nil, "", ErrInvalid
				}
				digest, err := workflowDigest(m)
				if err != nil {
					return nil, "", err
				}
				m.Digest = digest
				return &m, digest, nil
			}
		}
		return nil, "", ErrInvalid
	}
	return nil, "", ErrInvalid
}
func workflowDigest(m WorkflowSnapshot) (string, error) {
	m.Digest = ""
	b, err := json.Marshal(m)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}
func validWorkflowSnapshot(m *WorkflowSnapshot) bool {
	if m == nil || m.ID == "" || m.Version == "" || m.Adapter != "runninghub-workflow" || (m.Category != "IMAGE" && m.Category != "VIDEO") || m.WorkflowID == "" || m.Connection.ID == "" || m.Connection.ID != m.ConnectionID || m.Connection.BaseURL == "" || m.Connection.APIKeyEnv == "" || m.Connection.Concurrency < 1 || m.Connection.RequestTimeoutMS < 1 || m.Connection.PollIntervalMS < 1 || m.Connection.QueryTimeoutMS < 1 || m.Connection.MaxQueryErrors < 1 {
		return false
	}
	if !strings.HasPrefix(m.Connection.BaseURL, "https://") && !strings.HasPrefix(m.Connection.BaseURL, "http://") {
		return false
	}
	if len(m.Workflow) == 0 || len(m.Workflow) > 5000 || m.Workflow[m.OutputNode].Inputs == nil || !m.Capabilities.Prompt {
		return false
	}
	d := m.Capabilities.Dimensions
	if d.Min < 1 || d.Max < d.Min || d.Max > 8192 || d.Step < 1 || d.DefaultWidth < d.Min || d.DefaultHeight < d.Min {
		return false
	}
	for _, key := range []string{"prompt", "width", "height", "seed"} {
		f, ok := m.Mapping[key]
		if !ok || f.NodeID == "" || f.FieldName == "" {
			return false
		}
		n, ok := m.Workflow[f.NodeID]
		if !ok {
			return false
		}
		if _, ok = n.Inputs[f.FieldName]; !ok {
			return false
		}
	}
	if m.Category == "VIDEO" {
		v := m.Capabilities.Video
		if v == nil || v.MinDuration < 1 || v.MaxDuration < v.MinDuration || v.FPS < 1 || m.References == nil {
			return false
		}
		f, ok := m.Mapping["duration"]
		if !ok {
			return false
		}
		n, ok := m.Workflow[f.NodeID]
		if !ok {
			return false
		}
		if _, ok = n.Inputs[f.FieldName]; !ok {
			return false
		}
	} else if m.Capabilities.Video != nil || m.References != nil {
		return false
	}
	var scan func(any) bool
	scan = func(value any) bool {
		switch x := value.(type) {
		case map[string]any:
			for k, v := range x {
				lower := strings.ToLower(k)
				if strings.Contains(lower, "api_key") || strings.Contains(lower, "token") || strings.Contains(lower, "password") || strings.Contains(lower, "secret") || strings.Contains(lower, "authorization") || !scan(v) {
					return false
				}
			}
		case []any:
			for _, v := range x {
				if !scan(v) {
					return false
				}
			}
		}
		return true
	}
	for _, n := range m.Workflow {
		if !scan(n.Inputs) {
			return false
		}
	}
	return true
}
func ValidWorkflowInput(in Input) bool {
	m := in.Workflow
	if !validWorkflowSnapshot(m) || m.ID != in.Model || m.Digest == "" {
		return false
	}
	digest, err := workflowDigest(*m)
	if err != nil || digest != m.Digest {
		return false
	}
	d := m.Capabilities.Dimensions
	if in.Width < d.Min || in.Width > d.Max || in.Height < d.Min || in.Height > d.Max || in.Width%d.Step != 0 || in.Height%d.Step != 0 || in.ImageOptions != nil {
		return false
	}
	if m.Category == "IMAGE" {
		return in.Duration == 0 && len(in.References) == 0
	}
	v := m.Capabilities.Video
	counts := map[string]int{}
	for _, r := range in.References {
		counts[r.Kind]++
	}
	return in.Duration >= v.MinDuration && in.Duration <= v.MaxDuration && counts["image"] <= v.MaxImages && counts["video"] <= v.MaxVideos && counts["audio"] <= v.MaxAudios
}
func ModelConfigured(modelID string) bool {
	if ConnectionForModel(modelID) != "" {
		return true
	}
	m, _, err := ResolveModel(modelID)
	return err == nil && os.Getenv(m.Connection.APIKeyEnv) != ""
}
func ModelCategory(modelID string) string {
	switch modelID {
	case Krea2Model, Seedream55Model, Seedream50Model, GeminiImageModel:
		return "IMAGE"
	case H3Model:
		return "VIDEO"
	}
	m, _, err := ResolveModel(modelID)
	if err != nil {
		return ""
	}
	return m.Category
}

var ErrInvalidWorkflow = errors.New("invalid workflow snapshot")
