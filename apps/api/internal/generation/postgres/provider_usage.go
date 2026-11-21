package postgres

import (
	"blow-flow/api/internal/generation"
	"context"
	"encoding/json"

	"gorm.io/gorm"
)

func marshalProviderUsage(usage *generation.ProviderUsage) (*string, error) {
	if usage == nil {
		return nil, nil
	}
	body, err := json.Marshal(usage)
	raw := string(body)
	return &raw, err
}

func (s *Store) AdminTaskDetail(ctx context.Context, actor, id string) (generation.AdminTaskDetail, error) {
	var detail generation.AdminTaskDetail
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var task struct {
			ID, Model, ConnectionID, Status, Stage, FailureCode, UsageJSON string
		}
		query := tx.Raw(`SELECT id,model,connection_id,status,stage,COALESCE(failure_code,'') AS failure_code,COALESCE(provider_usage::text,'') AS usage_json FROM generation_tasks WHERE id=?`, id).Scan(&task)
		if query.Error != nil {
			return query.Error
		}
		if query.RowsAffected == 0 {
			return generation.ErrNotFound
		}
		detail = generation.AdminTaskDetail{ID: task.ID, Model: task.Model, ConnectionID: task.ConnectionID, Status: generation.Status(task.Status), Stage: task.Stage, FailureCode: task.FailureCode}
		if task.UsageJSON != "" {
			if err := json.Unmarshal([]byte(task.UsageJSON), &detail.Usage); err != nil {
				return err
			}
		}
		return tx.Exec(`INSERT INTO generation_admin_audit(actor_id,action,task_id) VALUES(?,'view_generation_task',?)`, actor, id).Error
	})
	return detail, err
}
