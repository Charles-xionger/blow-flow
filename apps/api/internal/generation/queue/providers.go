package queue

import (
	"blow-flow/api/internal/generation"
	"context"
	"os"
	"strings"
)

type Providers struct {
	RunningHub Krea2
	Seedream   Seedream
	Gemini     Gemini
}

func (p Providers) Submit(ctx context.Context, in generation.Input) (string, error) {
	switch generation.RouteForModel(in.Model) {
	case "runninghub-image":
		return p.RunningHub.Submit(ctx, in)
	case "runninghub-video":
		return (H3{p.RunningHub}).Submit(ctx, in)
	case "seedream":
		return p.Seedream.Submit(ctx, in)
	default:
		return p.submitWorkflow(ctx, in)
	}
}
func (p Providers) QueryInput(ctx context.Context, in generation.Input, id string) (Observation, error) {
	if in.Workflow == nil || !generation.ValidWorkflowInput(in) {
		return Observation{}, generation.ErrInvalid
	}
	m := in.Workflow
	return (Krea2{BaseURL: m.Connection.BaseURL, APIKey: os.Getenv(m.Connection.APIKeyEnv), Client: p.RunningHub.Client}).query(ctx, id, m.OutputNode, m.Category == "VIDEO")
}
func (p Providers) SubmitTask(ctx context.Context, taskID string, in generation.Input) (string, error) {
	if generation.RouteForModel(in.Model) == "gemini" {
		return p.Gemini.SubmitTask(ctx, taskID, in)
	}
	return p.Submit(ctx, in)
}
func (p Providers) Query(ctx context.Context, id string) (Observation, error) {
	return p.RunningHub.Query(ctx, id)
}
func (p Providers) QueryModel(ctx context.Context, model, id string) (Observation, error) {
	switch generation.RouteForModel(model) {
	case "runninghub-video":
		return (H3{p.RunningHub}).Query(ctx, id)
	case "seedream":
		parts := strings.SplitN(strings.TrimPrefix(id, "direct:"), ":", 2)
		if !strings.HasPrefix(id, "direct:") || len(parts) != 2 {
			return Observation{}, generation.ErrInvalid
		}
		return Observation{OutputURL: parts[1], FileType: parts[0]}, nil
	case "gemini":
		if !strings.HasPrefix(id, "inline:") || p.Gemini.Stage == nil {
			return Observation{}, generation.ErrInvalid
		}
		_, fileType, err := p.Gemini.Stage.InlineResult(ctx, strings.TrimPrefix(id, "inline:"))
		if err != nil {
			return Observation{}, err
		}
		if fileType != "png" && fileType != "jpeg" {
			return Observation{}, generation.ErrInvalid
		}
		return Observation{OutputURL: id, FileType: fileType}, nil
	default:
		return p.RunningHub.Query(ctx, id)
	}
}

type Artifacts struct {
	OSS   OSS
	Stage InlineStager
}

func (a Artifacts) Save(ctx context.Context, source, taskID, fileType string) (string, error) {
	if strings.HasPrefix(source, "inline:") {
		if a.Stage == nil || strings.TrimPrefix(source, "inline:") != taskID {
			return "", generation.ErrInvalid
		}
		body, storedType, err := a.Stage.InlineResult(ctx, taskID)
		if err != nil {
			return "", err
		}
		if fileType != storedType {
			return "", generation.ErrInvalid
		}
		return a.OSS.SaveBytes(ctx, taskID, fileType, body)
	}
	return a.OSS.Save(ctx, source, taskID, fileType)
}
func (p Providers) Watch(ctx context.Context, url string, emit func(Progress) error) error {
	return p.RunningHub.Watch(ctx, url, emit)
}
