package postgres

import (
	"blow-flow/api/internal/generation"
	"context"
	"encoding/json"
	"errors"
	"gorm.io/gorm"
	"time"
)

type Store struct {
	DB     *gorm.DB
	Notify func(context.Context, string)
}

func (s *Store) notify(ctx context.Context, id string) {
	if s.Notify != nil {
		s.Notify(ctx, id)
	}
}

func New(db *gorm.DB) *Store { return &Store{DB: db} }
func (s *Store) Create(ctx context.Context, owner, key, hash string, input generation.Input) (generation.Task, error) {
	id, err := generation.NewID()
	if err != nil {
		return generation.Task{}, err
	}
	now := time.Now().UTC()
	data, err := json.Marshal(input)
	if err != nil {
		return generation.Task{}, err
	}
	connection := generation.ConnectionForModel(input.Model)
	if input.Workflow != nil {
		connection = input.Workflow.ConnectionID
	}
	if connection == "" {
		return generation.Task{}, generation.ErrInvalid
	}
	if input.Workflow != nil {
		if err := s.ensureWorkflowConnection(ctx, input.Workflow); err != nil {
			return generation.Task{}, err
		}
	}
	err = s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Serialize admissions across API instances on the connection's limit row.
		var priorHash string
		if err := tx.Raw(`SELECT input_hash FROM generation_tasks WHERE owner_id=? AND idempotency_key=?`, owner, key).Scan(&priorHash).Error; err != nil {
			return err
		}
		if priorHash != "" {
			if priorHash != hash {
				return generation.ErrConflict
			}
			return nil
		}
		var limits []struct {
			Scope     string
			MaxQueued int
		}
		if err := tx.Raw(`SELECT scope,max_queued FROM generation_queue_limits WHERE (scope='user' AND key IN (?, '*')) OR (scope='model' AND key IN (?, '*')) OR (scope='connection' AND key IN (?, '*')) ORDER BY scope,key FOR UPDATE`, owner, input.Model, connection).Scan(&limits).Error; err != nil {
			return err
		}
		if len(limits) == 0 {
			return errors.New("missing generation queue limits")
		}
		for _, limit := range limits {
			var n int64
			where, err := scopeColumn(limit.Scope)
			if err != nil {
				return err
			}
			value := owner
			switch limit.Scope {
			case "model":
				value = input.Model
			case "connection":
				value = connection
			}
			if err := tx.Raw(`SELECT count(*) FROM generation_tasks WHERE status='queued' AND `+where+`=?`, value).Scan(&n).Error; err != nil {
				return err
			}
			if n >= int64(limit.MaxQueued) {
				switch limit.Scope {
				case "user":
					return generation.ErrUserQueueFull
				case "model":
					return generation.ErrModelQueueFull
				default:
					return generation.ErrConnectionQueueFull
				}
			}
		}
		result := tx.Exec(`INSERT INTO generation_tasks(id,owner_id,project_id,node_id,model,connection_id,input_snapshot,input_hash,idempotency_key,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?::jsonb,?,?,'queued',?,?) ON CONFLICT(owner_id,idempotency_key) DO NOTHING`, id, owner, input.ProjectID, input.NodeID, input.Model, connection, string(data), hash, key, now, now)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return nil
		}
		if input.NodeID != "" {
			if err := tx.Exec(`INSERT INTO generation_node_results(owner_id,project_id,node_id,task_id) VALUES(?,?,?,?) ON CONFLICT(owner_id,project_id,node_id) DO UPDATE SET task_id=excluded.task_id,result_url='',updated_at=now()`, owner, input.ProjectID, input.NodeID, id).Error; err != nil {
				return err
			}
		}
		if err := tx.Exec(`INSERT INTO generation_task_events(task_id,event_type,stage,occurred_at) VALUES(?,'created','queued',?)`, id, now).Error; err != nil {
			return err
		}
		return tx.Exec(`INSERT INTO generation_outbox(task_id,created_at) VALUES(?,?)`, id, now).Error
	})
	if err != nil {
		return generation.Task{}, err
	}
	var row struct {
		ID, InputHash                              string
		Status                                     generation.Status
		ProjectID, NodeID, Model, ResultURL, Stage string
		CreatedAt, UpdatedAt                       time.Time
		Version                                    int64
	}
	err = s.DB.WithContext(ctx).Raw(`SELECT t.id,input_hash,status,stage,project_id,node_id,model,result_url,created_at,updated_at,COALESCE((SELECT max(id) FROM generation_task_events WHERE task_id=t.id),0) AS version FROM generation_tasks t WHERE owner_id=? AND idempotency_key=?`, owner, key).Scan(&row).Error
	if err != nil {
		return generation.Task{}, err
	}
	if row.InputHash != hash {
		return generation.Task{}, generation.ErrConflict
	}
	if row.ID == id {
		s.notify(ctx, id)
	}
	return generation.Task{ID: row.ID, Version: row.Version, Status: row.Status, Stage: row.Stage, ProjectID: row.ProjectID, NodeID: row.NodeID, Model: row.Model, ResultURL: row.ResultURL, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt}, nil
}
func (s *Store) Get(ctx context.Context, id string) (generation.Task, string, error) {
	var r struct {
		ID, OwnerID, ProjectID, NodeID, Model, ResultURL, Stage, FailureCode string
		Percent                                                              *float64
		Status                                                               generation.Status
		CreatedAt, UpdatedAt                                                 time.Time
		Version                                                              int64
	}
	tx := s.DB.WithContext(ctx).Raw(`SELECT t.id,owner_id,project_id,node_id,model,result_url,status,stage,percent,COALESCE(failure_code,'') AS failure_code,created_at,updated_at,COALESCE((SELECT max(id) FROM generation_task_events WHERE task_id=t.id),0) AS version FROM generation_tasks t WHERE id=?`, id).Scan(&r)
	if tx.Error != nil {
		return generation.Task{}, "", tx.Error
	}
	if tx.RowsAffected == 0 {
		return generation.Task{}, "", generation.ErrNotFound
	}
	return generation.Task{ID: r.ID, Version: r.Version, ProjectID: r.ProjectID, NodeID: r.NodeID, Model: r.Model, ResultURL: r.ResultURL, Status: r.Status, Stage: r.Stage, Percent: r.Percent, FailureCode: r.FailureCode, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt}, r.OwnerID, nil
}
func (s *Store) Cancel(ctx context.Context, id, owner string) (generation.Task, error) {
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := time.Now().UTC()
		res := tx.Exec(`UPDATE generation_tasks SET status='canceled',stage='canceled',updated_at=? WHERE id=? AND owner_id=? AND status='queued'`, now, id, owner)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected > 0 {
			return tx.Exec(`INSERT INTO generation_task_events(task_id,event_type,stage,occurred_at) VALUES(?,'canceled','canceled',?)`, id, now).Error
		}
		var status string
		row := tx.Raw(`SELECT status FROM generation_tasks WHERE id=? AND owner_id=?`, id, owner).Row()
		if err := row.Scan(&status); err != nil {
			return generation.ErrNotFound
		}
		if status != "canceled" {
			return generation.ErrConflict
		}
		return nil
	})
	if err != nil {
		return generation.Task{}, err
	}
	t, _, err := s.Get(ctx, id)
	if err == nil {
		s.notify(ctx, id)
	}
	return t, err
}
func (s *Store) Claim(ctx context.Context, id string) (generation.Input, bool, error) {
	var input generation.Input
	claimed := false
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := time.Now().UTC()
		res := tx.Exec(`UPDATE generation_tasks SET status='running',stage='running',updated_at=? WHERE id=? AND status='queued'`, now, id)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return nil
		}
		var data string
		if err := tx.Raw(`SELECT input_snapshot FROM generation_tasks WHERE id=?`, id).Scan(&data).Error; err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(data), &input); err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO generation_task_events(task_id,event_type,stage,occurred_at) VALUES(?,'running','running',?)`, id, now).Error; err != nil {
			return err
		}
		claimed = true
		return nil
	})
	if err == nil && claimed {
		s.notify(ctx, id)
	}
	return input, claimed, err
}
func (s *Store) Finish(ctx context.Context, id, url string, runErr error) error {
	status, event := "completed", "completed"
	if runErr != nil {
		status, event = "failed", "failed"
		url = ""
	}
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := time.Now().UTC()
		res := tx.Exec(`UPDATE generation_tasks SET status=?,stage=?,result_url=?,updated_at=? WHERE id=? AND status='running'`, status, status, url, now, id)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return errors.New("task no longer running")
		}
		return tx.Exec(`INSERT INTO generation_task_events(task_id,event_type,stage,occurred_at) VALUES(?,?,?,?)`, id, event, status, now).Error
	})
	if err == nil {
		s.notify(ctx, id)
	}
	return err
}
