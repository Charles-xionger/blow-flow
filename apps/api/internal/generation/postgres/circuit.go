package postgres

import (
	"blow-flow/api/internal/generation"
	"context"
	"errors"
	"gorm.io/gorm"
	"time"
)

// BeginOperation gates only its own operation. In particular, a submit circuit
// cannot stop querying or saving a task that already reached the provider.
func (s *Store) BeginOperation(ctx context.Context, c DeliveryClaim, operation string) (bool, error) {
	if operation != "query" && operation != "save" {
		return false, errors.New("invalid delivery operation")
	}
	allowed := false
	connection := generation.ConnectionForModel(c.Model)
	if connection == "" {
		connection = "runninghub-international"
	}
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var current bool
		if err := tx.Raw(`SELECT EXISTS(SELECT 1 FROM generation_tasks WHERE id=? AND lease_token=? AND lease_until>now())`, c.TaskID, c.Token).Scan(&current).Error; err != nil {
			return err
		}
		if !current {
			return ErrStaleLease
		}
		var row struct {
			State, ProbeTaskID   string
			CooldownSeconds      int
			OpenedAt, ProbeUntil *time.Time
		}
		if err := tx.Raw(`SELECT state,COALESCE(probe_task_id,'') AS probe_task_id,cooldown_seconds,opened_at,probe_until FROM generation_circuits WHERE connection_id=? AND operation=? FOR UPDATE`, connection, operation).Scan(&row).Error; err != nil {
			return err
		}
		if row.State == "" {
			return errors.New("missing delivery circuit")
		}
		now := time.Now().UTC()
		if row.State == "open" && row.OpenedAt != nil && now.Before(row.OpenedAt.Add(time.Duration(row.CooldownSeconds)*time.Second)) {
			return nil
		}
		if row.State == "half_open" && row.ProbeUntil != nil && now.Before(*row.ProbeUntil) && row.ProbeTaskID != c.TaskID {
			return nil
		}
		if row.State != "closed" {
			if err := tx.Exec(`UPDATE generation_circuits SET state='half_open',probe_task_id=?,probe_until=?,updated_at=? WHERE connection_id=? AND operation=?`, c.TaskID, now.Add(60*time.Second), now, connection, operation).Error; err != nil {
				return err
			}
			if row.State == "open" {
				if err := tx.Exec(`INSERT INTO generation_circuit_events(connection_id,operation,state,reason) VALUES(? ,?,'half_open','cooldown_elapsed')`, connection, operation).Error; err != nil {
					return err
				}
			}
		}
		allowed = true
		return nil
	})
	return allowed, err
}

func (s *Store) RecordOperation(ctx context.Context, c DeliveryClaim, operation string, operationErr error) error {
	if operation != "query" && operation != "save" {
		return errors.New("invalid delivery operation")
	}
	connection := generation.ConnectionForModel(c.Model)
	if connection == "" {
		connection = "runninghub-international"
	}
	return s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var current bool
		if err := tx.Raw(`SELECT EXISTS(SELECT 1 FROM generation_tasks WHERE id=? AND lease_token=? AND lease_until>now())`, c.TaskID, c.Token).Scan(&current).Error; err != nil {
			return err
		}
		if !current {
			return ErrStaleLease
		}
		var row struct {
			State, ProbeTaskID                    string
			ConsecutiveFailures, FailureThreshold int
		}
		if err := tx.Raw(`SELECT state,COALESCE(probe_task_id,'') AS probe_task_id,consecutive_failures,failure_threshold FROM generation_circuits WHERE connection_id=? AND operation=? FOR UPDATE`, connection, operation).Scan(&row).Error; err != nil {
			return err
		}
		if row.State == "" {
			return errors.New("missing delivery circuit")
		}
		if row.State == "open" || (row.State == "half_open" && row.ProbeTaskID != c.TaskID) {
			return nil
		}
		if operationErr == nil {
			if err := tx.Exec(`UPDATE generation_circuits SET state='closed',consecutive_failures=0,opened_at=NULL,probe_until=NULL,probe_task_id=NULL,updated_at=now() WHERE connection_id=? AND operation=?`, connection, operation).Error; err != nil {
				return err
			}
			if row.State != "closed" {
				return tx.Exec(`INSERT INTO generation_circuit_events(connection_id,operation,state,reason) VALUES(?,?,'closed','probe_succeeded')`, connection, operation).Error
			}
			return nil
		}
		if row.State == "half_open" || row.ConsecutiveFailures+1 >= row.FailureThreshold {
			if err := tx.Exec(`UPDATE generation_circuits SET state='open',consecutive_failures=consecutive_failures+1,opened_at=now(),probe_until=NULL,probe_task_id=NULL,updated_at=now() WHERE connection_id=? AND operation=?`, connection, operation).Error; err != nil {
				return err
			}
			return tx.Exec(`INSERT INTO generation_circuit_events(connection_id,operation,state,reason) VALUES(?,?,'open','operation_failure')`, connection, operation).Error
		}
		return tx.Exec(`UPDATE generation_circuits SET consecutive_failures=consecutive_failures+1,updated_at=now() WHERE connection_id=? AND operation=?`, connection, operation).Error
	})
}

func (s *Store) DeferOperation(ctx context.Context, c DeliveryClaim) error {
	return s.apply(ctx, c.TaskID, c.Token, deliveryTransition{Status: c.Status, Stage: c.Status, Next: time.Now().Add(5 * time.Second)})
}
