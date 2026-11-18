package postgres

import (
	"blow-flow/api/internal/resource"
	resourcepostgres "blow-flow/api/internal/resource/postgres"
	"blow-flow/api/internal/script"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"gorm.io/gorm"
)

type Store struct {
	DB               *gorm.DB
	Notify           func(context.Context, string)
	MaxConcurrent    int
	CircuitCooldown  time.Duration
	MaxQueuedPerUser int
}

func New(db *gorm.DB) *Store { return &Store{DB: db} }
func (s *Store) notify(ctx context.Context, id string) {
	if s.Notify != nil {
		s.Notify(ctx, id)
	}
}

type row struct {
	ID, OwnerID, ProjectID, NodeID, RequestID, Status, Phase, Text string
	Input, Workflow                                                []byte
	OutputNodeID, Error                                            *string
	OutputSaved                                                    bool
	Revision                                                       int64
	LeaseID                                                        *string
	CreatedAt, UpdatedAt                                           time.Time
}

func (r row) task() (script.Task, error) {
	var input script.Input
	if err := json.Unmarshal(r.Input, &input); err != nil {
		return script.Task{}, err
	}
	t := script.Task{ID: r.ID, RequestID: r.RequestID, CanvasID: r.ProjectID, NodeID: r.NodeID, Input: input, Status: r.Status, Phase: r.Phase, Text: r.Text, Workflow: r.Workflow, OutputSaved: r.OutputSaved, Revision: r.Revision, CreatedAt: r.CreatedAt.UnixMilli(), UpdatedAt: r.UpdatedAt.UnixMilli()}
	if r.OutputNodeID != nil {
		t.OutputNodeID = *r.OutputNodeID
	}
	if r.Error != nil {
		t.Error = *r.Error
	}
	return t, nil
}
func uuid() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}

func projectSnapshot(tx *gorm.DB, owner, project string) ([]byte, error) {
	var p struct {
		Snapshot            []byte
		DeletedAt, PurgedAt *time.Time
	}
	q := tx.Raw(`SELECT snapshot,deleted_at,purged_at FROM projects WHERE id=? AND owner_id=? FOR UPDATE`, project, owner).Scan(&p)
	if q.Error != nil {
		return nil, q.Error
	}
	if q.RowsAffected == 0 || p.DeletedAt != nil || p.PurgedAt != nil {
		return nil, script.ErrNotFound
	}
	return p.Snapshot, nil
}
func (s *Store) LookupRequest(ctx context.Context, owner string, request script.Create) (script.Task, bool, error) {
	input, err := json.Marshal(request.Input)
	if err != nil {
		return script.Task{}, false, err
	}
	var alias struct {
		TaskID string
		Match  bool
	}
	q := s.DB.WithContext(ctx).Raw(`SELECT task_id,project_id=? AND node_id=? AND input=?::jsonb AS match FROM script_requests WHERE owner_id=? AND request_id=?`, request.CanvasID, request.NodeID, string(input), owner, request.RequestID).Scan(&alias)
	if q.Error != nil {
		return script.Task{}, false, q.Error
	}
	if q.RowsAffected == 0 {
		return script.Task{}, false, nil
	}
	if !alias.Match {
		return script.Task{}, false, script.ErrConflict
	}
	task, err := s.Get(ctx, owner, alias.TaskID)
	return task, true, err
}
func (s *Store) Create(ctx context.Context, owner string, request script.Create) (script.Task, error) {
	id, err := uuid()
	if err != nil {
		return script.Task{}, err
	}
	input, err := json.Marshal(request.Input)
	if err != nil {
		return script.Task{}, err
	}
	resolvedID := id
	err = s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		snapshot, err := projectSnapshot(tx, owner, request.CanvasID)
		if err != nil {
			return err
		}
		var alias struct {
			TaskID string
			Match  bool
		}
		q := tx.Raw(`SELECT task_id,project_id=? AND node_id=? AND input=?::jsonb AS match FROM script_requests WHERE owner_id=? AND request_id=?`, request.CanvasID, request.NodeID, string(input), owner, request.RequestID).Scan(&alias)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected > 0 {
			if !alias.Match {
				return script.ErrConflict
			}
			resolvedID = alias.TaskID
			return nil
		}
		if err := tx.Exec(`SELECT pg_advisory_xact_lock(hashtext(?))`, owner+":script-queue").Error; err != nil {
			return err
		}
		limit := s.MaxQueuedPerUser
		if limit < 1 {
			limit = 100
		}
		var queued int64
		if err := tx.Raw(`SELECT count(*) FROM script_tasks WHERE owner_id=? AND status='queued'`, owner).Scan(&queued).Error; err != nil {
			return err
		}
		if queued >= int64(limit) {
			return script.ErrQueueFull
		}
		refs := make([]resourcepostgres.ScriptReference, 0, len(request.Input.References))
		for _, r := range request.Input.References {
			refs = append(refs, resourcepostgres.ScriptReference{NodeID: r.NodeID, Label: r.Label, Type: r.Type, Content: r.Content})
		}
		if err := (resourcepostgres.ScriptCanvas{}).ValidateSource(snapshot, request.NodeID, request.Input.Requirements, refs); err != nil {
			return script.ErrConflict
		}
		for _, ref := range request.Input.References {
			if ref.Type != "image" {
				continue
			}
			var count int64
			if err := tx.Raw(`SELECT (SELECT count(*) FROM media_assets WHERE owner_id=? AND kind='image' AND url=?) + (SELECT count(*) FROM generation_tasks WHERE owner_id=? AND project_id=? AND status='completed' AND result_url=?)`, owner, ref.Content, owner, request.CanvasID, ref.Content).Scan(&count).Error; err != nil {
				return err
			}
			if count == 0 {
				return script.ErrConflict
			}
		}
		var active int64
		if err := tx.Raw(`SELECT count(*) FROM script_tasks WHERE project_id=? AND node_id=? AND status IN ('queued','running','stopping')`, request.CanvasID, request.NodeID).Scan(&active).Error; err != nil {
			return err
		}
		if active > 0 {
			return script.ErrConflict
		}
		if request.Input.OutputMode == "workflow" {
			var previous row
			q = tx.Raw(`SELECT * FROM script_tasks WHERE owner_id=? AND project_id=? AND node_id=? AND input=?::jsonb ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, owner, request.CanvasID, request.NodeID, string(input)).Scan(&previous)
			if q.Error != nil {
				return q.Error
			}
			if q.RowsAffected > 0 && (previous.Status == "failed" || previous.Status == "stopped" || previous.Status == "interrupted") && len(previous.Workflow) > 0 {
				reset, err := script.ResetWorkflow(previous.Workflow)
				if err != nil {
					return err
				}
				resolvedID = previous.ID
				if err := tx.Exec(`UPDATE script_tasks SET request_id=?,status='queued',phase='preparing',workflow=?::jsonb,error=NULL,lease_id=NULL,lease_until=NULL,revision=revision+1,updated_at=now() WHERE id=?`, request.RequestID, string(reset), previous.ID).Error; err != nil {
					return err
				}
				if err := tx.Exec(`INSERT INTO script_requests(owner_id,request_id,task_id,project_id,node_id,input) VALUES(?,?,?,?,?,?::jsonb)`, owner, request.RequestID, previous.ID, request.CanvasID, request.NodeID, string(input)).Error; err != nil {
					return err
				}
				if err := tx.Exec(`INSERT INTO script_task_events(task_id,event_type,phase) VALUES(?,'retried','queued')`, previous.ID).Error; err != nil {
					return err
				}
				return tx.Exec(`INSERT INTO script_outbox(task_id,published_at) VALUES(?,NULL) ON CONFLICT(task_id) DO UPDATE SET published_at=NULL`, previous.ID).Error
			}
		}
		var outputID *string
		var workflow *string
		if request.Input.OutputMode == "workflow" {
			raw, e := json.Marshal(script.NewWorkflow())
			if e != nil {
				return e
			}
			value := string(raw)
			workflow = &value
			outputID = &request.NodeID
		} else {
			value, e := (resourcepostgres.ScriptCanvas{}).InsertOutput(tx, owner, request.CanvasID, resourcepostgres.ScriptOutput{Preset: request.Input.Preset, Mode: request.Input.OutputMode, SourceID: request.NodeID, TaskID: id, Storyboard: request.Input.Storyboard})
			if e != nil {
				if errors.Is(e, resource.ErrConflict) {
					return script.ErrConflict
				}
				return e
			}
			outputID = &value
		}
		if err := tx.Exec(`INSERT INTO script_tasks(id,owner_id,project_id,node_id,request_id,input,status,output_node_id,output_saved,workflow) VALUES(?,?,?,?,?,?::jsonb,'queued',?,?,?::jsonb)`, id, owner, request.CanvasID, request.NodeID, request.RequestID, string(input), outputID, request.Input.OutputMode == "workflow", workflow).Error; err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO script_requests(owner_id,request_id,task_id,project_id,node_id,input) VALUES(?,?,?,?,?,?::jsonb)`, owner, request.RequestID, id, request.CanvasID, request.NodeID, string(input)).Error; err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO script_outbox(task_id) VALUES(?)`, id).Error; err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO script_task_events(task_id,event_type,phase) VALUES(?,'created','queued')`, id).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return script.Task{}, script.ErrConflict
		}
		return script.Task{}, err
	}
	result, err := s.Get(ctx, owner, resolvedID)
	if err == nil {
		s.notify(ctx, result.ID)
	}
	return result, err
}
func (s *Store) Get(ctx context.Context, owner, id string) (script.Task, error) {
	var r row
	q := s.DB.WithContext(ctx).Raw(`SELECT * FROM script_tasks WHERE id=? AND owner_id=?`, id, owner).Scan(&r)
	if q.Error != nil {
		return script.Task{}, q.Error
	}
	if q.RowsAffected == 0 {
		return script.Task{}, script.ErrNotFound
	}
	return r.task()
}
func (s *Store) List(ctx context.Context, owner, project, nodeID string) ([]script.Task, error) {
	var rows []row
	query := `SELECT * FROM script_tasks WHERE owner_id=? AND project_id=?`
	args := []any{owner, project}
	if nodeID != "" {
		query += " AND node_id=?"
		args = append(args, nodeID)
	}
	query += " ORDER BY created_at DESC,id DESC LIMIT 100"
	if err := s.DB.WithContext(ctx).Raw(query, args...).Scan(&rows).Error; err != nil {
		return nil, err
	}
	tasks := make([]script.Task, 0, len(rows))
	for _, r := range rows {
		t, err := r.task()
		if err != nil {
			return nil, err
		}
		tasks = append(tasks, t)
	}
	return tasks, nil
}
func (s *Store) Stop(ctx context.Context, owner, id string) (script.Task, error) {
	changed := false
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var r row
		q := tx.Raw(`SELECT * FROM script_tasks WHERE id=? AND owner_id=? FOR UPDATE`, id, owner).Scan(&r)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected == 0 {
			return script.ErrNotFound
		}
		if r.Status != "queued" && r.Status != "running" {
			return nil
		}
		status := "stopping"
		saved := r.OutputSaved
		if r.Status == "queued" {
			status = "stopped"
			saved = true
		}
		if err := tx.Exec(`UPDATE script_tasks SET status=?,output_saved=?,revision=revision+1,updated_at=now() WHERE id=?`, status, saved, id).Error; err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO script_task_events(task_id,event_type,phase) VALUES(?,?,?)`, id, status, r.Phase).Error; err != nil {
			return err
		}
		changed = true
		return nil
	})
	if err != nil {
		return script.Task{}, err
	}
	t, err := s.Get(ctx, owner, id)
	if err == nil && changed {
		s.notify(ctx, id)
	}
	return t, err
}
func (s *Store) Claim(ctx context.Context, id string, leaseFor time.Duration) (*script.Claimed, error) {
	lease, err := uuid()
	if err != nil {
		return nil, err
	}
	var claimed *script.Claimed
	err = s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(`SELECT pg_advisory_xact_lock(hashtext('script_capacity'))`).Error; err != nil {
			return err
		}
		limit := s.MaxConcurrent
		if limit < 1 {
			limit = 5
		}
		var running int64
		if err := tx.Raw(`SELECT count(*) FROM script_tasks WHERE status IN ('running','stopping')`).Scan(&running).Error; err != nil {
			return err
		}
		if running >= int64(limit) {
			return nil
		}
		var r row
		q := tx.Raw(`SELECT * FROM script_tasks WHERE id=? AND status='queued' AND next_attempt_at<=now() FOR UPDATE SKIP LOCKED`, id).Scan(&r)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected == 0 {
			return nil
		}
		var active bool
		if err := tx.Raw(`SELECT deleted_at IS NULL AND purged_at IS NULL FROM projects WHERE id=? AND owner_id=?`, r.ProjectID, r.OwnerID).Scan(&active).Error; err != nil {
			return err
		}
		if !active {
			if err := tx.Exec(`UPDATE script_tasks SET status='stopped',output_saved=true,error='项目已删除',revision=revision+1,updated_at=now() WHERE id=?`, id).Error; err != nil {
				return err
			}
			return tx.Exec(`INSERT INTO script_task_events(task_id,event_type,phase) VALUES(?,'stopped','queued')`, id).Error
		}
		if err := tx.Exec(`UPDATE script_tasks SET status='running',lease_id=?,lease_until=?,revision=revision+1,updated_at=now() WHERE id=?`, lease, time.Now().Add(leaseFor), id).Error; err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO script_task_events(task_id,event_type,phase) VALUES(?,'started','running')`, id).Error; err != nil {
			return err
		}
		r.Status = "running"
		r.LeaseID = &lease
		r.Revision++
		t, err := r.task()
		if err != nil {
			return err
		}
		claimed = &script.Claimed{Task: t, Lease: lease, Owner: r.OwnerID}
		return nil
	})
	if claimed != nil {
		s.notify(ctx, id)
	}
	return claimed, err
}
func (s *Store) Heartbeat(ctx context.Context, id, lease string, forDuration time.Duration) (bool, error) {
	q := s.DB.WithContext(ctx).Exec(`UPDATE script_tasks SET lease_until=? WHERE id=? AND lease_id=? AND lease_until>now() AND status='running'`, time.Now().Add(forDuration), id, lease)
	return q.RowsAffected > 0, q.Error
}
func (s *Store) SetPhase(ctx context.Context, id, lease, phase string) (bool, error) {
	if !strings.Contains("|preparing|connecting|waiting|thinking|writing|", "|"+phase+"|") {
		return false, script.ErrInvalid
	}
	changed := false
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		q := tx.Exec(`UPDATE script_tasks SET phase=?,revision=revision+1,updated_at=now() WHERE id=? AND lease_id=? AND lease_until>now() AND status='running' AND phase<>?`, phase, id, lease, phase)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected == 0 {
			return nil
		}
		changed = true
		return tx.Exec(`INSERT INTO script_task_events(task_id,event_type,phase) VALUES(?,'phase',?)`, id, phase).Error
	})
	if changed {
		s.notify(ctx, id)
	}
	return changed, err
}
func (s *Store) Append(ctx context.Context, id, lease, delta string) (bool, error) {
	if delta == "" {
		return true, nil
	}
	q := s.DB.WithContext(ctx).Exec(`UPDATE script_tasks SET text=text||?,phase='writing',revision=revision+1,updated_at=now() WHERE id=? AND lease_id=? AND lease_until>now() AND status='running' AND length(text)+length(?)<=200000`, delta, id, lease, delta)
	if q.RowsAffected > 0 {
		s.notify(ctx, id)
	}
	return q.RowsAffected > 0, q.Error
}
func (s *Store) UpdateWorkflow(ctx context.Context, id, lease string, state script.Workflow, eventType, eventPhase string, allowStopping bool) (bool, error) {
	raw, err := json.Marshal(state)
	if err != nil {
		return false, err
	}
	status := "running"
	if allowStopping {
		status = "stopping"
	}
	changed := false
	err = s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		q := tx.Exec(`UPDATE script_tasks SET workflow=?::jsonb,text=?,revision=revision+1,updated_at=now() WHERE id=? AND lease_id=? AND lease_until>now() AND status IN (?,'running')`, string(raw), state.Text(), id, lease, status)
		if q.Error != nil {
			return q.Error
		}
		changed = q.RowsAffected > 0
		if changed && eventType != "" {
			return tx.Exec(`INSERT INTO script_task_events(task_id,event_type,phase) VALUES(?,?,?)`, id, eventType, eventPhase).Error
		}
		return nil
	})
	if changed {
		s.notify(ctx, id)
	}
	return changed, err
}
func (s *Store) Finish(ctx context.Context, id, lease, status, message string) error {
	if status != "completed" && status != "failed" && status != "stopped" {
		return script.ErrInvalid
	}
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var r row
		q := tx.Raw(`SELECT * FROM script_tasks WHERE id=? AND lease_id=? AND lease_until>now() FOR UPDATE`, id, lease).Scan(&r)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected == 0 {
			return nil
		}
		if r.Status == "stopping" {
			status = "stopped"
			message = ""
		}
		if r.Status != "running" && r.Status != "stopping" {
			return nil
		}
		if err := saveOutput(tx, r); err != nil {
			return err
		}
		if err := tx.Exec(`UPDATE script_tasks SET status=?,output_saved=true,error=NULLIF(?,''),lease_id=NULL,lease_until=NULL,revision=revision+1,updated_at=now() WHERE id=?`, status, message, id).Error; err != nil {
			return err
		}
		return tx.Exec(`INSERT INTO script_task_events(task_id,event_type,phase) VALUES(?,?,?)`, id, status, r.Phase).Error
	})
	if err == nil {
		s.notify(ctx, id)
	}
	return err
}
func (s *Store) Recover(ctx context.Context) error {
	var ids []string
	if err := s.DB.WithContext(ctx).Raw(`SELECT id FROM script_tasks WHERE (status IN ('running','stopping') AND (lease_until IS NULL OR lease_until<=now())) OR (status IN ('interrupted','completed','failed','stopped') AND output_saved=false) ORDER BY updated_at LIMIT 100`).Scan(&ids).Error; err != nil {
		return err
	}
	for _, id := range ids {
		err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			var r row
			q := tx.Raw(`SELECT * FROM script_tasks WHERE id=? AND ((status IN ('running','stopping') AND (lease_until IS NULL OR lease_until<=now())) OR (status IN ('interrupted','completed','failed','stopped') AND output_saved=false)) FOR UPDATE SKIP LOCKED`, id).Scan(&r)
			if q.Error != nil {
				return q.Error
			}
			if q.RowsAffected == 0 {
				return nil
			}
			if err := saveOutput(tx, r); err != nil {
				return err
			}
			status := r.Status
			message := r.Error
			if status == "running" {
				status = "interrupted"
				m := "执行中断，已保存正文保留"
				message = &m
			} else if status == "stopping" {
				status = "stopped"
				m := "执行中断，已保存正文保留"
				message = &m
			}
			if err := tx.Exec(`UPDATE script_tasks SET status=?,output_saved=true,error=?,lease_id=NULL,lease_until=NULL,revision=revision+1,updated_at=now() WHERE id=?`, status, message, id).Error; err != nil {
				return err
			}
			return tx.Exec(`INSERT INTO script_task_events(task_id,event_type,phase) VALUES(?,?,?)`, id, status, r.Phase).Error
		})
		if err != nil {
			return err
		}
		s.notify(ctx, id)
	}
	return nil
}
func saveOutput(tx *gorm.DB, r row) error {
	if r.OutputSaved || r.OutputNodeID == nil {
		return nil
	}
	return (resourcepostgres.ScriptCanvas{}).SaveOutput(tx, r.OwnerID, r.ProjectID, *r.OutputNodeID, r.ID, r.Text)
}
func (s *Store) Pending(ctx context.Context) ([]string, error) {
	var ids []string
	err := s.DB.WithContext(ctx).Raw(`SELECT id FROM script_tasks WHERE status='queued' AND next_attempt_at<=now() ORDER BY created_at LIMIT 100`).Scan(&ids).Error
	return ids, err
}
func (s *Store) Unpublished(ctx context.Context) ([]string, error) {
	var ids []string
	err := s.DB.WithContext(ctx).Raw(`SELECT task_id FROM script_outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 100`).Scan(&ids).Error
	return ids, err
}
func (s *Store) MarkPublished(ctx context.Context, id string) error {
	return s.DB.WithContext(ctx).Exec(`UPDATE script_outbox SET published_at=now() WHERE task_id=? AND published_at IS NULL`, id).Error
}
func (s *Store) CircuitPermit(ctx context.Context, provider string) (script.CircuitGrant, error) {
	var grant script.CircuitGrant
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(`INSERT INTO script_provider_circuits(provider) VALUES(?) ON CONFLICT DO NOTHING`, provider).Error; err != nil {
			return err
		}
		var c struct {
			Failures  int
			OpenUntil *time.Time
			Probing   bool
			UpdatedAt time.Time
		}
		if err := tx.Raw(`SELECT failures,open_until,probing,updated_at FROM script_provider_circuits WHERE provider=? FOR UPDATE`, provider).Scan(&c).Error; err != nil {
			return err
		}
		now := time.Now()
		if c.OpenUntil != nil && now.Before(*c.OpenUntil) {
			grant.Wait = time.Until(*c.OpenUntil)
			return nil
		}
		if c.Failures >= 3 {
			if c.Probing && now.Sub(c.UpdatedAt) < 2*time.Minute {
				grant.Wait = time.Second
				return nil
			}
			token, err := uuid()
			if err != nil {
				return err
			}
			grant.ProbeToken = token
			return tx.Exec(`UPDATE script_provider_circuits SET probing=true,probe_token=?::uuid,updated_at=now() WHERE provider=?`, token, provider).Error
		}
		return nil
	})
	return grant, err
}
func (s *Store) RecordCircuit(ctx context.Context, provider string, result script.CircuitResult, probeToken string) error {
	cooldown := s.CircuitCooldown
	if cooldown <= 0 {
		cooldown = 30 * time.Second
	}
	return s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var c struct {
			Failures   int
			Probing    bool
			ProbeToken *string
		}
		if err := tx.Raw(`SELECT failures,probing,probe_token FROM script_provider_circuits WHERE provider=? FOR UPDATE`, provider).Scan(&c).Error; err != nil {
			return err
		}
		if probeToken != "" {
			if !c.Probing || c.ProbeToken == nil || *c.ProbeToken != probeToken {
				return nil
			}
		} else if c.Failures >= 3 || c.Probing {
			// Older in-flight calls cannot close or reopen an already open circuit.
			return nil
		}
		if result == script.CircuitNeutral {
			if probeToken != "" {
				return tx.Exec(`UPDATE script_provider_circuits SET probing=false,probe_token=NULL,updated_at=now() WHERE provider=?`, provider).Error
			}
			return nil
		}
		if result == script.CircuitSuccess {
			return tx.Exec(`UPDATE script_provider_circuits SET failures=0,open_until=NULL,probing=false,probe_token=NULL,updated_at=now() WHERE provider=?`, provider).Error
		}
		if result != script.CircuitFailure {
			return fmt.Errorf("invalid circuit result %q", result)
		}
		failures := c.Failures + 1
		var until *time.Time
		if failures >= 3 || c.Probing {
			t := time.Now().Add(cooldown)
			until = &t
		}
		return tx.Exec(`UPDATE script_provider_circuits SET failures=?,open_until=?,probing=false,probe_token=NULL,updated_at=now() WHERE provider=?`, failures, until, provider).Error
	})
}
func (s *Store) Defer(ctx context.Context, id, lease string, wait time.Duration) error {
	if wait < time.Second {
		wait = time.Second
	}
	changed := false
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		q := tx.Exec(`UPDATE script_tasks SET status='queued',phase='preparing',lease_id=NULL,lease_until=NULL,next_attempt_at=?,revision=revision+1,updated_at=now() WHERE id=? AND lease_id=? AND status='running'`, time.Now().Add(wait), id, lease)
		if q.Error != nil {
			return q.Error
		}
		if q.RowsAffected == 0 {
			return nil
		}
		changed = true
		return tx.Exec(`INSERT INTO script_task_events(task_id,event_type,phase) VALUES(?,'deferred','queued')`, id).Error
	})
	if err == nil && changed {
		s.notify(ctx, id)
	}
	return err
}
