package queue

import (
	"blow-flow/api/internal/generation"
	"context"
	"fmt"
	"strings"
)

// attachReferences maps ordered media to the H3 graph contract shared by the
// built-in model and administrator configured video workflows.
func attachReferences(ctx context.Context, graph map[string]generation.WorkflowNode, mapping generation.WorkflowReferences, input generation.Input, frames int, uploader H3) error {
	target := graph[mapping.NodeID]
	for key := range target.Inputs {
		if strings.HasPrefix(key, "ref_images.") || strings.HasPrefix(key, "ref_videos.") || strings.HasPrefix(key, "ref_video_audios.") || strings.HasPrefix(key, "ref_audios.") {
			delete(target.Inputs, key)
		}
	}
	next := 1000
	for id := range graph {
		var numeric int
		if _, err := fmt.Sscanf(id, "%d", &numeric); err == nil && numeric >= next {
			next = numeric + 1
		}
	}
	counts := map[string]int{}
	for _, ref := range input.References {
		name, info, err := uploader.upload(ctx, ref)
		if err != nil {
			return err
		}
		loaderID, field, prefix := mapping.ImageLoader, "image", "ref_images.ref_image_"
		if ref.Kind == "video" {
			loaderID, field, prefix = mapping.VideoLoader, "video", "ref_videos.ref_video_"
		}
		if ref.Kind == "audio" {
			loaderID, field, prefix = mapping.AudioLoader, "audio", "ref_audios.ref_audio_"
		}
		source := graph[loaderID]
		inputs := make(map[string]any, len(source.Inputs)+5)
		for key, value := range source.Inputs {
			inputs[key] = value
		}
		source.Inputs = inputs
		source.Inputs[field] = name
		if ref.Kind == "video" {
			source.Inputs["force_rate"] = 24
			available := max(5, int(info.Duration*24))
			source.Inputs["frame_load_cap"] = min(frames, 5+17*((available-5)/17))
			source.Inputs["skip_first_frames"] = 0
			source.Inputs["select_every_nth"] = 1
		}
		id := fmt.Sprint(next)
		next++
		graph[id] = source
		index := counts[ref.Kind]
		counts[ref.Kind]++
		target.Inputs[prefix+fmt.Sprint(index)] = []any{id, 0}
		if ref.Kind == "video" && ref.UseAudio {
			target.Inputs["ref_video_audios.ref_video_audio_"+fmt.Sprint(index)] = []any{id, 2}
		}
	}
	graph[mapping.NodeID] = target
	return nil
}

func pruneReferenceGraph(graph map[string]generation.WorkflowNode, outputNode string) {
	keep := map[string]bool{}
	var visit func(string)
	visit = func(id string) {
		if keep[id] {
			return
		}
		node, ok := graph[id]
		if !ok {
			return
		}
		keep[id] = true
		for _, value := range node.Inputs {
			if edge, ok := value.([]any); ok && len(edge) == 2 {
				if child, ok := edge[0].(string); ok {
					visit(child)
				}
			}
		}
	}
	visit(outputNode)
	for id := range graph {
		if !keep[id] {
			delete(graph, id)
		}
	}
}
