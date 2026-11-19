package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"time"

	"blow-flow/api/internal/agent"
	"gorm.io/gorm"
)

func jsonDigest(raw []byte) (string, error) {
	var value any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if d.Decode(&value) != nil || d.Decode(new(any)) != io.EOF {
		return "", agent.ErrInvalid
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", agent.ErrInvalid
	}
	h := sha256.Sum256(encoded)
	return hex.EncodeToString(h[:]), nil
}

func loadSteps(tx *gorm.DB, taskID string) ([]agent.Step, error) {
	var rows []struct {
		CallID, RunID, Name, Status string
		Arguments, Result           []byte
		CreatedAt                   time.Time
	}
	if err := tx.Raw(`SELECT call_id,run_id,name,arguments,result,status,created_at FROM agent_tool_steps WHERE task_id=? ORDER BY created_at,call_id`, taskID).Scan(&rows).Error; err != nil {
		return nil, err
	}
	steps := make([]agent.Step, 0, len(rows))
	for _, r := range rows {
		steps = append(steps, agent.Step{CallID: r.CallID, RunID: r.RunID, Name: r.Name, Status: r.Status, Arguments: r.Arguments, Result: r.Result, CreatedAt: r.CreatedAt})
	}
	return steps, nil
}

func (s *Store) StartStep(ctx context.Context, token string, input agent.StepStart) (agent.Step, error) {
	if input.CallID == "" || len(input.CallID) > 80 || input.Name == "" || len(input.Name) > 100 || len(input.Arguments) > 1<<20 {
		return agent.Step{}, agent.ErrInvalid
	}
	digest, err := jsonDigest(input.Arguments)
	if err != nil {
		return agent.Step{}, err
	}
	var out agent.Step
	err = s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := s.activeRun(tx, token, true)
		if err != nil {
			return err
		}
		var prior struct {
			CallID, RunID, Name, Digest, Status string
			Arguments, Result                   []byte
			CreatedAt                           time.Time
		}
		q := tx.Raw(`SELECT call_id,run_id,name,digest,arguments,result,status,created_at FROM agent_tool_steps WHERE task_id=? AND call_id=?`, row.ID, input.CallID).Scan(&prior)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected > 0 {
			if prior.Name != input.Name || prior.Digest != digest {
				return agent.ErrRequestConflict
			}
			out = agent.Step{CallID: prior.CallID, RunID: prior.RunID, Name: prior.Name, Arguments: prior.Arguments, Result: prior.Result, Status: prior.Status, CreatedAt: prior.CreatedAt}
			return nil
		}
		now := s.Now().UTC()
		if err := tx.Exec(`INSERT INTO agent_tool_steps(task_id,call_id,run_id,name,arguments,digest,status,created_at,updated_at) VALUES(?,?,?,?,?::jsonb,?,'running',?,?)`, row.ID, input.CallID, *row.RunID, input.Name, string(input.Arguments), digest, now, now).Error; err != nil {
			return err
		}
		if err := event(tx, row.ID, "tool_started", now); err != nil {
			return err
		}
		out = agent.Step{CallID: input.CallID, RunID: *row.RunID, Name: input.Name, Arguments: input.Arguments, Status: "running", CreatedAt: now}
		return nil
	})
	return out, err
}

func (s *Store) FinishStep(ctx context.Context, token string, input agent.StepFinish) (agent.Step, error) {
	if input.CallID == "" || len(input.CallID) > 80 || (input.Status != "completed" && input.Status != "failed") || len(input.Result) > 12<<20 {
		return agent.Step{}, agent.ErrInvalid
	}
	digest, err := jsonDigest(input.Result)
	if err != nil {
		return agent.Step{}, err
	}
	var out agent.Step
	err = s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := s.activeRun(tx, token, true)
		if err != nil {
			return err
		}
		var prior struct {
			CallID, RunID, Name, Status string
			Arguments, Result           []byte
			CreatedAt                   time.Time
		}
		q := tx.Raw(`SELECT call_id,run_id,name,arguments,result,status,created_at FROM agent_tool_steps WHERE task_id=? AND call_id=? FOR UPDATE`, row.ID, input.CallID).Scan(&prior)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected == 0 {
			return agent.ErrNotFound
		}
		if prior.Status != "running" {
			old, err := jsonDigest(prior.Result)
			if err != nil {
				return err
			}
			if prior.Status != input.Status || old != digest {
				return agent.ErrRequestConflict
			}
		} else {
			if prior.RunID != *row.RunID {
				return agent.ErrRunExpired
			}
			if err := tx.Exec(`UPDATE agent_tool_steps SET status=?,result=?::jsonb,updated_at=? WHERE task_id=? AND call_id=?`, input.Status, string(input.Result), s.Now().UTC(), row.ID, input.CallID).Error; err != nil {
				return err
			}
			if err := event(tx, row.ID, "tool_"+input.Status, s.Now().UTC()); err != nil {
				return err
			}
			prior.Result = input.Result
			prior.Status = input.Status
		}
		out = agent.Step{CallID: prior.CallID, RunID: prior.RunID, Name: prior.Name, Arguments: prior.Arguments, Result: prior.Result, Status: prior.Status, CreatedAt: prior.CreatedAt}
		return nil
	})
	return out, err
}

func (s *Store) AppendReply(ctx context.Context, token, callID, text string) error {
	if callID == "" || len(callID) > 80 || len(text) == 0 || len(text) > 100000 {
		return agent.ErrInvalid
	}
	return s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := s.activeRun(tx, token, true)
		if err != nil {
			return err
		}
		var prior struct{ Text string }
		q := tx.Raw(`SELECT text FROM agent_messages WHERE task_id=? AND call_id=?`, row.ID, callID).Scan(&prior)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected > 0 {
			if prior.Text != text {
				return agent.ErrRequestConflict
			}
			return nil
		}
		id, err := uuid()
		if err != nil {
			return err
		}
		now := s.Now().UTC()
		if err := tx.Exec(`INSERT INTO agent_messages(id,task_id,project_id,role,text,reference_items,run_id,call_id,created_at) VALUES(?,?,?,'assistant',?,'[]'::jsonb,?,?,?)`, id, row.ID, row.ProjectID, text, *row.RunID, callID, now).Error; err != nil {
			return err
		}
		return event(tx, row.ID, "assistant_replied", now)
	})
}

func (s *Store) AskQuestion(ctx context.Context, token string, q agent.Question) error {
	if q.ID == "" || len(q.ID) > 80 || q.Text == "" || len(q.Text) > 30000 || len(q.Options) > 10 || len(q.Scope) > 1<<20 {
		return agent.ErrInvalid
	}
	for _, option := range q.Options {
		if option == "" || len(option) > 200 {
			return agent.ErrInvalid
		}
	}
	if len(q.Scope) > 0 && !json.Valid(q.Scope) {
		return agent.ErrInvalid
	}
	return s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := s.activeRun(tx, token, true)
		if err != nil {
			return err
		}
		value, err := json.Marshal(q)
		if err != nil {
			return agent.ErrInvalid
		}
		now := s.Now().UTC()
		if err := tx.Exec(`UPDATE agent_tasks SET status='waiting',question=?::jsonb,run_id=NULL,run_hash=NULL,lease_until=NULL,updated_at=? WHERE id=?`, string(value), now, row.ID).Error; err != nil {
			return err
		}
		return event(tx, row.ID, "waiting", now)
	})
}
