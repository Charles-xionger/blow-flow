package postgres

import (
	"blow-flow/api/internal/generation"
	"blow-flow/api/internal/resource/canvas"
	"encoding/json"
	"fmt"
	"time"

	"gorm.io/gorm"
)

// attachAgentResult runs in the delivery transaction. A failed canvas write
// leaves the provider result in the saving state for the existing save retry.
func attachAgentResult(tx *gorm.DB, taskID, url string, now time.Time) error {
	var task struct {
		OwnerID, ProjectID, NodeID, Model string
		InputSnapshot                     []byte
	}
	q := tx.Raw(`SELECT owner_id,project_id,node_id,model,input_snapshot FROM generation_tasks WHERE id=?`, taskID).Scan(&task)
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
	var frozen generation.Input
	if err := json.Unmarshal(task.InputSnapshot, &frozen); err != nil {
		return fmt.Errorf("invalid frozen generation input: %w", err)
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
		attachment, err := canvas.AttachOutput(tx, canvas.Output{OwnerID: task.OwnerID, ProjectID: task.ProjectID, NodeID: task.NodeID, TaskID: taskID, URL: url, Category: generation.CategoryForInput(frozen), At: now})
		if err != nil {
			return err
		}
		resultNode, note = attachment.NodeID, attachment.Note
	}
	return tx.Exec(`INSERT INTO agent_generation_attachments(task_id,node_id,note,attached_at) VALUES(?,?,?,?)`, taskID, resultNode, note, now).Error
}
