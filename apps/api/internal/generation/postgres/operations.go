package postgres

import (
	"blow-flow/api/internal/generation"
	"context"
	"gorm.io/gorm"
	"time"
)

// Operations records the privileged read before returning aggregate production data.
func (s *Store) Operations(ctx context.Context, actor string) (generation.Operations, error) {
	var out generation.Operations
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(`INSERT INTO generation_admin_audit(actor_id,action) VALUES(?,'view_generation_operations')`, actor).Error; err != nil {
			return err
		}
		var counts struct {
			QueueLength, NeedsReview int64
			OldestWaitSeconds        float64
		}
		if err := tx.Raw(`SELECT count(*) FILTER (WHERE status='queued') AS queue_length,count(*) FILTER (WHERE status='needs_review') AS needs_review,COALESCE(extract(epoch FROM (now()-min(created_at) FILTER (WHERE status='queued'))),0) AS oldest_wait_seconds FROM generation_tasks`).Scan(&counts).Error; err != nil {
			return err
		}
		out.QueueLength, out.NeedsReview, out.OldestWaitSeconds = counts.QueueLength, counts.NeedsReview, counts.OldestWaitSeconds
		if err := tx.Raw(`SELECT COALESCE(stage,'') AS stage,COALESCE(avg(extract(epoch FROM (next_at-occurred_at))),0) AS average_seconds,count(*) AS samples FROM (SELECT stage,occurred_at,lead(occurred_at) OVER (PARTITION BY task_id ORDER BY id) AS next_at FROM generation_task_events) e WHERE next_at IS NOT NULL GROUP BY stage ORDER BY stage`).Scan(&out.Stages).Error; err != nil {
			return err
		}
		if err := tx.Raw(`SELECT event_type AS code,count(*) AS count FROM generation_task_events WHERE event_type IN ('rejected','submission_uncertain','provider_failed','query_retry','query_exhausted','save_retry','save_exhausted','save_unavailable','wait_timeout') GROUP BY event_type ORDER BY event_type`).Scan(&out.Failures).Error; err != nil {
			return err
		}
		if err := tx.Raw(`SELECT worker_id AS id,seen_at FROM generation_worker_heartbeats ORDER BY seen_at DESC`).Scan(&out.Workers).Error; err != nil {
			return err
		}
		return tx.Raw(`SELECT connection_id,CASE state WHEN 'closed' THEN 'normal' WHEN 'open' THEN 'paused' ELSE 'probing' END AS state,consecutive_failures,last_reason,next_probe_at FROM generation_circuits WHERE operation='submit' ORDER BY connection_id`).Scan(&out.Circuits).Error
	})
	return out, err
}

func (s *Store) Heartbeat(ctx context.Context, id string) error {
	return s.DB.WithContext(ctx).Exec(`INSERT INTO generation_worker_heartbeats(worker_id,seen_at) VALUES(?,?) ON CONFLICT(worker_id) DO UPDATE SET seen_at=excluded.seen_at`, id, time.Now().UTC()).Error
}
