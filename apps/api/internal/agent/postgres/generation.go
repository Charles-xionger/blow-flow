package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"

	"blow-flow/api/internal/agent"
	"blow-flow/api/internal/generation"
	generationpostgres "blow-flow/api/internal/generation/postgres"
	"gorm.io/gorm"
)

type GenerationItem = agent.GenerationItem
type GenerationBatch = agent.GenerationBatch

func generationInput(item GenerationItem, project string) (generation.Input, error) {
	input := generation.Input{ProjectID: project, NodeID: item.NodeID, Model: item.Model, Prompt: item.Prompt, Width: item.Width, Height: item.Height}
	if len(item.Input) > 0 {
		if item.Model != "" || item.Prompt != "" || item.Width != 0 || item.Height != 0 {
			return generation.Input{}, agent.ErrInvalid
		}
		var fields map[string]json.RawMessage
		if item.ModelID == "" || json.Unmarshal(item.Input, &fields) != nil || len(fields) == 0 {
			return generation.Input{}, agent.ErrInvalid
		}
		for key := range fields {
			switch key {
			case "prompt", "width", "height", "duration", "references", "instanceType", "imageOptions":
			default:
				return generation.Input{}, agent.ErrInvalid
			}
		}
		if json.Unmarshal(item.Input, &input) != nil {
			return generation.Input{}, agent.ErrInvalid
		}
		if rawRefs, ok := fields["references"]; ok {
			var refFields []map[string]json.RawMessage
			if json.Unmarshal(rawRefs, &refFields) != nil || len(refFields) != len(input.References) {
				return generation.Input{}, agent.ErrInvalid
			}
			for i, ref := range input.References {
				for key := range refFields[i] {
					switch key {
					case "kind", "url", "useAudio":
					default:
						return generation.Input{}, agent.ErrInvalid
					}
				}
				if ref.Kind == "video" && refFields[i]["useAudio"] == nil {
					input.References[i].UseAudio = true
				}
				if ref.Kind != "video" && refFields[i]["useAudio"] != nil {
					return generation.Input{}, agent.ErrInvalid
				}
			}
		}
		if options, ok := fields["imageOptions"]; ok {
			var optionFields map[string]json.RawMessage
			if json.Unmarshal(options, &optionFields) != nil {
				return generation.Input{}, agent.ErrInvalid
			}
			for key := range optionFields {
				switch key {
				case "outputFormat", "watermark", "promptOptimization", "background":
				default:
					return generation.Input{}, agent.ErrInvalid
				}
			}
		}
		input.ProjectID, input.NodeID = project, item.NodeID
		input.Model = item.ModelID
	}
	if input.Model == "runninghub-krea2" {
		input.Model = "runninghub/krea2"
	}
	if input.Model == "runninghub-h3" {
		input.Model = "runninghub/h3"
	}
	return input, nil
}

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
		seen := map[string]bool{}
		bindings := map[string]string{}
		modelSnapshots := make([]*generation.WorkflowSnapshot, 0, len(items))
		scopeItems := make([]map[string]any, 0, len(items))
		for _, item := range items {
			input, err := generationInput(item, row.ProjectID)
			if err != nil {
				return err
			}
			if generation.ConnectionForModel(input.Model) == "" {
				snapshot, _, err := generation.ResolveModel(input.Model)
				if err != nil {
					return agent.ErrInvalid
				}
				input.Workflow = snapshot
			}
			modelSnapshots = append(modelSnapshots, input.Workflow)
			binding, nodeType, exists := generationBinding(project.Snapshot, item.NodeID)
			isVideo := generation.ModelCategory(input.Model) == "VIDEO"
			validTarget := isVideo && (nodeType == "textToVideo" || nodeType == "imageToVideo" || nodeType == "startEndToVideo" || nodeType == "video") || !isVideo && (nodeType == "textToImage" || nodeType == "imageToImage" || nodeType == "image")
			if item.NodeID == "" || len(item.NodeID) > 200 || seen[item.NodeID] || !exists || !validTarget || !generation.ModelConfigured(input.Model) || !generation.ValidInput(input) || !ownedGenerationReferences(tx, row.OwnerID, row.ProjectID, item.NodeID, project.Snapshot, input.References) {
				return agent.ErrInvalid
			}
			seen[item.NodeID] = true
			bindings[item.NodeID] = binding
			visible := input
			visible.Workflow = nil
			scopeItems = append(scopeItems, map[string]any{"nodeId": item.NodeID, "modelId": input.Model, "input": visible, "newNode": hasGenerationResult(project.Snapshot, item.NodeID)})
		}
		now := s.Now().UTC()
		if err := tx.Exec(`UPDATE agent_generation_batches SET status='cancelled',updated_at=? WHERE task_id=? AND status='pending'`, now, row.ID).Error; err != nil {
			return err
		}
		bound, _ := json.Marshal(bindings)
		frozen, _ := json.Marshal(modelSnapshots)
		if err := tx.Exec(`INSERT INTO agent_generation_batches(id,task_id,digest,canvas_version,status,items,bindings,model_snapshots,created_at,updated_at) VALUES(?,?,?,?,'pending',?::jsonb,?::jsonb,?::jsonb,?,?)`, id, row.ID, digest, project.Version, string(encoded), string(bound), string(frozen), now, now).Error; err != nil {
			return err
		}
		scope, _ := json.Marshal(map[string]any{"kind": "generation", "batchId": id, "digest": digest, "items": scopeItems})
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
	if err := tx.Exec(`UPDATE agent_generation_batches SET status='cancelled',updated_at=? WHERE task_id=? AND status='pending'`, now, taskID).Error; err != nil {
		return err
	}
	return tx.Exec(`WITH stopped AS (UPDATE generation_tasks SET status='canceled',stage='canceled',updated_at=? WHERE id IN (SELECT jsonb_array_elements_text(generation_task_ids) FROM agent_generation_batches WHERE task_id=? AND status='approved') AND status='queued' RETURNING id,owner_id,project_id,node_id) INSERT INTO generation_task_events(task_id,event_type,stage,occurred_at) SELECT id,'canceled','canceled',? FROM stopped`, now, taskID, now).Error
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
		Bindings       []byte
		ModelSnapshots []byte
	}
	q := tx.Raw(`SELECT digest,status,items,bindings,model_snapshots FROM agent_generation_batches WHERE id=? AND task_id=? FOR UPDATE`, scope.BatchID, row.ID).Scan(&batch)
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
	var bindings map[string]string
	if json.Unmarshal(batch.Bindings, &bindings) != nil {
		return agent.ErrInvalid
	}
	var frozen []*generation.WorkflowSnapshot
	if json.Unmarshal(batch.ModelSnapshots, &frozen) != nil {
		return agent.ErrInvalid
	}
	if len(frozen) == 0 {
		frozen = make([]*generation.WorkflowSnapshot, len(items))
	}
	if len(frozen) != len(items) {
		return agent.ErrConflict
	}
	ids := make([]string, 0, len(items))
	service := generation.Service{Store: generationpostgres.New(tx), Resources: generationpostgres.Resources{DB: tx}}
	for i, item := range items {
		current, _, exists := generationBinding(project.Snapshot, item.NodeID)
		if !exists || current != bindings[item.NodeID] {
			return agent.ErrConflict
		}
		input, err := generationInput(item, row.ProjectID)
		if err != nil {
			return err
		}
		input.Workflow = frozen[i]
		task, err := service.Create(tx.Statement.Context, generation.Actor{ID: row.OwnerID}, scope.BatchID+":"+string(rune('a'+i)), input)
		if err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO agent_generation_submission_bindings(task_id,node_id,digest) VALUES(?,?,?) ON CONFLICT(task_id) DO NOTHING`, task.ID, item.NodeID, bindings[item.NodeID]).Error; err != nil {
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

// RetryGenerationSave only resumes delivery of an already paid provider result.
func (s *Store) RetryGenerationSave(ctx context.Context, token, batchID string) (GenerationBatch, error) {
	batch, err := s.GenerationResults(ctx, token, batchID)
	if err != nil {
		return batch, err
	}
	service := generation.Service{Store: generationpostgres.New(s.DB)}
	row, err := s.activeRun(s.DB.WithContext(ctx), token, false)
	if err != nil {
		return batch, err
	}
	for _, task := range batch.Tasks {
		if task.Status == generation.SaveExhausted || task.Status == "save_failed" {
			if _, err := service.Resume(ctx, generation.Actor{ID: row.OwnerID}, task.ID); err != nil {
				return batch, err
			}
		}
	}
	return s.GenerationResults(ctx, token, batchID)
}
