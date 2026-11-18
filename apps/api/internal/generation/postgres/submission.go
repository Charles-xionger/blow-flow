package postgres

import (
	"blow-flow/api/internal/generation"
	"context"
	"encoding/json"
	"errors"
	"gorm.io/gorm"
	"time"
)

var ErrNoCapacity = errors.New("platform connection full")
var ErrStaleLease = errors.New("generation lease expired")

type Submission struct {
	Input generation.Input
	Token string
}

// ClaimSubmission serializes slot decisions on the connection row across workers.
func (s *Store) ClaimSubmission(ctx context.Context, id string) (Submission, bool, error) {
	var out Submission
	claimed := false
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var max int
		if err := tx.Raw(`SELECT max_active FROM generation_connection_limits WHERE id='runninghub-international' FOR UPDATE`).Scan(&max).Error; err != nil {
			return err
		}
		if max < 1 {
			return errors.New("missing connection limit")
		}
		var active int64
		if err := tx.Raw(`SELECT count(*) FROM generation_tasks WHERE connection_id='runninghub-international' AND status IN ('submitting','running','needs_review')`).Scan(&active).Error; err != nil {
			return err
		}
		if active >= int64(max) {
			var status string
			tx.Raw(`SELECT status FROM generation_tasks WHERE id=?`, id).Scan(&status)
			if status == "queued" {
				return ErrNoCapacity
			}
			return nil
		}
		token, err := generation.NewID()
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		res := tx.Exec(`UPDATE generation_tasks t SET status='submitting',lease_token=?,lease_until=?,updated_at=? FROM users u WHERE t.id=? AND t.owner_id=u.id AND u.status='active' AND t.status='queued' AND EXISTS (SELECT 1 FROM generation_resource_grants g WHERE g.owner_id=t.owner_id AND g.resource_type='project' AND g.resource_id=t.project_id)`, token, now.Add(60*time.Second), now, id)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return nil
		}
		var raw string
		if err := tx.Raw(`SELECT input_snapshot::text FROM generation_tasks WHERE id=?`, id).Scan(&raw).Error; err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(raw), &out.Input); err != nil {
			return err
		}
		out.Token = token
		if err := tx.Exec(`INSERT INTO generation_task_events(task_id,event_type,occurred_at) VALUES(?,'submitting',?)`, id, now).Error; err != nil {
			return err
		}
		claimed = true
		return nil
	})
	return out, claimed, err
}
func (s *Store) CheckSubmission(ctx context.Context, id, token string) (bool, error) {
	var n int64
	err := s.DB.WithContext(ctx).Raw(`SELECT count(*) FROM generation_tasks t JOIN users u ON u.id=t.owner_id WHERE t.id=? AND t.status='submitting' AND t.lease_token=? AND t.lease_until>now() AND u.status='active' AND EXISTS(SELECT 1 FROM generation_resource_grants g WHERE g.owner_id=t.owner_id AND g.resource_type='project' AND g.resource_id=t.project_id)`, id, token).Scan(&n).Error
	return n == 1, err
}
func (s *Store) ResolveSubmission(ctx context.Context, id, token, providerID string, submitErr error) error {
	status, event := "running", "accepted"
	if submitErr != nil {
		if errors.Is(submitErr, generation.ErrInvalid) || errors.Is(submitErr, generation.ErrSubmissionRejected) {
			status, event = "failed", "rejected"
		} else {
			status, event = "needs_review", "submission_uncertain"
		}
	}
	return s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := time.Now().UTC()
		res := tx.Exec(`UPDATE generation_tasks SET status=?,provider_task_id=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='submitting' AND lease_token=? AND lease_until>now()`, status, providerID, now, id, token)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrStaleLease
		}
		return tx.Exec(`INSERT INTO generation_task_events(task_id,event_type,occurred_at) VALUES(?,?,?)`, id, event, now).Error
	})
}

// Expired submission is uncertain even if the process disappeared before recording a response.
func (s *Store) RecoverExpiredSubmissions(ctx context.Context) error {
	return s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var ids []string
		if err := tx.Raw(`UPDATE generation_tasks SET status='needs_review',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE status='submitting' AND lease_until<=now() RETURNING id`).Scan(&ids).Error; err != nil {
			return err
		}
		for _, id := range ids {
			if err := tx.Exec(`INSERT INTO generation_task_events(task_id,event_type,occurred_at) VALUES(?,'submission_uncertain',now())`, id).Error; err != nil {
				return err
			}
		}
		return nil
	})
}
