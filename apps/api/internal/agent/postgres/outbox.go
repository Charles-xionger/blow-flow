package postgres

import (
	"context"
	"time"
)

func (s *Store) Unpublished(ctx context.Context) ([]string, error) {
	var ids []string
	err := s.DB.WithContext(ctx).Raw(`SELECT o.task_id FROM agent_outbox o JOIN agent_tasks t ON t.id=o.task_id WHERE o.published_at IS NULL AND t.status='queued' ORDER BY o.created_at LIMIT 100`).Scan(&ids).Error
	return ids, err
}
func (s *Store) MarkPublished(ctx context.Context, id string) error {
	return s.DB.WithContext(ctx).Exec(`UPDATE agent_outbox SET published_at=? WHERE task_id=? AND published_at IS NULL`, time.Now().UTC(), id).Error
}
