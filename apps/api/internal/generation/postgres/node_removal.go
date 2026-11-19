package postgres

import (
	"time"

	"gorm.io/gorm"
)

// DetachRemovedNodes runs inside the project canvas transaction. It cancels
// requests that have not reached the provider and prevents a later delivery
// from attaching to a node that no longer exists. Submitted provider work is
// still tracked and its result remains available through the task record.
func DetachRemovedNodes(tx *gorm.DB, owner, project string, ids []string, now time.Time) error {
	if len(ids) == 0 {
		return nil
	}
	var canceled []string
	if err := tx.Raw(`UPDATE generation_tasks SET status='canceled',stage='canceled',updated_at=? WHERE owner_id=? AND project_id=? AND node_id IN ? AND status='queued' RETURNING id`, now, owner, project, ids).Scan(&canceled).Error; err != nil {
		return err
	}
	for _, id := range canceled {
		if err := tx.Exec(`INSERT INTO generation_task_events(task_id,event_type,stage,occurred_at) VALUES(?,'canceled','canceled',?)`, id, now).Error; err != nil {
			return err
		}
	}
	return tx.Exec(`DELETE FROM generation_node_results WHERE owner_id=? AND project_id=? AND node_id IN ?`, owner, project, ids).Error
}
