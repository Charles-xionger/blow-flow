package generation

import (
	"net/url"
	"os"
	"strings"
)

const (
	Krea2Model       = "runninghub/krea2"
	H3Model          = "runninghub/h3"
	Seedream55Model  = "doubao-seedream-5-5-261028"
	Seedream50Model  = "doubao-seedream-5-0-pro-260628"
	GeminiImageModel = "gemini-3-pro-image-preview"
)

func ModelConfigured(model string) bool {
	switch model {
	case Krea2Model, H3Model:
		return os.Getenv("RUNNINGHUB_API_KEY") != "" && os.Getenv("RUNNINGHUB_BASE_URL") != ""
	case Seedream55Model, Seedream50Model:
		return os.Getenv("ARK_API_KEY") != ""
	case GeminiImageModel:
		return os.Getenv("GEMINI_API_KEY") != ""
	default:
		m, _, err := ResolveModel(model)
		return err == nil && os.Getenv(m.Connection.APIKeyEnv) != ""
	}
}
func ModelCategory(model string) string {
	if model == H3Model {
		return "VIDEO"
	}
	if ConnectionForModel(model) != "" {
		return "IMAGE"
	}
	m, _, err := ResolveModel(model)
	if err != nil {
		return ""
	}
	return m.Category
}

func ConnectionForModel(model string) string {
	switch model {
	case Krea2Model, H3Model:
		return "runninghub-international"
	case Seedream55Model, Seedream50Model:
		return "volcengine-ark"
	case GeminiImageModel:
		return "gemini-images"
	default:
		return ""
	}
}

func ValidInput(in Input) bool {
	if strings.TrimSpace(in.Prompt) == "" || len(in.Prompt) > 8000 || in.Seed < 0 || len(in.ReferenceIDs) != 0 {
		return false
	}
	counts := map[string]int{}
	for _, ref := range in.References {
		if ref.Kind != "image" && ref.Kind != "video" && ref.Kind != "audio" || !validReferenceURL(ref.URL) || (ref.UseAudio && ref.Kind != "video") {
			return false
		}
		counts[ref.Kind]++
	}
	switch in.Model {
	case Krea2Model:
		return dimensions(in, 64, 8192, 8) && in.Duration == 0 && len(in.References) == 0 && (in.InstanceType == "" || in.InstanceType == "plus") && in.ImageOptions == nil
	case H3Model:
		return dimensions(in, 32, 4096, 32) && in.Duration >= 5 && in.Duration <= 15 && (in.InstanceType == "" || in.InstanceType == "plus") && in.ImageOptions == nil && counts["image"] <= 9 && counts["video"] <= 3 && counts["audio"] <= 3
	case Seedream55Model, Seedream50Model:
		if in.Width < 16 || in.Height < 16 || in.Width > 8192 || in.Height > 8192 || in.Width*in.Height < 921600 || in.Width*in.Height > 4624220 || in.Width > 16*in.Height || in.Height > 16*in.Width || in.Duration != 0 || in.InstanceType != "" || counts["video"] != 0 || counts["audio"] != 0 || counts["image"] > 10 {
			return false
		}
		return validImageOptions(in)
	case GeminiImageModel:
		if !dimensions(in, 64, 8192, 8) || in.Duration != 0 || in.InstanceType != "" || in.ImageOptions != nil || counts["video"] != 0 || counts["audio"] != 0 || counts["image"] > 8 {
			return false
		}
		for _, ratio := range [][2]int{{1, 1}, {16, 9}, {9, 16}, {4, 3}, {3, 4}} {
			if in.Width*ratio[1] == in.Height*ratio[0] && (max(in.Width, in.Height) == 1024 || max(in.Width, in.Height) == 2048 || max(in.Width, in.Height) == 4096) {
				return true
			}
		}
		return false
	default:
		return ValidWorkflowInput(in)
	}
}

func dimensions(in Input, minValue, maxValue, step int) bool {
	return in.Width >= minValue && in.Width <= maxValue && in.Height >= minValue && in.Height <= maxValue && in.Width%step == 0 && in.Height%step == 0
}

func validReferenceURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path == "" || u.Path == "/" {
		return false
	}
	bucket, region := os.Getenv("OSS_BUCKET_NAME"), os.Getenv("OSS_REGION")
	return bucket != "" && region != "" && u.Host == bucket+"."+region+".aliyuncs.com"
}

func validImageOptions(in Input) bool {
	o := in.ImageOptions
	if o == nil {
		return true
	}
	if o.OutputFormat != "" && o.OutputFormat != "png" && o.OutputFormat != "jpeg" || o.Background != "" && o.Background != "opaque" && o.Background != "transparent" || o.PromptOptimization != "" && o.PromptOptimization != "standard" && o.PromptOptimization != "fast" {
		return false
	}
	if in.Model == Seedream55Model && o.PromptOptimization == "fast" {
		return false
	}
	if o.Background == "transparent" && o.OutputFormat == "jpeg" {
		return false
	}
	if in.Model == Seedream50Model && o.Background == "transparent" && len(in.References) != 1 {
		return false
	}
	return true
}
