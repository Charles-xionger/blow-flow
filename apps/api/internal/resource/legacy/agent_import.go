package legacy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"gorm.io/gorm"
)

type LegacyAgentTask struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	Status    string `json:"status"`
	Data      string `json:"data"`
}
type LegacyAgentMessage struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	TaskID    string `json:"task_id"`
	Data      string `json:"data"`
}
type LegacyAgentReceipt struct {
	ProjectID string `json:"project_id"`
	RequestID string `json:"request_id"`
	Digest    string `json:"digest"`
	TaskID    string `json:"task_id"`
}
type LegacyAgentBatch struct {
	ID     string `json:"id"`
	TaskID string `json:"task_id"`
	Data   string `json:"data"`
}
type LegacyAgentCanvasReceipt struct {
	ProjectID string `json:"project_id"`
	Identity  string `json:"identity"`
	Digest    string `json:"digest"`
	Result    string `json:"result"`
}

type oldAgentTask struct {
	ID        string          `json:"id"`
	ProjectID string          `json:"projectId"`
	ModelID   string          `json:"modelId"`
	Status    string          `json:"status"`
	CreatedAt int64           `json:"createdAt"`
	Question  json.RawMessage `json:"question"`
	RunID     string          `json:"runId"`
	Steps     []struct {
		ID        string          `json:"id"`
		RunID     string          `json:"runId"`
		Name      string          `json:"name"`
		Args      json.RawMessage `json:"args"`
		Result    json.RawMessage `json:"result"`
		Status    string          `json:"status"`
		CreatedAt int64           `json:"createdAt"`
	} `json:"steps"`
}
type oldAgentMessage struct {
	ID         string          `json:"id"`
	TaskID     string          `json:"taskId"`
	Role       string          `json:"role"`
	Text       string          `json:"text"`
	References json.RawMessage `json:"references"`
	CreatedAt  int64           `json:"createdAt"`
	RunID      string          `json:"runId"`
}
type oldAgentBatch struct {
	ID        string `json:"id"`
	TaskID    string `json:"taskId"`
	ProjectID string `json:"projectId"`
	Status    string `json:"status"`
}

func uuidLike(s string) bool {
	b, e := hex.DecodeString(strings.ReplaceAll(s, "-", ""))
	return e == nil && len(b) == 16
}
func importedRunID(taskID, callID string) string {
	h := sha256.Sum256([]byte(taskID + ":" + callID))
	v := hex.EncodeToString(h[:16])
	return v[:8] + "-" + v[8:12] + "-" + v[12:16] + "-" + v[16:20] + "-" + v[20:32]
}
func normalizedJSON(v json.RawMessage, fallback string) string {
	if len(v) == 0 || string(v) == "null" {
		return fallback
	}
	return string(v)
}
func (e Export) validateAgents(projects map[string]bool) error {
	tasks := map[string]string{}
	messages := map[string]bool{}
	receipts := map[string]bool{}
	batches := map[string]bool{}
	canvasReceipts := map[string]bool{}
	for _, row := range e.AgentTasks {
		var task oldAgentTask
		if !uuidLike(row.ID) || !projects[row.ProjectID] || tasks[row.ID] != "" || json.Unmarshal([]byte(row.Data), &task) != nil || task.ID != row.ID || task.ProjectID != row.ProjectID || task.Status != row.Status || task.CreatedAt <= 0 || !strings.Contains("|queued|running|waiting|interrupted|completed|failed|stopped|", "|"+task.Status+"|") {
			return fmt.Errorf("invalid legacy agent task %s", row.ID)
		}
		if len(task.Question) > 0 && !json.Valid(task.Question) {
			return errors.New("invalid agent question")
		}
		calls := map[string]bool{}
		for _, step := range task.Steps {
			if step.ID == "" || calls[step.ID] || step.Name == "" || !strings.Contains("|running|completed|failed|", "|"+step.Status+"|") || len(step.Args) > 0 && !json.Valid(step.Args) || len(step.Result) > 0 && !json.Valid(step.Result) {
				return errors.New("invalid legacy agent step")
			}
			calls[step.ID] = true
		}
		tasks[row.ID] = row.ProjectID
	}
	for _, row := range e.AgentMessages {
		var m oldAgentMessage
		if !uuidLike(row.ID) || messages[row.ID] || tasks[row.TaskID] != row.ProjectID || json.Unmarshal([]byte(row.Data), &m) != nil || m.ID != row.ID || m.TaskID != row.TaskID || m.CreatedAt <= 0 || m.Role != "user" && m.Role != "assistant" || len(m.References) > 0 && !json.Valid(m.References) {
			return fmt.Errorf("invalid legacy agent message %s", row.ID)
		}
		messages[row.ID] = true
	}
	for _, row := range e.AgentReceipts {
		key := row.ProjectID + "\x00" + row.RequestID
		if tasks[row.TaskID] != row.ProjectID || !valid(row.RequestID) || row.Digest == "" || receipts[key] {
			return errors.New("invalid legacy agent receipt")
		}
		receipts[key] = true
	}
	for _, row := range e.AgentGenerationBatches {
		var b oldAgentBatch
		if row.ID == "" || batches[row.ID] || tasks[row.TaskID] == "" || json.Unmarshal([]byte(row.Data), &b) != nil || b.ID != row.ID || b.TaskID != row.TaskID || b.ProjectID != tasks[row.TaskID] {
			return errors.New("invalid legacy generation batch")
		}
		batches[row.ID] = true
	}
	for _, row := range e.AgentCanvasReceipts {
		key := row.ProjectID + "\x00" + row.Identity
		if !projects[row.ProjectID] || !valid(row.Identity) || row.Digest == "" || !json.Valid([]byte(row.Result)) || canvasReceipts[key] {
			return errors.New("invalid legacy agent canvas receipt")
		}
		canvasReceipts[key] = true
	}
	return nil
}

func importAgents(tx *gorm.DB, owner string, e Export) error {
	for _, row := range e.AgentTasks {
		var task oldAgentTask
		_ = json.Unmarshal([]byte(row.Data), &task)
		status := task.Status
		question := normalizedJSON(task.Question, "null")
		if status == "queued" || status == "running" || status == "waiting" || status == "interrupted" {
			status = "interrupted"
			question = "null" // Old approval scopes cannot authorize new Go tool calls.
		}
		result := tx.Exec(`INSERT INTO agent_tasks(id,owner_id,project_id,request_id,model_id,status,question,legacy_imported,created_at,updated_at) VALUES(?::uuid,?,?,?, ?,?,?::jsonb,true,?,?) ON CONFLICT(id) DO NOTHING`, row.ID, owner, row.ProjectID, "legacy:"+row.ID, task.ModelID, status, question, timestamp(task.CreatedAt), timestamp(task.CreatedAt))
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return fmt.Errorf("agent task ID collision: %s", row.ID)
		}
		if err := tx.Exec(`INSERT INTO agent_legacy_task_snapshots(task_id,data) VALUES(?::uuid,?::jsonb)`, row.ID, row.Data).Error; err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO agent_task_events(task_id,kind,created_at) VALUES(?::uuid,'imported',?)`, row.ID, timestamp(task.CreatedAt)).Error; err != nil {
			return err
		}
		for _, step := range task.Steps {
			runID := step.RunID
			if !uuidLike(runID) {
				runID = task.RunID
			}
			if !uuidLike(runID) {
				runID = importedRunID(row.ID, step.ID)
			}
			status := step.Status
			result := normalizedJSON(step.Result, "null")
			if status == "running" {
				status = "failed"
				result = `{"error":"Legacy step interrupted during migration; no automatic replay"}`
			}
			created := step.CreatedAt
			if created <= 0 {
				created = task.CreatedAt
			}
			args := normalizedJSON(step.Args, "{}")
			h := sha256.Sum256([]byte(args))
			if err := tx.Exec(`INSERT INTO agent_tool_steps(task_id,call_id,run_id,name,arguments,digest,status,result,created_at,updated_at) VALUES(?::uuid,?,?::uuid,?,?::jsonb,?,?,?::jsonb,?,?)`, row.ID, step.ID, runID, step.Name, args, hex.EncodeToString(h[:]), status, result, timestamp(created), timestamp(created)).Error; err != nil {
				return err
			}
		}
	}
	for _, row := range e.AgentMessages {
		var m oldAgentMessage
		_ = json.Unmarshal([]byte(row.Data), &m)
		var runID any
		if uuidLike(m.RunID) {
			runID = m.RunID
		}
		if err := tx.Exec(`INSERT INTO agent_messages(id,task_id,project_id,role,text,reference_items,run_id,created_at) VALUES(?::uuid,?::uuid,?,?,?,?::jsonb,?::uuid,?)`, row.ID, row.TaskID, row.ProjectID, m.Role, m.Text, normalizedJSON(m.References, "[]"), runID, timestamp(m.CreatedAt)).Error; err != nil {
			return err
		}
	}
	for _, row := range e.AgentReceipts {
		if err := tx.Exec(`INSERT INTO agent_legacy_command_receipts(project_id,request_id,digest,task_id) VALUES(?,?,?,?::uuid)`, row.ProjectID, row.RequestID, row.Digest, row.TaskID).Error; err != nil {
			return err
		}
	}
	for _, row := range e.AgentCanvasReceipts {
		if err := tx.Exec(`INSERT INTO agent_legacy_canvas_receipts(project_id,identity,digest,result) VALUES(?,?,?,?::jsonb)`, row.ProjectID, row.Identity, row.Digest, row.Result).Error; err != nil {
			return err
		}
	}
	for _, row := range e.AgentGenerationBatches {
		if err := tx.Exec(`INSERT INTO agent_legacy_generation_batches(id,task_id,data) VALUES(?,?::uuid,?::jsonb)`, row.ID, row.TaskID, row.Data).Error; err != nil {
			return err
		}
	}
	return nil
}
