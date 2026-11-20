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
var ErrSubmitCircuitOpen = errors.New("provider submit circuit open")
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
		var queued bool
		if err := tx.Raw(`SELECT EXISTS(SELECT 1 FROM generation_tasks WHERE id=? AND status='queued')`, id).Scan(&queued).Error; err != nil {
			return err
		}
		if !queued {
			return nil
		}
		var connection string
		if err := tx.Raw(`SELECT connection_id FROM generation_tasks WHERE id=?`, id).Scan(&connection).Error; err != nil {
			return err
		}
		var max int
		if err := tx.Raw(`SELECT max_active FROM generation_connection_limits WHERE id=? FOR UPDATE`, connection).Scan(&max).Error; err != nil {
			return err
		}
		if max < 1 {
			return errors.New("missing connection limit")
		}
		var circuit struct {
			State           string
			CooldownSeconds int
			OpenedAt        *time.Time
			ProbeUntil      *time.Time
		}
		if err := tx.Raw(`SELECT state,cooldown_seconds,opened_at,probe_until FROM generation_circuits WHERE connection_id=? AND operation='submit' FOR UPDATE`, connection).Scan(&circuit).Error; err != nil {
			return err
		}
		if circuit.State == "open" {
			if circuit.OpenedAt == nil || time.Since(*circuit.OpenedAt) < time.Duration(circuit.CooldownSeconds)*time.Second {
				return ErrSubmitCircuitOpen
			}
			if err := tx.Exec(`UPDATE generation_circuits SET state='half_open',probe_until=now()+interval '20 minutes',probe_task_id=?,updated_at=now() WHERE connection_id=? AND operation='submit'`, id, connection).Error; err != nil {
				return err
			}
			if err := tx.Exec(`INSERT INTO generation_circuit_events(connection_id,operation,state,reason) VALUES(?,'submit','half_open','cooldown_elapsed')`, connection).Error; err != nil {
				return err
			}
		} else if circuit.State == "half_open" && circuit.ProbeUntil != nil && time.Now().Before(*circuit.ProbeUntil) {
			return ErrSubmitCircuitOpen
		}
		var active int64
		if err := tx.Raw(`SELECT count(*) FROM generation_tasks WHERE connection_id=? AND status IN ('submitting','running','wait_timeout','needs_review')`, connection).Scan(&active).Error; err != nil {
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
		var scopeLimits []struct {
			Scope     string
			MaxActive int
		}
		if err := tx.Raw(`SELECT scope,max_active FROM generation_queue_limits WHERE (scope='user' AND key IN ((SELECT owner_id::text FROM generation_tasks WHERE id=?),'*')) OR (scope='model' AND key IN ((SELECT model FROM generation_tasks WHERE id=?),'*')) OR (scope='connection' AND key IN (?, '*')) ORDER BY scope,key`, id, id, connection).Scan(&scopeLimits).Error; err != nil {
			return err
		}
		for _, limit := range scopeLimits {
			column, err := scopeColumn(limit.Scope)
			if err != nil {
				return err
			}
			var n int64
			if err := tx.Raw(`SELECT count(*) FROM generation_tasks WHERE `+column+`=(SELECT `+column+` FROM generation_tasks WHERE id=?) AND status IN ('submitting','running','saving','save_failed','wait_timeout','needs_review')`, id).Scan(&n).Error; err != nil {
				return err
			}
			if n >= int64(limit.MaxActive) {
				return ErrNoCapacity
			}
		}
		token, err := generation.NewID()
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		res := tx.Exec(`UPDATE generation_tasks t SET status='submitting',stage='submitting',lease_token=?,lease_until=?,updated_at=? FROM users u WHERE t.id=? AND t.owner_id=u.id AND u.status='active' AND t.status='queued' AND EXISTS (SELECT 1 FROM projects p WHERE p.owner_id=t.owner_id AND p.id=t.project_id AND p.deleted_at IS NULL AND p.purged_at IS NULL)`, token, now.Add(20*time.Minute), now, id)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return nil
		}
		if circuit.State == "open" || circuit.State == "half_open" {
			if err := tx.Exec(`UPDATE generation_circuits SET state='half_open',probe_until=?,probe_task_id=?,updated_at=? WHERE connection_id=? AND operation='submit'`, now.Add(20*time.Minute), id, now, connection).Error; err != nil {
				return err
			}
		}
		var raw string
		if err := tx.Raw(`SELECT input_snapshot::text FROM generation_tasks WHERE id=?`, id).Scan(&raw).Error; err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(raw), &out.Input); err != nil {
			return err
		}
		out.Token = token
		if err := tx.Exec(`INSERT INTO generation_task_events(task_id,event_type,stage,occurred_at) VALUES(?,'submitting','submitting',?)`, id, now).Error; err != nil {
			return err
		}
		claimed = true
		return nil
	})
	if err == nil && claimed {
		s.notify(ctx, id)
	}
	return out, claimed, err
}
func (s *Store) CheckSubmission(ctx context.Context, id, token string) (bool, error) {
	var n int64
	err := s.DB.WithContext(ctx).Raw(`SELECT count(*) FROM generation_tasks t JOIN users u ON u.id=t.owner_id WHERE t.id=? AND t.status='submitting' AND t.lease_token=? AND t.lease_until>now() AND u.status='active' AND EXISTS(SELECT 1 FROM projects p WHERE p.owner_id=t.owner_id AND p.id=t.project_id AND p.deleted_at IS NULL AND p.purged_at IS NULL)`, id, token).Scan(&n).Error
	if err != nil || n != 1 {
		return false, err
	}
	var binding struct {
		Digest, NodeID string
		Snapshot       []byte
	}
	q := s.DB.WithContext(ctx).Raw(`SELECT b.digest,b.node_id,p.snapshot FROM agent_generation_submission_bindings b JOIN generation_tasks t ON t.id=b.task_id JOIN projects p ON p.id=t.project_id AND p.owner_id=t.owner_id WHERE b.task_id=?`, id).Scan(&binding)
	if q.Error != nil {
		return false, q.Error
	}
	if q.RowsAffected > 0 {
		current, _, exists := generation.BindingDigest(binding.Snapshot, binding.NodeID)
		if !exists || current != binding.Digest {
			return false, nil
		}
	}
	var circuit struct{ State, ProbeTaskID string }
	if err := s.DB.WithContext(ctx).Raw(`SELECT state,COALESCE(probe_task_id,'') AS probe_task_id FROM generation_circuits WHERE connection_id=(SELECT connection_id FROM generation_tasks WHERE id=?) AND operation='submit'`, id).Scan(&circuit).Error; err != nil {
		return false, err
	}
	if circuit.State == "open" || (circuit.State == "half_open" && circuit.ProbeTaskID != id) {
		return false, ErrSubmitCircuitOpen
	}
	return true, nil
}
func (s *Store) RequeueSubmission(ctx context.Context, id, token string) error {
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		res := tx.Exec(`UPDATE generation_tasks SET status='queued',stage='queued',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE id=? AND status='submitting' AND lease_token=? AND lease_until>now()`, id, token)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrStaleLease
		}
		return tx.Exec(`INSERT INTO generation_task_events(task_id,event_type,stage,occurred_at) VALUES(?,'submission_deferred','queued',now())`, id).Error
	})
	if err == nil {
		s.notify(ctx, id)
	}
	return err
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
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := time.Now().UTC()
		var isCurrent bool
		if err := tx.Raw(`SELECT EXISTS(SELECT 1 FROM generation_tasks WHERE id=? AND status='submitting' AND lease_token=? AND lease_until>now())`, id, token).Scan(&isCurrent).Error; err != nil {
			return err
		}
		if !isCurrent {
			return ErrStaleLease
		}
		res := tx.Exec(`UPDATE generation_tasks SET status=?,stage=?,provider_task_id=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='submitting' AND lease_token=? AND lease_until>now()`, status, status, providerID, now, id, token)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrStaleLease
		}
		if err := s.recordSubmitOutcome(tx, id, submitErr); err != nil {
			return err
		}
		return tx.Exec(`INSERT INTO generation_task_events(task_id,event_type,stage,occurred_at) VALUES(?,?,?,?)`, id, event, status, now).Error
	})
	if err == nil {
		s.notify(ctx, id)
	}
	return err
}

func (s *Store) recordSubmitOutcome(tx *gorm.DB, id string, submitErr error) error {
	var connection string
	if err := tx.Raw(`SELECT connection_id FROM generation_tasks WHERE id=?`, id).Scan(&connection).Error; err != nil {
		return err
	}
	var circuit struct {
		State                                                  string
		ProbeTaskID                                            string
		ConsecutiveFailures, FailureThreshold, CooldownSeconds int
	}
	if err := tx.Raw(`SELECT state,consecutive_failures,failure_threshold,cooldown_seconds,COALESCE(probe_task_id,'') AS probe_task_id FROM generation_circuits WHERE connection_id=? AND operation='submit' FOR UPDATE`, connection).Scan(&circuit).Error; err != nil {
		return err
	}
	if circuit.State == "" {
		return errors.New("missing submit circuit")
	}
	if circuit.State == "open" || (circuit.State == "half_open" && circuit.ProbeTaskID != id) {
		return nil
	}
	if submitErr == nil || errors.Is(submitErr, generation.ErrSubmissionRejected) || errors.Is(submitErr, generation.ErrInvalid) {
		if err := tx.Exec(`UPDATE generation_circuits SET state='closed',consecutive_failures=0,probe_until=NULL,probe_task_id=NULL,opened_at=NULL,updated_at=now() WHERE connection_id=? AND operation='submit'`, connection).Error; err != nil {
			return err
		}
		if circuit.State != "closed" {
			return tx.Exec(`INSERT INTO generation_circuit_events(connection_id,operation,state,reason) VALUES(?,'submit','closed','probe_succeeded')`, connection).Error
		}
		return nil
	}
	if circuit.State == "half_open" || circuit.ConsecutiveFailures+1 >= circuit.FailureThreshold {
		if err := tx.Exec(`UPDATE generation_circuits SET state='open',consecutive_failures=consecutive_failures+1,opened_at=now(),probe_until=NULL,probe_task_id=NULL,updated_at=now() WHERE connection_id=? AND operation='submit'`, connection).Error; err != nil {
			return err
		}
		return tx.Exec(`INSERT INTO generation_circuit_events(connection_id,operation,state,reason) VALUES(?,'submit','open','submit_failure')`, connection).Error
	}
	return tx.Exec(`UPDATE generation_circuits SET consecutive_failures=consecutive_failures+1,updated_at=now() WHERE connection_id=? AND operation='submit'`, connection).Error
}

// Expired submission is uncertain even if the process disappeared before recording a response.
func (s *Store) RecoverExpiredSubmissions(ctx context.Context) error {
	var changed []string
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var staged []string
		if err := tx.Raw(`UPDATE generation_tasks t SET status='running',stage='running',provider_task_id='inline:'||t.id,lease_token=NULL,lease_until=NULL,updated_at=now() WHERE t.status='submitting' AND t.lease_until<=now() AND EXISTS (SELECT 1 FROM generation_inline_results r WHERE r.task_id=t.id) RETURNING t.id`).Scan(&staged).Error; err != nil {
			return err
		}
		for _, id := range staged {
			if err := tx.Exec(`INSERT INTO generation_task_events(task_id,event_type,stage,occurred_at) VALUES(?,'accepted','running',now())`, id).Error; err != nil {
				return err
			}
		}
		var ids []string
		if err := tx.Raw(`UPDATE generation_tasks SET status='needs_review',stage='needs_review',lease_token=NULL,lease_until=NULL,updated_at=now() WHERE status='submitting' AND lease_until<=now() RETURNING id`).Scan(&ids).Error; err != nil {
			return err
		}
		changed = append(staged, ids...)
		for _, id := range ids {
			if err := tx.Exec(`INSERT INTO generation_task_events(task_id,event_type,stage,occurred_at) VALUES(?,'submission_uncertain','needs_review',now())`, id).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err == nil {
		for _, id := range changed {
			s.notify(ctx, id)
		}
	}
	return err
}
