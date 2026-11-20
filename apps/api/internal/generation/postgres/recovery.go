package postgres

import (
	"context"
	"gorm.io/gorm"
)

// DueQueued rotates through a bounded set of queued tasks independently of
// RabbitMQ. Claims still go through ClaimSubmission and its database fences.
func (s *Store) DueQueued(ctx context.Context, limit int) ([]string, error) {
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	var ids []string
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return tx.Raw(`WITH due AS (
			SELECT id FROM generation_tasks
			WHERE status='queued' AND (recovery_checked_at IS NULL OR recovery_checked_at<=now()-interval '5 seconds')
			ORDER BY recovery_checked_at NULLS FIRST,created_at,id LIMIT ? FOR UPDATE SKIP LOCKED
		)
		UPDATE generation_tasks t SET recovery_checked_at=now() FROM due WHERE t.id=due.id RETURNING t.id`, limit).Scan(&ids).Error
	})
	return ids, err
}
