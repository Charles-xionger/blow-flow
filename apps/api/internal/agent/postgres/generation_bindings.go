package postgres

import (
	"blow-flow/api/internal/generation"
	"encoding/json"
	"gorm.io/gorm"
)

func generationBinding(snapshot []byte, target string) (string, string, bool) {
	return generation.BindingDigest(snapshot, target)
}

func hasGenerationResult(snapshot []byte, target string) bool {
	var graph struct {
		Nodes []struct {
			ID   string `json:"id"`
			Data struct {
				ImageSrc        string            `json:"imageSrc"`
				VideoSrc        string            `json:"videoSrc"`
				OutputArtifacts []json.RawMessage `json:"outputArtifacts"`
			} `json:"data"`
		} `json:"nodes"`
	}
	if json.Unmarshal(snapshot, &graph) != nil {
		return false
	}
	for _, node := range graph.Nodes {
		if node.ID == target {
			return node.Data.ImageSrc != "" || node.Data.VideoSrc != "" || len(node.Data.OutputArtifacts) > 0
		}
	}
	return false
}

func ownedGenerationReferences(tx *gorm.DB, owner, project, target string, snapshot []byte, refs []generation.Reference) bool {
	if len(refs) == 0 {
		return true
	}
	var graph struct {
		Nodes []struct {
			ID   string         `json:"id"`
			Data map[string]any `json:"data"`
		} `json:"nodes"`
		Edges []struct {
			Source string `json:"source"`
			Target string `json:"target"`
		} `json:"edges"`
	}
	if json.Unmarshal(snapshot, &graph) != nil {
		return false
	}
	upstream := map[string]bool{target: true}
	for changed := true; changed; {
		changed = false
		for _, edge := range graph.Edges {
			if upstream[edge.Target] && !upstream[edge.Source] {
				upstream[edge.Source] = true
				changed = true
			}
		}
	}
	for _, ref := range refs {
		found := false
		for _, node := range graph.Nodes {
			if !upstream[node.ID] || node.ID == target {
				continue
			}
			for _, key := range []string{"imageSrc", "videoSrc", "audioSrc", "audioUrl", "url"} {
				if node.Data[key] == ref.URL {
					found = true
				}
			}
			if values, ok := node.Data["outputArtifacts"].([]any); ok {
				for _, value := range values {
					if value == ref.URL {
						found = true
					}
				}
			}
		}
		if !found {
			var count int64
			if err := tx.Raw(`SELECT count(*) FROM media_assets WHERE owner_id=? AND (project_id=? OR project_id IS NULL) AND kind=? AND url=?`, owner, project, ref.Kind, ref.URL).Scan(&count).Error; err != nil || count == 0 {
				return false
			}
		}
	}
	return true
}
