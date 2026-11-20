package generation

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
)

// BindingDigest identifies the content and connections that feed a target node.
// It deliberately excludes position, viewport and unrelated canvas content.
func BindingDigest(snapshot []byte, target string) (string, string, bool) {
	var graph struct {
		Nodes []struct {
			ID   string         `json:"id"`
			Type string         `json:"type"`
			Data map[string]any `json:"data"`
		} `json:"nodes"`
		Edges []struct {
			Source string `json:"source"`
			Target string `json:"target"`
		} `json:"edges"`
	}
	if json.Unmarshal(snapshot, &graph) != nil {
		return "", "", false
	}
	nodes := map[string]struct {
		Type string
		Data map[string]any
	}{}
	for _, node := range graph.Nodes {
		nodes[node.ID] = struct {
			Type string
			Data map[string]any
		}{node.Type, node.Data}
	}
	if _, ok := nodes[target]; !ok {
		return "", "", false
	}
	seen := map[string]bool{target: true}
	for changed := true; changed; {
		changed = false
		for _, edge := range graph.Edges {
			if seen[edge.Target] && !seen[edge.Source] {
				seen[edge.Source] = true
				changed = true
			}
		}
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	parts := make([]any, 0, len(ids)+1)
	for _, id := range ids {
		node, ok := nodes[id]
		if !ok {
			return "", "", false
		}
		parts = append(parts, []any{id, node.Type, node.Data})
	}
	connections := []string{}
	for _, edge := range graph.Edges {
		if seen[edge.Source] && seen[edge.Target] {
			connections = append(connections, edge.Source+"\x00"+edge.Target)
		}
	}
	sort.Strings(connections)
	parts = append(parts, connections)
	encoded, _ := json.Marshal(parts)
	hash := sha256.Sum256(encoded)
	mediaType := nodes[target].Type
	if value, ok := nodes[target].Data["type"].(string); ok {
		mediaType = value
	}
	return hex.EncodeToString(hash[:]), mediaType, true
}
