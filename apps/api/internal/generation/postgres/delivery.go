package postgres

import (
	"blow-flow/api/internal/generation"
	"context"
	"errors"
	"gorm.io/gorm"
	"time"
)

type DeliveryClaim struct {
	TaskID, ProviderID, ProviderURL, FileType, Token, Status, Model string
	StartedAt                                                       time.Time
	Attempts, SaveAttempts                                          int
}

func (s *Store) DueDeliveries(ctx context.Context, limit int) ([]string, error) {
	var ids []string
	err := s.DB.WithContext(ctx).Raw(`SELECT id FROM generation_tasks WHERE status IN ('running','saving','save_failed') AND provider_task_id IS NOT NULL AND (next_attempt_at IS NULL OR next_attempt_at<=now()) AND (lease_until IS NULL OR lease_until<=now()) ORDER BY updated_at LIMIT ?`, limit).Scan(&ids).Error
	return ids, err
}
func (s *Store) ClaimDelivery(ctx context.Context, id string) (DeliveryClaim, bool, error) {
	var claim DeliveryClaim
	token, err := generation.NewID()
	if err != nil {
		return claim, false, err
	}
	now := time.Now().UTC()
	res := s.DB.WithContext(ctx).Exec(`UPDATE generation_tasks SET lease_token=?,lease_until=?,tracking_started_at=COALESCE(tracking_started_at,?),next_attempt_at=NULL WHERE id=? AND status IN ('running','saving','save_failed') AND provider_task_id IS NOT NULL AND (next_attempt_at IS NULL OR next_attempt_at<=now()) AND (lease_until IS NULL OR lease_until<=now())`, token, now.Add(240*time.Second), now, id)
	if res.Error != nil {
		return claim, false, res.Error
	}
	if res.RowsAffected == 0 {
		return claim, false, nil
	}
	err = s.DB.WithContext(ctx).Raw(`SELECT id AS task_id,provider_task_id AS provider_id,COALESCE(provider_result_url,'') AS provider_url,COALESCE(provider_result_type,'') AS file_type,status,model,tracking_started_at AS started_at,poll_attempts AS attempts,save_attempts FROM generation_tasks WHERE id=?`, id).Scan(&claim).Error
	claim.Token = token
	return claim, err == nil, err
}

type deliveryTransition struct {
	Status, Stage, Event, ProviderURL, FileType, Failure string
	Percent                                              *float64
	Next                                                 time.Time
	IncrementAttempt                                     bool
	IncrementSaveAttempt                                 bool
	ResetQueryAttempts                                   bool
}

func (s *Store) apply(ctx context.Context, id, token string, change deliveryTransition) error {
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := time.Now().UTC()
		var priorStage string
		if err := tx.Raw(`SELECT stage FROM generation_tasks WHERE id=? FOR UPDATE`, id).Scan(&priorStage).Error; err != nil {
			return err
		}
		var nextValue any
		if !change.Next.IsZero() {
			nextValue = change.Next
		}
		res := tx.Exec(`UPDATE generation_tasks SET status=?,stage=?,percent=COALESCE(?,percent),provider_result_url=CASE WHEN ?<>'' THEN ? ELSE provider_result_url END,provider_result_type=CASE WHEN ?<>'' THEN ? ELSE provider_result_type END,failure_code=NULLIF(?,''),next_attempt_at=?,poll_attempts=CASE WHEN ? THEN 0 ELSE poll_attempts+? END,save_attempts=save_attempts+?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=? AND lease_until>now()`, change.Status, change.Stage, change.Percent, change.ProviderURL, change.ProviderURL, change.FileType, change.FileType, change.Failure, nextValue, change.ResetQueryAttempts, boolInt(change.IncrementAttempt), boolInt(change.IncrementSaveAttempt), now, id, token)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrStaleLease
		}
		event := change.Event
		if event == "" && priorStage != change.Stage {
			event = "stage_changed"
		}
		if event != "" {
			return tx.Exec(`INSERT INTO generation_task_events(task_id,event_type,stage,occurred_at) VALUES(?,?,?,?)`, id, event, change.Stage, now).Error
		}
		return nil
	})
	if err == nil {
		s.notify(ctx, id)
	}
	return err
}
func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}
func (s *Store) RecordProgress(ctx context.Context, id, token, stage string, percent *float64) error {
	if stage == "" {
		stage = "generating"
	}
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := time.Now().UTC()
		res := tx.Exec(`UPDATE generation_tasks SET stage=?,percent=COALESCE(?,percent),updated_at=? WHERE id=? AND status='running' AND lease_token=? AND lease_until>now() AND (stage<>? OR (?::double precision IS NOT NULL AND (percent IS NULL OR percent<?)))`, stage, percent, now, id, token, stage, percent, percent)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return nil
		}
		return tx.Exec(`INSERT INTO generation_task_events(task_id,event_type,stage,occurred_at) VALUES(?,'progress',?,?)`, id, stage, now).Error
	})
	if err == nil {
		s.notify(ctx, id)
	}
	return err
}
func (s *Store) ScheduleQuery(ctx context.Context, c DeliveryClaim, stage string, err error, timeout time.Duration) error {
	if !c.StartedAt.IsZero() && time.Since(c.StartedAt) >= timeout {
		return s.apply(ctx, c.TaskID, c.Token, deliveryTransition{Status: "wait_timeout", Stage: "wait_timeout", Event: "wait_timeout"})
	}
	attempts := 0
	if err != nil {
		attempts = c.Attempts + 1
		if attempts >= 6 {
			return s.apply(ctx, c.TaskID, c.Token, deliveryTransition{Status: string(generation.QueryFailed), Stage: string(generation.QueryFailed), Event: "query_exhausted", Failure: "query_exhausted", IncrementAttempt: true})
		}
	}
	delay := 2 * time.Second
	if attempts > 0 {
		delay = time.Duration(1<<min(attempts, 6)) * time.Second
	}
	if stage == "" {
		stage = "waiting_provider"
	}
	event := ""
	if err != nil {
		event = "query_retry"
	}
	return s.apply(ctx, c.TaskID, c.Token, deliveryTransition{Status: "running", Stage: stage, Event: event, Next: time.Now().Add(delay), IncrementAttempt: err != nil, ResetQueryAttempts: err == nil})
}
func (s *Store) ProviderSucceeded(ctx context.Context, c DeliveryClaim, url, fileType string) error {
	if url == "" {
		return errors.New("empty provider output")
	}
	return s.apply(ctx, c.TaskID, c.Token, deliveryTransition{Status: "saving", Stage: "saving", Event: "provider_succeeded", ProviderURL: url, FileType: fileType, ResetQueryAttempts: true})
}
func (s *Store) ProviderFailed(ctx context.Context, c DeliveryClaim) error {
	return s.apply(ctx, c.TaskID, c.Token, deliveryTransition{Status: "failed", Stage: "provider_failed", Event: "provider_failed", Failure: "provider_failed"})
}
func (s *Store) SaveFailed(ctx context.Context, c DeliveryClaim, code string, permanent bool) error {
	delay := time.Duration(1<<min(c.SaveAttempts+1, 6)) * time.Second
	next := time.Now().Add(delay)
	exhausted := !permanent && c.SaveAttempts+1 >= 5
	if permanent {
		next = time.Time{}
	}
	if exhausted {
		next = time.Time{}
	}
	event := "save_retry"
	if permanent {
		event = "save_unavailable"
	}
	if exhausted {
		event = "save_exhausted"
		code = "save_exhausted"
	}
	status := "save_failed"
	if permanent {
		status = "save_unavailable"
	}
	if exhausted {
		status = string(generation.SaveExhausted)
	}
	return s.apply(ctx, c.TaskID, c.Token, deliveryTransition{Status: status, Stage: status, Event: event, Failure: code, Next: next, IncrementSaveAttempt: !permanent})
}
func (s *Store) Delivered(ctx context.Context, c DeliveryClaim, url string) error {
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := time.Now().UTC()
		res := tx.Exec(`UPDATE generation_tasks SET status='completed',stage='delivered',result_url=?,failure_code=NULL,lease_token=NULL,lease_until=NULL,next_attempt_at=NULL,updated_at=? WHERE id=? AND status IN ('saving','save_failed') AND lease_token=? AND lease_until>now()`, url, now, c.TaskID, c.Token)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return ErrStaleLease
		}
		if err := tx.Exec(`UPDATE generation_node_results n SET result_url=?,updated_at=? FROM generation_tasks t WHERE t.id=? AND t.node_id<>'' AND n.owner_id=t.owner_id AND n.project_id=t.project_id AND n.node_id=t.node_id AND n.task_id=t.id`, url, now, c.TaskID).Error; err != nil {
			return err
		}
		if err := attachAgentResult(tx, c.TaskID, url, now); err != nil {
			return err
		}
		if c.Model == generation.GeminiImageModel {
			if err := tx.Exec(`DELETE FROM generation_inline_results WHERE task_id=?`, c.TaskID).Error; err != nil {
				return err
			}
		}
		return tx.Exec(`INSERT INTO generation_task_events(task_id,event_type,stage,occurred_at) VALUES(?,'delivered','delivered',?)`, c.TaskID, now).Error
	})
	if err == nil {
		s.notify(ctx, c.TaskID)
	}
	return err
}
func (s *Store) ResumeDelivery(ctx context.Context, id string) error {
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := time.Now().UTC()
		res := tx.Exec(`UPDATE generation_tasks SET status=CASE WHEN provider_result_url IS NULL THEN 'running' ELSE 'saving' END,stage=CASE WHEN provider_result_url IS NULL THEN 'waiting_provider' ELSE 'saving' END,failure_code=NULL,next_attempt_at=now(),poll_attempts=0,save_attempts=0,tracking_started_at=CASE WHEN provider_result_url IS NULL THEN ? ELSE tracking_started_at END,updated_at=? WHERE id=? AND status IN ('wait_timeout','query_failed','save_failed','save_exhausted') AND (lease_until IS NULL OR lease_until<=now())`, now, now, id)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return generation.ErrConflict
		}
		return tx.Exec(`INSERT INTO generation_task_events(task_id,event_type,stage,occurred_at) SELECT id,'resumed',stage,? FROM generation_tasks WHERE id=?`, now, id).Error
	})
	if err == nil {
		s.notify(ctx, id)
	}
	return err
}
func (s *Store) Events(ctx context.Context, id string, after int64) ([]generation.Event, error) {
	var events []generation.Event
	err := s.DB.WithContext(ctx).Raw(`SELECT id,event_type AS type,COALESCE(stage,'') AS stage,occurred_at FROM generation_task_events WHERE task_id=? AND id>? ORDER BY id LIMIT 100`, id, after).Scan(&events).Error
	return events, err
}
