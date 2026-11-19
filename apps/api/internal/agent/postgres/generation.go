package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"blow-flow/api/internal/agent"
	"blow-flow/api/internal/generation"
	generationpostgres "blow-flow/api/internal/generation/postgres"
	"gorm.io/gorm"
)

type GenerationItem = agent.GenerationItem
type GenerationBatch = agent.GenerationBatch

func (s *Store) PrepareGeneration(ctx context.Context, token, callID string, items []GenerationItem) (GenerationBatch, error) {
	if callID == "" || len(callID) > 80 || len(items) == 0 || len(items) > 20 {
		return GenerationBatch{}, agent.ErrInvalid
	}
	encoded, _ := json.Marshal(items)
	hash := sha256.Sum256(encoded)
	digest := hex.EncodeToString(hash[:])
	var out GenerationBatch
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := s.activeRun(tx, token, true)
		if err != nil {
			return err
		}
		id := row.ID + ":" + callID
		var previous struct {
			Digest, Status string
			Items          []byte
		}
		q := tx.Raw(`SELECT digest,status,items FROM agent_generation_batches WHERE id=? AND task_id=?`, id, row.ID).Scan(&previous)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected > 0 {
			if previous.Digest != digest {
				return agent.ErrRequestConflict
			}
			out = GenerationBatch{ID: id, Digest: digest, Status: previous.Status, Items: items}
			return nil
		}
		var step struct{ Name, Status, RunID string }
		q = tx.Raw(`SELECT name,status,run_id FROM agent_tool_steps WHERE task_id=? AND call_id=? FOR UPDATE`, row.ID, callID).Scan(&step)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected == 0 || step.Name != "prepare_generation" || step.Status != "running" || row.RunID == nil || step.RunID != *row.RunID {
			return agent.ErrConflict
		}
		var project struct {
			Snapshot []byte
			Version  int64
		}
		q = tx.Raw(`SELECT snapshot,version FROM projects WHERE id=? AND owner_id=? FOR UPDATE`, row.ProjectID, row.OwnerID).Scan(&project)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected == 0 {
			return agent.ErrNotFound
		}
		var canvas struct {
			Nodes []struct {
				ID   string `json:"id"`
				Data struct {
					Type            string            `json:"type"`
					ImageSrc        string            `json:"imageSrc"`
					VideoSrc        string            `json:"videoSrc"`
					OutputArtifacts []json.RawMessage `json:"outputArtifacts"`
				} `json:"data"`
			} `json:"nodes"`
		}
		if json.Unmarshal(project.Snapshot, &canvas) != nil {
			return agent.ErrInvalid
		}
		nodes := map[string]bool{}
		for _, n := range canvas.Nodes {
			if n.Data.Type == "textToImage" || n.Data.Type == "image" {
				nodes[n.ID] = n.Data.ImageSrc == "" && n.Data.VideoSrc == "" && len(n.Data.OutputArtifacts) == 0
			}
		}
		seen := map[string]bool{}
		for _, item := range items {
			if item.NodeID == "" || len(item.NodeID) > 200 || !nodes[item.NodeID] || seen[item.NodeID] || item.Model != "runninghub/krea2" || strings.TrimSpace(item.Prompt) == "" || len(item.Prompt) > 8000 || item.Width < 64 || item.Width > 8192 || item.Height < 64 || item.Height > 8192 || item.Width%8 != 0 || item.Height%8 != 0 {
				return agent.ErrInvalid
			}
			seen[item.NodeID] = true
		}
		now := s.Now().UTC()
		if err := tx.Exec(`UPDATE agent_generation_batches SET status='cancelled',updated_at=? WHERE task_id=? AND status='pending'`, now, row.ID).Error; err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO agent_generation_batches(id,task_id,digest,canvas_version,status,items,created_at,updated_at) VALUES(?,?,?,?,'pending',?::jsonb,?,?)`, id, row.ID, digest, project.Version, string(encoded), now, now).Error; err != nil {
			return err
		}
		scope, _ := json.Marshal(map[string]any{"kind": "generation", "batchId": id, "digest": digest, "items": items})
		question := agent.Question{ID: callID, Text: "确认生成这批内容？", Options: []string{"确认生成", "取消生成"}, Scope: scope}
		value, _ := json.Marshal(question)
		result, _ := json.Marshal(map[string]any{"waiting": true, "batchId": id, "digest": digest})
		if err := tx.Exec(`UPDATE agent_tool_steps SET status='completed',result=?::jsonb,updated_at=? WHERE task_id=? AND call_id=?`, string(result), now, row.ID, callID).Error; err != nil {
			return err
		}
		if err := event(tx, row.ID, "tool_completed", now); err != nil {
			return err
		}
		if err := tx.Exec(`UPDATE agent_tasks SET status='waiting',question=?::jsonb,run_id=NULL,run_hash=NULL,lease_until=NULL,updated_at=? WHERE id=?`, string(value), now, row.ID).Error; err != nil {
			return err
		}
		if err := event(tx, row.ID, "waiting", now); err != nil {
			return err
		}
		out = GenerationBatch{ID: id, Digest: digest, Status: "pending", Items: items}
		return nil
	})
	return out, err
}

func cancelPendingGeneration(tx *gorm.DB, taskID string, now time.Time) error {
	return tx.Exec(`UPDATE agent_generation_batches SET status='cancelled',updated_at=? WHERE task_id=? AND status='pending'`, now, taskID).Error
}

func approveGeneration(tx *gorm.DB, row taskRow, question agent.Question, answer string, now time.Time) error {
	var scope struct{ Kind, BatchID, Digest string }
	if json.Unmarshal(question.Scope, &scope) != nil || scope.Kind != "generation" {
		return nil
	}
	if scope.BatchID != row.ID+":"+question.ID || scope.Digest == "" {
		return agent.ErrConflict
	}
	var batch struct {
		Digest, Status string
		Items          []byte
		CanvasVersion  int64
	}
	q := tx.Raw(`SELECT digest,status,items,canvas_version FROM agent_generation_batches WHERE id=? AND task_id=? FOR UPDATE`, scope.BatchID, row.ID).Scan(&batch)
	if q.Error != nil {
		return q.Error
	}
	if q.RowsAffected == 0 || batch.Digest != scope.Digest || batch.Status != "pending" {
		return agent.ErrConflict
	}
	if answer != "确认生成" {
		return cancelPendingGeneration(tx, row.ID, now)
	}
	var items []GenerationItem
	if json.Unmarshal(batch.Items, &items) != nil || len(items) == 0 {
		return agent.ErrConflict
	}
	var project struct {
		Snapshot []byte
		Version  int64
	}
	q = tx.Raw(`SELECT snapshot,version FROM projects WHERE id=? AND owner_id=? FOR UPDATE`, row.ProjectID, row.OwnerID).Scan(&project)
	if q.Error != nil {
		return q.Error
	}
	if q.RowsAffected == 0 {
		return agent.ErrNotFound
	}
	if project.Version != batch.CanvasVersion {
		return agent.ErrConflict
	}
	var canvas struct {
		Nodes []struct {
			ID   string `json:"id"`
			Data struct {
				ImageSrc        string            `json:"imageSrc"`
				VideoSrc        string            `json:"videoSrc"`
				OutputArtifacts []json.RawMessage `json:"outputArtifacts"`
			} `json:"data"`
		} `json:"nodes"`
	}
	if json.Unmarshal(project.Snapshot, &canvas) != nil {
		return agent.ErrInvalid
	}
	valid := map[string]bool{}
	for _, n := range canvas.Nodes {
		valid[n.ID] = n.Data.ImageSrc == "" && n.Data.VideoSrc == "" && len(n.Data.OutputArtifacts) == 0
	}
	ids := make([]string, 0, len(items))
	service := generation.Service{Store: generationpostgres.New(tx), Resources: generationpostgres.Resources{DB: tx}}
	for i, item := range items {
		if !valid[item.NodeID] {
			return agent.ErrConflict
		}
		task, err := service.Create(tx.Statement.Context, generation.Actor{ID: row.OwnerID}, scope.BatchID+":"+string(rune('a'+i)), generation.Input{ProjectID: row.ProjectID, NodeID: item.NodeID, Model: item.Model, Prompt: item.Prompt, Width: item.Width, Height: item.Height})
		if err != nil {
			return err
		}
		ids = append(ids, task.ID)
	}
	encoded, _ := json.Marshal(ids)
	return tx.Exec(`UPDATE agent_generation_batches SET status='approved',generation_task_ids=?::jsonb,updated_at=? WHERE id=? AND status='pending'`, string(encoded), now, scope.BatchID).Error
}

func (s *Store) GenerationResults(ctx context.Context, token, batchID string) (GenerationBatch, error) {
	var out GenerationBatch
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := s.activeRun(tx, token, false)
		if err != nil {
			return err
		}
		var b struct {
			Digest, Status string
			Items, IDs     []byte
		}
		q := tx.Raw(`SELECT digest,status,items,generation_task_ids AS ids FROM agent_generation_batches WHERE id=? AND task_id=?`, batchID, row.ID).Scan(&b)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected == 0 {
			return agent.ErrNotFound
		}
		out = GenerationBatch{ID: batchID, Digest: b.Digest, Status: b.Status}
		if json.Unmarshal(b.Items, &out.Items) != nil {
			return agent.ErrInvalid
		}
		var ids []string
		if json.Unmarshal(b.IDs, &ids) != nil {
			return agent.ErrInvalid
		}
		service := generation.Service{Store: generationpostgres.New(tx)}
		for _, id := range ids {
			task, err := service.Get(ctx, generation.Actor{ID: row.OwnerID}, id)
			if err != nil {
				return err
			}
			out.Tasks = append(out.Tasks, task)
		}
		return nil
	})
	return out, err
}
