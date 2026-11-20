package postgres

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"sort"
	"strings"
	"time"

	"blow-flow/api/internal/agent"
	generationpostgres "blow-flow/api/internal/generation/postgres"
	"blow-flow/api/internal/resource"
	resourcepostgres "blow-flow/api/internal/resource/postgres"
	"github.com/jackc/pgx/v5/pgconn"
	"gorm.io/gorm"
)

const leaseDuration = 60 * time.Second

type Store struct {
	DB  *gorm.DB
	Now func() time.Time
}

func New(db *gorm.DB) *Store { return &Store{DB: db, Now: time.Now} }

type taskRow struct {
	ID, OwnerID, ProjectID, RequestID, ModelID, Status string
	RunID                                              *string
	RunHash                                            []byte
	LeaseUntil                                         *time.Time
	Question                                           []byte
	EditableNodeIDs                                    []byte
	DeleteGrants                                       []byte
	CreatedAt, UpdatedAt                               time.Time
	LegacyImported                                     bool
}

func (r taskRow) task() agent.Task {
	task := agent.Task{ID: r.ID, OwnerID: r.OwnerID, ProjectID: r.ProjectID, ModelID: r.ModelID, Status: r.Status, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt}
	task.LegacyImported = r.LegacyImported
	if len(r.Question) > 0 {
		var q agent.Question
		if json.Unmarshal(r.Question, &q) == nil {
			task.Question = &q
		}
	}
	_ = json.Unmarshal(r.EditableNodeIDs, &task.EditableNodeIDs)
	_ = json.Unmarshal(r.DeleteGrants, &task.DeleteGrants)
	return task
}

func uuid() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	v := hex.EncodeToString(b[:])
	return v[:8] + "-" + v[8:12] + "-" + v[12:16] + "-" + v[16:20] + "-" + v[20:], nil
}
func runSecret() (string, []byte, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", nil, err
	}
	h := sha256.Sum256(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:]), h[:], nil
}
func parseRunToken(raw string) (string, []byte, bool) {
	if len(raw) > 120 {
		return "", nil, false
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 2 || len(parts[0]) != 36 {
		return "", nil, false
	}
	secret, err := base64.RawURLEncoding.DecodeString(parts[1])
	return parts[0], secret, err == nil && len(secret) == 32
}
func duplicate(err error) bool { var p *pgconn.PgError; return errors.As(err, &p) && p.Code == "23505" }

func (s *Store) Enqueue(ctx context.Context, owner, project, requestID string) (agent.Task, error) {
	if owner == "" || project == "" || requestID == "" || len(requestID) > 200 {
		return agent.Task{}, agent.ErrInvalid
	}
	id, err := uuid()
	if err != nil {
		return agent.Task{}, err
	}
	var out agent.Task
	err = s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var p struct {
			ID                  string
			DeletedAt, PurgedAt *time.Time
		}
		q := tx.Raw(`SELECT id,deleted_at,purged_at FROM projects WHERE id=? AND owner_id=? FOR UPDATE`, project, owner).Scan(&p)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected != 1 || p.DeletedAt != nil || p.PurgedAt != nil {
			return agent.ErrNotFound
		}
		var previous taskRow
		q = tx.Raw(`SELECT id,owner_id,project_id,model_id,status,question,created_at,updated_at FROM agent_tasks WHERE owner_id=? AND request_id=?`, owner, requestID).Scan(&previous)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected > 0 {
			if previous.ProjectID != project {
				return agent.ErrRequestConflict
			}
			out = previous.task()
			return nil
		}
		now := s.Now().UTC()
		if err := tx.Exec(`INSERT INTO agent_tasks(id,owner_id,project_id,request_id,status,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?)`, id, owner, project, requestID, now, now).Error; err != nil {
			if duplicate(err) {
				return agent.ErrConflict
			}
			return err
		}
		if err := event(tx, id, "queued", now); err != nil {
			return err
		}
		out = agent.Task{ID: id, OwnerID: owner, ProjectID: project, Status: "queued", CreatedAt: now, UpdatedAt: now}
		return nil
	})
	return out, err
}

func event(tx *gorm.DB, taskID, kind string, at time.Time) error {
	return tx.Exec(`INSERT INTO agent_task_events(task_id,kind,created_at) VALUES(?,?,?)`, taskID, kind, at).Error
}

func (s *Store) Claim(ctx context.Context, taskID string) (agent.Run, error) {
	var out agent.Run
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row taskRow
		q := tx.Raw(`SELECT id,owner_id,project_id,model_id,status,question,legacy_imported,created_at,updated_at FROM agent_tasks WHERE id=? FOR UPDATE`, taskID).Scan(&row)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected != 1 {
			return agent.ErrNotFound
		}
		if row.Status != "queued" || row.LegacyImported {
			return agent.ErrConflict
		}
		runID, err := uuid()
		if err != nil {
			return err
		}
		secret, hash, err := runSecret()
		if err != nil {
			return err
		}
		now := s.Now().UTC()
		lease := now.Add(leaseDuration)
		if err := tx.Exec(`UPDATE agent_tasks SET status='running',run_id=?,run_hash=?,lease_until=?,claimed_user_count=(SELECT count(*) FROM agent_messages WHERE task_id=? AND role='user'),updated_at=? WHERE id=?`, runID, hash, lease, taskID, now, taskID).Error; err != nil {
			return err
		}
		if err := event(tx, taskID, "running", now); err != nil {
			return err
		}
		row.Status = "running"
		row.UpdatedAt = now
		out = agent.Run{Task: row.task(), RunID: runID, Token: runID + "." + secret, LeaseUntil: lease}
		return nil
	})
	return out, err
}

func (s *Store) activeRun(tx *gorm.DB, token string, lock bool) (taskRow, error) {
	id, secret, ok := parseRunToken(token)
	if !ok {
		return taskRow{}, agent.ErrRunExpired
	}
	query := `SELECT id,owner_id,project_id,model_id,status,question,run_id,run_hash,lease_until,editable_node_ids,delete_grants,created_at,updated_at FROM agent_tasks WHERE run_id=?`
	if lock {
		query += ` FOR UPDATE`
	}
	var row taskRow
	q := tx.Raw(query, id).Scan(&row)
	if q.Error != nil {
		return taskRow{}, q.Error
	}
	hash := sha256.Sum256(secret)
	if q.RowsAffected != 1 || row.Status != "running" || row.LeaseUntil == nil || !row.LeaseUntil.After(s.Now()) || !hmac.Equal(row.RunHash, hash[:]) {
		return taskRow{}, agent.ErrRunExpired
	}
	return row, nil
}

func (s *Store) Heartbeat(ctx context.Context, token string) (time.Time, error) {
	var lease time.Time
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := s.activeRun(tx, token, true)
		if err != nil {
			return err
		}
		lease = s.Now().UTC().Add(leaseDuration)
		return tx.Exec(`UPDATE agent_tasks SET lease_until=?,updated_at=? WHERE id=?`, lease, s.Now().UTC(), row.ID).Error
	})
	return lease, err
}

func (s *Store) ReadCanvas(ctx context.Context, token string) (agent.Canvas, error) {
	var out agent.Canvas
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := s.activeRun(tx, token, false)
		if err != nil {
			return err
		}
		var p struct {
			Snapshot            []byte
			Version             int64
			DeletedAt, PurgedAt *time.Time
		}
		q := tx.Raw(`SELECT snapshot,version,deleted_at,purged_at FROM projects WHERE id=? AND owner_id=?`, row.ProjectID, row.OwnerID).Scan(&p)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected != 1 || p.DeletedAt != nil || p.PurgedAt != nil {
			return agent.ErrNotFound
		}
		out = agent.Canvas{Snapshot: p.Snapshot, Version: p.Version}
		return nil
	})
	return out, err
}

func (s *Store) DeletedNodes(ctx context.Context, token string, ids []string) ([]string, error) {
	var out []string
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := s.activeRun(tx, token, false)
		if err != nil {
			return err
		}
		out, err = (resource.Service{Repository: resourcepostgres.New(tx)}).DeletedNodes(ctx, row.OwnerID, row.ProjectID, ids)
		return err
	})
	return out, err
}

func (s *Store) CanvasReceipt(ctx context.Context, token, callID string) (agent.CanvasReceipt, bool, error) {
	if callID == "" || len(callID) > 80 {
		return agent.CanvasReceipt{}, false, agent.ErrInvalid
	}
	var out agent.CanvasReceipt
	found := false
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := s.activeRun(tx, token, false)
		if err != nil {
			return err
		}
		var value struct{ Result []byte }
		q := tx.Raw(`SELECT result FROM agent_canvas_receipts WHERE task_id=? AND call_id=?`, row.ID, callID).Scan(&value)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected == 0 {
			return nil
		}
		found = true
		return json.Unmarshal(value.Result, &out)
	})
	return out, found, err
}

func (s *Store) Finish(ctx context.Context, token, status string) error {
	if status != "completed" && status != "waiting" && status != "failed" && status != "stopped" {
		return agent.ErrInvalid
	}
	return s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := s.activeRun(tx, token, true)
		if err != nil {
			return err
		}
		now := s.Now().UTC()
		if status == "completed" {
			var counts struct{ Seen, Current int64 }
			if err := tx.Raw(`SELECT claimed_user_count AS seen,(SELECT count(*) FROM agent_messages WHERE task_id=? AND role='user') AS current FROM agent_tasks WHERE id=?`, row.ID, row.ID).Scan(&counts).Error; err != nil {
				return err
			}
			if counts.Current > counts.Seen {
				status = "queued"
			}
		}
		if err := tx.Exec(`UPDATE agent_tasks SET status=?,run_id=NULL,run_hash=NULL,lease_until=NULL,updated_at=? WHERE id=?`, status, now, row.ID).Error; err != nil {
			return err
		}
		if err := event(tx, row.ID, status, now); err != nil {
			return err
		}
		if status == "queued" {
			return wake(tx, row.ID)
		}
		return nil
	})
}

func (s *Store) InterruptExpired(ctx context.Context) (int64, error) {
	now := s.Now().UTC()
	var ids []string
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Raw(`UPDATE agent_tasks SET status='interrupted',run_id=NULL,run_hash=NULL,lease_until=NULL,updated_at=? WHERE status='running' AND lease_until<=? RETURNING id`, now, now).Scan(&ids).Error; err != nil {
			return err
		}
		for _, id := range ids {
			if err := event(tx, id, "interrupted", now); err != nil {
				return err
			}
		}
		return nil
	})
	return int64(len(ids)), err
}

func digestCommit(input agent.Commit) (string, error) {
	var value any
	decoder := json.NewDecoder(bytes.NewReader(input.Snapshot))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return "", agent.ErrInvalid
	}
	var operations any
	decoder = json.NewDecoder(bytes.NewReader(input.Operations))
	decoder.UseNumber()
	if err := decoder.Decode(&operations); err != nil {
		return "", agent.ErrInvalid
	}
	encoded, err := json.Marshal(struct {
		BaseVersion int64    `json:"baseVersion"`
		Label       string   `json:"label"`
		Operations  any      `json:"operations"`
		Snapshot    any      `json:"snapshot"`
		Skipped     []string `json:"skipped"`
	}{input.BaseVersion, input.Label, operations, value, input.Skipped})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

func (s *Store) CommitCanvas(ctx context.Context, token string, input agent.Commit) (agent.CanvasReceipt, error) {
	if input.CallID == "" || len(input.CallID) > 80 || len(input.Label) > 200 || input.BaseVersion < 1 || len(input.Operations) == 0 || len(input.Snapshot) == 0 || len(input.Snapshot) > 10<<20 {
		return agent.CanvasReceipt{}, agent.ErrInvalid
	}
	digest, err := digestCommit(input)
	if err != nil {
		return agent.CanvasReceipt{}, err
	}
	var out agent.CanvasReceipt
	err = s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := s.activeRun(tx, token, true)
		if err != nil {
			return err
		}
		var receipt struct {
			Digest string
			Result []byte
		}
		q := tx.Raw(`SELECT digest,result FROM agent_canvas_receipts WHERE task_id=? AND call_id=?`, row.ID, input.CallID).Scan(&receipt)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected > 0 {
			if receipt.Digest != digest {
				return agent.ErrRequestConflict
			}
			return json.Unmarshal(receipt.Result, &out)
		}
		var p struct {
			Snapshot            []byte
			Version             int64
			DeletedAt, PurgedAt *time.Time
		}
		q = tx.Raw(`SELECT snapshot,version,deleted_at,purged_at FROM projects WHERE id=? AND owner_id=? FOR UPDATE`, row.ProjectID, row.OwnerID).Scan(&p)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected != 1 || p.DeletedAt != nil || p.PurgedAt != nil {
			return agent.ErrNotFound
		}
		if p.Version != input.BaseVersion {
			return agent.ErrConflict
		}
		var editable, grants []string
		if json.Unmarshal(row.EditableNodeIDs, &editable) != nil || json.Unmarshal(row.DeleteGrants, &grants) != nil {
			return agent.ErrInvalid
		}
		created, removed, err := validateCanvasEdit(p.Snapshot, input.Snapshot, input.Operations, editable, grants)
		if err != nil {
			return err
		}
		if len(removed) > 0 {
			var operations []struct {
				Kind string `json:"kind"`
				ID   string `json:"id"`
			}
			if json.Unmarshal(input.Operations, &operations) != nil {
				return agent.ErrInvalid
			}
			requested := []string{}
			for _, operation := range operations {
				if operation.Kind == "delete" {
					requested = append(requested, operation.ID)
				}
			}
			sort.Strings(requested)
			sort.Strings(grants)
			if !reflect.DeepEqual(requested, grants) {
				return agent.ErrForbidden
			}
		}
		if len(created) > 0 {
			var tombstones int64
			if err := tx.Raw(`SELECT count(*) FROM project_deleted_nodes WHERE project_id=? AND node_id IN ?`, row.ProjectID, created).Scan(&tombstones).Error; err != nil {
				return err
			}
			if tombstones > 0 {
				return agent.ErrForbidden
			}
		}
		writer := resource.Service{Repository: resourcepostgres.New(tx)}
		ack, err := writer.SaveCanvas(ctx, row.OwnerID, row.ProjectID, resource.SaveCanvas{RequestID: "agent:" + row.ID + ":" + input.CallID, BaseVersion: input.BaseVersion, Snapshot: input.Snapshot})
		if err != nil {
			return err
		}
		oldGraph, err := parseGraph(p.Snapshot)
		if err != nil {
			return err
		}
		newGraph, err := parseGraph(input.Snapshot)
		if err != nil {
			return err
		}
		newNodes, _, err := keyed(newGraph.nodes)
		if err != nil {
			return err
		}
		removedNodes := make([]map[string]any, 0)
		for _, node := range oldGraph.nodes {
			if newNodes[idOf(node)] == nil {
				removedNodes = append(removedNodes, node)
			}
		}
		removedJSON, err := json.Marshal(removedNodes)
		if err != nil {
			return err
		}
		if err := generationpostgres.DetachRemovedNodes(tx, row.OwnerID, row.ProjectID, generationNodeIDs(removedNodes), s.Now().UTC()); err != nil {
			return err
		}
		out = agent.CanvasReceipt{Version: ack.Version, Label: input.Label, Skipped: input.Skipped, Operations: input.Operations, RemovedNodes: removedJSON}
		encoded, err := json.Marshal(out)
		if err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO agent_canvas_receipts(task_id,call_id,digest,result,created_at) VALUES(?,?,?,?::jsonb,?)`, row.ID, input.CallID, digest, string(encoded), s.Now().UTC()).Error; err != nil {
			return err
		}
		if len(created) > 0 {
			ids, _ := json.Marshal(created)
			if err := tx.Exec(`UPDATE agent_tasks SET editable_node_ids=(SELECT COALESCE(jsonb_agg(DISTINCT value),'[]'::jsonb) FROM jsonb_array_elements_text(editable_node_ids || ?::jsonb) AS value) WHERE id=?`, string(ids), row.ID).Error; err != nil {
				return err
			}
		}
		if len(removed) > 0 {
			ids, _ := json.Marshal(removed)
			if err := tx.Exec(`UPDATE agent_tasks SET delete_grants=(SELECT COALESCE(jsonb_agg(value),'[]'::jsonb) FROM jsonb_array_elements_text(delete_grants) AS value WHERE NOT value IN (SELECT jsonb_array_elements_text(?::jsonb))) WHERE id=?`, string(ids), row.ID).Error; err != nil {
				return err
			}
		}
		return event(tx, row.ID, "canvas_committed", s.Now().UTC())
	})
	return out, err
}

func generationNodeIDs(nodes []map[string]any) []string {
	ids := make([]string, 0, len(nodes))
	seen := map[string]bool{}
	for _, node := range nodes {
		id := idOf(node)
		if data := data(node); data != nil {
			if value, ok := data["generationNodeId"].(string); ok && value != "" {
				id = value
			}
		}
		if id != "" && !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	return ids
}
