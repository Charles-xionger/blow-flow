package resource

import (
	"encoding/json"
	"strings"
)

type coverNode struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	Data struct {
		ImageSrc string          `json:"imageSrc"`
		VideoSrc json.RawMessage `json:"videoSrc"`
	} `json:"data"`
}

func coverImage(node coverNode) string {
	image := node.Data.ImageSrc
	if strings.Contains(strings.ToLower(node.Type), "video") || len(node.Data.VideoSrc) > 0 && string(node.Data.VideoSrc) != "null" && string(node.Data.VideoSrc) != `""` || strings.HasPrefix(image, "//") {
		return ""
	}
	lower := strings.ToLower(image)
	if strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "data:image/") || strings.HasPrefix(image, "/") {
		return image
	}
	return ""
}

// ProjectCover mirrors the existing workspace cover choice: prefer the latest
// changed generated image, then retain the prior cover if still present.
func ProjectCover(current, previous json.RawMessage, prior *string) (*string, error) {
	var now, old struct {
		Nodes []coverNode `json:"nodes"`
	}
	if err := json.Unmarshal(current, &now); err != nil {
		return nil, err
	}
	if len(previous) > 0 {
		if err := json.Unmarshal(previous, &old); err != nil {
			return nil, err
		}
	}
	previousImage := map[string]string{}
	for _, node := range old.Nodes {
		previousImage[node.ID] = coverImage(node)
	}
	var candidates []string
	var changed string
	var fallback string
	for _, node := range now.Nodes {
		image := coverImage(node)
		if image == "" {
			continue
		}
		if fallback == "" {
			fallback = image
		}
		if node.Type == "textToImage" || node.Type == "imageToImage" {
			candidates = append(candidates, image)
			if image != previousImage[node.ID] {
				changed = image
			}
		}
	}
	if changed != "" {
		return &changed, nil
	}
	if prior != nil {
		for _, image := range candidates {
			if image == *prior {
				return prior, nil
			}
		}
	}
	if len(candidates) > 0 {
		last := candidates[len(candidates)-1]
		return &last, nil
	}
	if fallback != "" {
		return &fallback, nil
	}
	return nil, nil
}
