package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"blow-flow/api/internal/agent"
	"gorm.io/gorm"
)

func (s *Store) Snapshot(ctx context.Context, owner, project string) (agent.Snapshot, error) {
	out := agent.Snapshot{Tasks: []agent.Task{}, Messages: []agent.Message{}}
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := ownedProject(tx, owner, project, 0); err != nil {
			return err
		}
		var tasks []taskRow
		if err := tx.Raw(`SELECT id,owner_id,project_id,model_id,status,question,legacy_imported,created_at,updated_at FROM agent_tasks WHERE owner_id=? AND project_id=? ORDER BY created_at,id`, owner, project).Scan(&tasks).Error; err != nil {
			return err
		}
		for _, row := range tasks {
			out.Tasks = append(out.Tasks, row.task())
		}
		messages, err := loadMessages(tx, project)
		if err != nil {
			return err
		}
		out.Messages = messages
		var archived []struct{ Data []byte }
		if err := tx.Raw(`SELECT data FROM agent_legacy_generation_batches WHERE task_id IN (SELECT id FROM agent_tasks WHERE owner_id=? AND project_id=?) ORDER BY id`, owner, project).Scan(&archived).Error; err != nil {
			return err
		}
		for _, item := range archived {
			out.LegacyGenerationBatches = append(out.LegacyGenerationBatches, json.RawMessage(item.Data))
		}
		return nil
	})
	return out, err
}

func loadMessages(tx *gorm.DB, project string) ([]agent.Message, error) {
	var rows []struct {
		ID, TaskID, Role, Text string
		RunID                  *string
		References             []byte
		CreatedAt              time.Time
	}
	if err := tx.Raw(`SELECT id,task_id,role,text,run_id,reference_items AS references,created_at FROM agent_messages WHERE project_id=? ORDER BY created_at,id`, project).Scan(&rows).Error; err != nil {
		return nil, err
	}
	messages := make([]agent.Message, 0, len(rows))
	for _, row := range rows {
		message := agent.Message{ID: row.ID, TaskID: row.TaskID, Role: row.Role, Text: row.Text, References: []agent.Reference{}, CreatedAt: row.CreatedAt}
		if row.RunID != nil {
			message.RunID = *row.RunID
		}
		if err := json.Unmarshal(row.References, &message.References); err != nil {
			return nil, err
		}
		messages = append(messages, message)
	}
	return messages, nil
}

func (s *Store) Context(ctx context.Context, token string) (agent.RunContext, error) {
	var out agent.RunContext
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := s.activeRun(tx, token, false)
		if err != nil {
			return err
		}
		out.Task = row.task()
		out.Messages, err = loadMessages(tx, row.ProjectID)
		if err != nil {
			return err
		}
		out.Steps, err = loadSteps(tx, row.ID)
		if err != nil {
			return err
		}
		return nil
	})
	return out, err
}

func ownedProject(tx *gorm.DB, owner, project string, version int64) error {
	var p struct {
		Version             int64
		DeletedAt, PurgedAt *time.Time
	}
	query := `SELECT version,deleted_at,purged_at FROM projects WHERE id=? AND owner_id=?`
	if version > 0 {
		query += ` FOR SHARE`
	}
	q := tx.Raw(query, project, owner).Scan(&p)
	if q.Error != nil {
		return q.Error
	}
	if q.RowsAffected == 0 || p.DeletedAt != nil || p.PurgedAt != nil {
		return agent.ErrNotFound
	}
	if version > 0 && p.Version != version {
		return agent.ErrConflict
	}
	return nil
}

func validCommand(input agent.Command) bool {
	if input.RequestID == "" || len(input.RequestID) > 200 || input.Action == "" {
		return false
	}
	switch input.Action {
	case "send":
		if strings.TrimSpace(input.Text) == "" || len(input.Text) > 30000 || input.ModelID == "" || len(input.ModelID) > 120 || input.CanvasVersion < 1 || len(input.References) > 8 {
			return false
		}
		for _, ref := range input.References {
			if ref.NodeID == "" && ref.AssetID == "" {
				return false
			}
			if ref.URL != "" || ref.Data != "" {
				return false
			} // Runner resolves only owned, persisted references.
		}
		return true
	case "continue", "stop":
		return input.Text == "" && input.ModelID == "" && input.QuestionID == "" && len(input.References) == 0
	case "answer":
		return strings.TrimSpace(input.Text) != "" && len(input.Text) <= 30000 && input.QuestionID != "" && input.ModelID == "" && len(input.References) == 0
	}
	return false
}

func activeTask(tx *gorm.DB, project string) (taskRow, bool, error) {
	var row taskRow
	q := tx.Raw(`SELECT id,owner_id,project_id,model_id,status,question,created_at,updated_at FROM agent_tasks WHERE project_id=? AND status IN ('queued','running','waiting','interrupted') AND NOT legacy_imported FOR UPDATE`, project).Scan(&row)
	return row, q.RowsAffected > 0, q.Error
}

func validateReferences(tx *gorm.DB, owner, project string, refs []agent.Reference) error {
	if len(refs) == 0 {
		return nil
	}
	var value struct{ Snapshot []byte }
	q := tx.Raw(`SELECT snapshot FROM projects WHERE id=? AND owner_id=?`, project, owner).Scan(&value)
	if q.Error != nil {
		return q.Error
	}
	var graph struct {
		Nodes []struct {
			ID string `json:"id"`
		} `json:"nodes"`
	}
	if json.Unmarshal(value.Snapshot, &graph) != nil {
		return agent.ErrInvalid
	}
	nodes := map[string]bool{}
	for _, node := range graph.Nodes {
		nodes[node.ID] = true
	}
	for _, ref := range refs {
		if ref.NodeID != "" && !nodes[ref.NodeID] {
			return agent.ErrInvalid
		}
		if ref.AssetID != "" {
			var count int64
			if err := tx.Raw(`SELECT count(*) FROM media_assets WHERE id=? AND owner_id=?`, ref.AssetID, owner).Scan(&count).Error; err != nil {
				return err
			}
			if count != 1 {
				return agent.ErrInvalid
			}
		}
	}
	return nil
}

func (s *Store) Command(ctx context.Context, owner, project string, input agent.Command) (agent.Task, error) {
	if owner == "" || project == "" || !validCommand(input) {
		return agent.Task{}, agent.ErrInvalid
	}
	encoded, err := json.Marshal(struct {
		Project string        `json:"project"`
		Command agent.Command `json:"command"`
	}{project, input})
	if err != nil {
		return agent.Task{}, agent.ErrInvalid
	}
	hash := sha256.Sum256(encoded)
	digest := hex.EncodeToString(hash[:])
	var out agent.Task
	err = s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Commands serialize per project without taking the project row lock. Canvas
		// commits lock the task first and the project second.
		if err := tx.Exec(`SELECT pg_advisory_xact_lock(hashtext(?))`, "agent:"+project).Error; err != nil {
			return err
		}
		if err := ownedProject(tx, owner, project, 0); err != nil {
			return err
		}
		var legacyReceipt int64
		if err := tx.Raw(`SELECT count(*) FROM agent_legacy_command_receipts WHERE project_id=? AND request_id=?`, project, input.RequestID).Scan(&legacyReceipt).Error; err != nil {
			return err
		}
		if legacyReceipt > 0 {
			return agent.ErrRequestConflict
		}
		var prior struct{ Digest, TaskID string }
		q := tx.Raw(`SELECT digest,task_id FROM agent_command_receipts WHERE owner_id=? AND request_id=?`, owner, input.RequestID).Scan(&prior)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected > 0 {
			if prior.Digest != digest {
				return agent.ErrRequestConflict
			}
			var row taskRow
			q := tx.Raw(`SELECT id,owner_id,project_id,model_id,status,question,created_at,updated_at FROM agent_tasks WHERE id=?`, prior.TaskID).Scan(&row)
			if q.Error != nil {
				return q.Error
			}
			out = row.task()
			return nil
		}
		row, found, err := activeTask(tx, project)
		if err != nil {
			return err
		}
		if input.Action == "send" {
			if err := ownedProject(tx, owner, project, input.CanvasVersion); err != nil {
				return err
			}
			if err := validateReferences(tx, owner, project, input.References); err != nil {
				return err
			}
		}
		now := s.Now().UTC()
		switch input.Action {
		case "send":
			referencedNodeIDs := make([]string, 0, len(input.References))
			for _, ref := range input.References {
				if ref.NodeID != "" {
					referencedNodeIDs = append(referencedNodeIDs, ref.NodeID)
				}
			}
			grants, _ := json.Marshal(referencedNodeIDs)
			if found {
				if err := cancelPendingGeneration(tx, row.ID, now); err != nil {
					return err
				}
				if row.OwnerID != owner || row.ModelID != input.ModelID {
					return agent.ErrConflict
				}
				if row.Status == "waiting" {
					if err := tx.Exec(`UPDATE agent_tasks SET status='queued',question=NULL,updated_at=? WHERE id=?`, now, row.ID).Error; err != nil {
						return err
					}
					row.Status = "queued"
					if err := wake(tx, row.ID); err != nil {
						return err
					}
				}
				if err := tx.Exec(`UPDATE agent_tasks SET editable_node_ids=(SELECT COALESCE(jsonb_agg(DISTINCT value),'[]'::jsonb) FROM jsonb_array_elements_text(editable_node_ids || ?::jsonb) AS value),updated_at=? WHERE id=?`, string(grants), now, row.ID).Error; err != nil {
					return err
				}
				row.UpdatedAt = now
			} else {
				id, err := uuid()
				if err != nil {
					return err
				}
				row = taskRow{ID: id, OwnerID: owner, ProjectID: project, ModelID: input.ModelID, Status: "queued", CreatedAt: now, UpdatedAt: now}
				if err := tx.Exec(`INSERT INTO agent_tasks(id,owner_id,project_id,request_id,model_id,status,editable_node_ids,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?::jsonb,?,?)`, id, owner, project, input.RequestID, input.ModelID, string(grants), now, now).Error; err != nil {
					return err
				}
				if err := event(tx, id, "queued", now); err != nil {
					return err
				}
				if err := wake(tx, id); err != nil {
					return err
				}
			}
			if err := insertMessage(tx, row.ID, project, "user", input.Text, input.References, nil, now); err != nil {
				return err
			}
		case "continue":
			if !found || row.OwnerID != owner || row.Status != "interrupted" {
				return agent.ErrConflict
			}
			if err := tx.Exec(`UPDATE agent_tasks SET status='queued',updated_at=? WHERE id=?`, now, row.ID).Error; err != nil {
				return err
			}
			row.Status = "queued"
			row.UpdatedAt = now
			if err := event(tx, row.ID, "queued", now); err != nil {
				return err
			}
			if err := wake(tx, row.ID); err != nil {
				return err
			}
		case "stop":
			if !found || row.OwnerID != owner {
				return agent.ErrConflict
			}
			if err := cancelPendingGeneration(tx, row.ID, now); err != nil {
				return err
			}
			if err := tx.Exec(`UPDATE agent_tasks SET status='stopped',run_id=NULL,run_hash=NULL,lease_until=NULL,question=NULL,updated_at=? WHERE id=?`, now, row.ID).Error; err != nil {
				return err
			}
			row.Status = "stopped"
			row.UpdatedAt = now
			row.Question = nil
			if err := event(tx, row.ID, "stopped", now); err != nil {
				return err
			}
		case "answer":
			if !found || row.OwnerID != owner || row.Status != "waiting" || len(row.Question) == 0 {
				return agent.ErrConflict
			}
			var question agent.Question
			if json.Unmarshal(row.Question, &question) != nil || question.ID != input.QuestionID {
				return agent.ErrConflict
			}
			if err := approveGeneration(tx, row, question, input.Text, now); err != nil {
				return err
			}
			question.Answer = input.Text
			value, _ := json.Marshal(question)
			if err := tx.Exec(`UPDATE agent_tasks SET status='queued',question=?::jsonb,updated_at=? WHERE id=?`, string(value), now, row.ID).Error; err != nil {
				return err
			}
			row.Status = "queued"
			row.Question = value
			row.UpdatedAt = now
			if err := insertMessage(tx, row.ID, project, "user", input.Text, nil, nil, now); err != nil {
				return err
			}
			if err := event(tx, row.ID, "answered", now); err != nil {
				return err
			}
			if err := wake(tx, row.ID); err != nil {
				return err
			}
		}
		if err := tx.Exec(`INSERT INTO agent_command_receipts(owner_id,request_id,digest,task_id,created_at) VALUES(?,?,?,?,?)`, owner, input.RequestID, digest, row.ID, now).Error; err != nil {
			return err
		}
		out = row.task()
		return nil
	})
	return out, err
}

func insertMessage(tx *gorm.DB, taskID, project, role, text string, refs []agent.Reference, runID *string, now time.Time) error {
	id, err := uuid()
	if err != nil {
		return err
	}
	if refs == nil {
		refs = []agent.Reference{}
	}
	value, err := json.Marshal(refs)
	if err != nil {
		return err
	}
	return tx.Exec(`INSERT INTO agent_messages(id,task_id,project_id,role,text,reference_items,run_id,created_at) VALUES(?,?,?,?,?,?::jsonb,?,?)`, id, taskID, project, role, text, string(value), runID, now).Error
}

func wake(tx *gorm.DB, taskID string) error {
	return tx.Exec(`INSERT INTO agent_outbox(task_id,published_at) VALUES(?,NULL) ON CONFLICT(task_id) DO UPDATE SET published_at=NULL`, taskID).Error
}
