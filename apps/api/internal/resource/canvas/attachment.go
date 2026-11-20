package canvas

import (
	"bytes"
	"encoding/json"
	"fmt"
	"gorm.io/gorm"
	"time"
)

type Output struct {
	OwnerID, ProjectID, NodeID, TaskID, URL, Category string
	At                                                time.Time
}
type Attachment struct{ NodeID, Note string }

// AttachOutput is the resource-owned canvas operation inside the caller's delivery transaction.
func AttachOutput(tx *gorm.DB, input Output) (Attachment, error) {
	resultNode, note := input.NodeID, "结果已写回画布"
	now, url := input.At, input.URL
	var project struct {
		Snapshot []byte
		Version  int64
	}
	q := tx.Raw(`SELECT snapshot,version FROM projects WHERE id=? AND owner_id=? AND deleted_at IS NULL AND purged_at IS NULL FOR UPDATE`, input.ProjectID, input.OwnerID).Scan(&project)
	if q.Error != nil {
		return Attachment{}, q.Error
	}
	if q.RowsAffected == 0 {
		resultNode, note = "", "项目已删除；产物保留在生成任务中。"
	} else {
		var canvas map[string]any
		decoder := json.NewDecoder(bytes.NewReader(project.Snapshot))
		decoder.UseNumber()
		if err := decoder.Decode(&canvas); err != nil {
			return Attachment{}, err
		}
		nodes, ok := canvas["nodes"].([]any)
		if !ok {
			return Attachment{}, fmt.Errorf("invalid project nodes")
		}
		index := -1
		for i, raw := range nodes {
			if node, ok := raw.(map[string]any); ok && node["id"] == input.NodeID {
				index = i
				break
			}
		}
		if index < 0 {
			resultNode, note = "", "目标节点已删除；产物保留在生成任务中。"
		} else {
			beforeNodes := copyJSON(nodes)
			beforeEdges := copyJSON(canvas["edges"])
			target := nodes[index].(map[string]any)
			data, ok := target["data"].(map[string]any)
			if !ok {
				return Attachment{}, fmt.Errorf("invalid target data")
			}
			outputField := "imageSrc"
			if input.Category == "VIDEO" {
				outputField = "videoSrc"
			}
			output := map[string]any{outputField: url, "outputArtifacts": []string{url}}
			if data["imageSrc"] != nil && data["imageSrc"] != "" || data["videoSrc"] != nil && data["videoSrc"] != "" || hasArtifacts(data["outputArtifacts"]) {
				id := input.NodeID + "-" + input.TaskID
				if len(id) > 200 {
					id = id[:200]
				}
				variant := map[string]any{}
				for key, value := range target {
					variant[key] = value
				}
				variant["id"] = id
				variantData := map[string]any{}
				for key, value := range data {
					variantData[key] = value
				}
				for _, key := range []string{"imageSrc", "videoSrc", "outputArtifacts", "generationTaskId", "generationNodeId", "pendingGeneration", "generationStatus", "generationResultArtifacts"} {
					delete(variantData, key)
				}
				for key, value := range output {
					variantData[key] = value
				}
				variant["data"] = variantData
				pos, _ := target["position"].(map[string]any)
				x, y := number(pos["x"]), number(pos["y"])
				height := 400.0
				if style, ok := target["style"].(map[string]any); ok && number(style["height"]) > 0 {
					height = number(style["height"])
				}
				variant["position"] = map[string]any{"x": x, "y": y + height + 80}
				canvas["nodes"] = append(nodes, variant)
				if edges, ok := canvas["edges"].([]any); ok {
					for _, raw := range edges {
						edge, ok := raw.(map[string]any)
						if !ok || edge["target"] != input.NodeID {
							continue
						}
						copyEdge := map[string]any{}
						for key, value := range edge {
							copyEdge[key] = value
						}
						copyEdge["id"] = fmt.Sprint(edge["id"]) + ":" + id
						copyEdge["target"] = id
						edges = append(edges, copyEdge)
					}
					canvas["edges"] = edges
				}
				resultNode, note = id, "原节点已有结果，新结果写入下方新节点。"
			} else {
				for key, value := range output {
					data[key] = value
				}
			}
			appendGenerationHistory(canvas, input.TaskID, beforeNodes, beforeEdges, now)
			snapshot, err := json.Marshal(canvas)
			if err != nil {
				return Attachment{}, err
			}
			if err := tx.Exec(`UPDATE projects SET snapshot=?::jsonb,version=version+1,node_count=?,updated_at=? WHERE id=? AND owner_id=?`, string(snapshot), len(canvas["nodes"].([]any)), now, input.ProjectID, input.OwnerID).Error; err != nil {
				return Attachment{}, err
			}
		}
	}
	return Attachment{NodeID: resultNode, Note: note}, nil
}

func hasArtifacts(value any) bool { items, ok := value.([]any); return ok && len(items) > 0 }
func number(value any) float64 {
	switch n := value.(type) {
	case float64:
		return n
	case json.Number:
		v, _ := n.Float64()
		return v
	}
	return 0
}

func copyJSON(value any) any {
	encoded, _ := json.Marshal(value)
	var copy any
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	_ = decoder.Decode(&copy)
	return copy
}

func appendGenerationHistory(canvas map[string]any, taskID string, beforeNodes, beforeEdges any, now time.Time) {
	history, ok := canvas["history"].(map[string]any)
	if !ok || history["checkpoint"] == nil {
		return
	}
	records, okRecords := history["records"].([]any)
	undo, okUndo := history["undo"].([]any)
	_, okRedo := history["redo"].([]any)
	receipts, okReceipts := history["receipts"].([]any)
	if !okRecords || !okUndo || !okRedo || !okReceipts {
		return
	}
	id := "generation-output:" + taskID
	patches := []any{map[string]any{"op": "replace", "path": []any{"nodes"}, "value": canvas["nodes"]}, map[string]any{"op": "replace", "path": []any{"edges"}, "value": canvas["edges"]}}
	inverse := []any{map[string]any{"op": "replace", "path": []any{"nodes"}, "value": beforeNodes}, map[string]any{"op": "replace", "path": []any{"edges"}, "value": beforeEdges}}
	stamp := now.UnixMilli()
	label := "助手生成结果"
	history["records"] = append(records, map[string]any{"id": id, "label": label, "patches": patches, "inverse": inverse, "time": stamp})
	history["undo"] = append(undo, id)
	history["redo"] = []any{}
	history["receipts"] = append(receipts, id)
	operations, _ := history["operations"].([]any)
	history["operations"] = append(operations, map[string]any{"id": id, "batchId": id, "source": "agent", "kind": "edit", "label": label, "time": stamp, "patches": patches, "inverse": inverse})
}
