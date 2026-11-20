package postgres

import (
	"encoding/json"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// attachAgentResult runs in the delivery transaction. A failed canvas write
// leaves the provider result in the saving state for the existing save retry.
func attachAgentResult(tx *gorm.DB, taskID, url string, now time.Time) error {
	var task struct{ OwnerID, ProjectID, NodeID, Model string }
	q := tx.Raw(`SELECT owner_id,project_id,node_id,model FROM generation_tasks WHERE id=?`, taskID).Scan(&task)
	if q.Error != nil {
		return q.Error
	}
	if q.RowsAffected == 0 {
		return fmt.Errorf("generation task missing: %s", taskID)
	}
	var agentBatch bool
	if err := tx.Raw(`SELECT EXISTS(SELECT 1 FROM agent_generation_batches WHERE generation_task_ids @> ?::jsonb)`, fmt.Sprintf(`["%s"]`, taskID)).Scan(&agentBatch).Error; err != nil {
		return err
	}
	if !agentBatch {
		return nil
	}
	var existing int64
	if err := tx.Raw(`SELECT count(*) FROM agent_generation_attachments WHERE task_id=?`, taskID).Scan(&existing).Error; err != nil {
		return err
	}
	if existing != 0 {
		return nil
	}
	resultNode, note := task.NodeID, "结果已写回画布"
	var latest string
	latestRow := tx.Raw(`SELECT task_id FROM generation_node_results WHERE owner_id=? AND project_id=? AND node_id=?`, task.OwnerID, task.ProjectID, task.NodeID).Scan(&latest)
	if latestRow.Error != nil {
		return latestRow.Error
	}
	if latestRow.RowsAffected == 0 {
		resultNode, note = "", "目标节点已删除；产物保留在生成任务中。"
	} else if latest != taskID {
		resultNode, note = "", "已有较新的生成任务；产物保留在生成任务中。"
	} else {
		var project struct {
			Snapshot []byte
			Version  int64
		}
		q := tx.Raw(`SELECT snapshot,version FROM projects WHERE id=? AND owner_id=? AND deleted_at IS NULL AND purged_at IS NULL FOR UPDATE`, task.ProjectID, task.OwnerID).Scan(&project)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected == 0 {
			resultNode, note = "", "项目已删除；产物保留在生成任务中。"
		} else {
			var canvas map[string]any
			if err := json.Unmarshal(project.Snapshot, &canvas); err != nil {
				return err
			}
			nodes, ok := canvas["nodes"].([]any)
			if !ok {
				return fmt.Errorf("invalid project nodes")
			}
			index := -1
			for i, raw := range nodes {
				if node, ok := raw.(map[string]any); ok && node["id"] == task.NodeID {
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
					return fmt.Errorf("invalid target data")
				}
				outputField := "imageSrc"
				if task.Model == "runninghub/h3" {
					outputField = "videoSrc"
				}
				output := map[string]any{outputField: url, "outputArtifacts": []string{url}}
				if data["imageSrc"] != nil && data["imageSrc"] != "" || data["videoSrc"] != nil && data["videoSrc"] != "" || hasArtifacts(data["outputArtifacts"]) {
					id := task.NodeID + "-" + taskID
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
							if !ok || edge["target"] != task.NodeID {
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
				appendGenerationHistory(canvas, taskID, beforeNodes, beforeEdges, now)
				snapshot, err := json.Marshal(canvas)
				if err != nil {
					return err
				}
				if err := tx.Exec(`UPDATE projects SET snapshot=?::jsonb,version=version+1,node_count=?,updated_at=? WHERE id=? AND owner_id=?`, string(snapshot), len(canvas["nodes"].([]any)), now, task.ProjectID, task.OwnerID).Error; err != nil {
					return err
				}
			}
		}
	}
	return tx.Exec(`INSERT INTO agent_generation_attachments(task_id,node_id,note,attached_at) VALUES(?,?,?,?)`, taskID, resultNode, note, now).Error
}

func hasArtifacts(value any) bool { items, ok := value.([]any); return ok && len(items) > 0 }
func number(value any) float64    { n, _ := value.(float64); return n }

func copyJSON(value any) any {
	encoded, _ := json.Marshal(value)
	var copy any
	_ = json.Unmarshal(encoded, &copy)
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
