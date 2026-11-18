package postgres

import (
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
	DB            *gorm.DB
	Notify        func(context.Context, string)
	MaxConcurrent int
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
	Revision                                                       int64
	LeaseID                                                        *string
	CreatedAt, UpdatedAt                                           time.Time
}

func (r row) task() (script.Task, error) {
	var input script.Input
	if err := json.Unmarshal(r.Input, &input); err != nil {
		return script.Task{}, err
	}
	t := script.Task{ID: r.ID, RequestID: r.RequestID, CanvasID: r.ProjectID, NodeID: r.NodeID, Input: input, Status: r.Status, Phase: r.Phase, Text: r.Text, Workflow: r.Workflow, Revision: r.Revision, CreatedAt: r.CreatedAt.UnixMilli(), UpdatedAt: r.UpdatedAt.UnixMilli()}
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

type graph struct {
	Raw   map[string]any
	Nodes []map[string]any
	Edges []map[string]any
}

func readGraph(raw []byte) (graph, error) {
	var obj map[string]any
	err := json.Unmarshal(raw, &obj)
	if err != nil {
		return graph{}, script.ErrConflict
	}
	rawNodes, ok := obj["nodes"].([]any)
	if !ok {
		return graph{}, script.ErrConflict
	}
	rawEdges, ok := obj["edges"].([]any)
	if !ok || obj["viewport"] == nil {
		return graph{}, script.ErrConflict
	}
	g := graph{Raw: obj, Nodes: make([]map[string]any, 0, len(rawNodes)), Edges: make([]map[string]any, 0, len(rawEdges))}
	for _, n := range rawNodes {
		v, ok := n.(map[string]any)
		if !ok {
			return graph{}, script.ErrConflict
		}
		g.Nodes = append(g.Nodes, v)
	}
	for _, e := range rawEdges {
		v, ok := e.(map[string]any)
		if !ok {
			return graph{}, script.ErrConflict
		}
		g.Edges = append(g.Edges, v)
	}
	return g, nil
}
func (g graph) bytes() ([]byte, error) {
	g.Raw["nodes"] = g.Nodes
	g.Raw["edges"] = g.Edges
	return json.Marshal(g.Raw)
}
func node(g graph, id string) map[string]any {
	for _, n := range g.Nodes {
		if n["id"] == id {
			return n
		}
	}
	return nil
}
func nodeData(n map[string]any) map[string]any { d, _ := n["data"].(map[string]any); return d }
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
		g, err := readGraph(snapshot)
		if err != nil {
			return err
		}
		source := node(g, request.NodeID)
		if source == nil || source["type"] != "script" {
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
			value, e := uuid()
			if e != nil {
				return e
			}
			outputID = &value
			output := makeOutputNode(source, g.Nodes, value, id, request.Input)
			g.Nodes = append(g.Nodes, output)
			g.Edges = append(g.Edges, map[string]any{"id": "script-output-edge:" + id, "source": request.NodeID, "target": value})
			updated, e := g.bytes()
			if e != nil {
				return e
			}
			if e = tx.Exec(`UPDATE projects SET snapshot=?::jsonb,version=version+1,node_count=?,updated_at=now() WHERE id=?`, string(updated), len(g.Nodes), request.CanvasID).Error; e != nil {
				return e
			}
		}
		if err := tx.Exec(`INSERT INTO script_tasks(id,owner_id,project_id,node_id,request_id,input,status,output_node_id,workflow) VALUES(?,?,?,?,?,?::jsonb,'queued',?,?::jsonb)`, id, owner, request.CanvasID, request.NodeID, request.RequestID, string(input), outputID, workflow).Error; err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO script_requests(owner_id,request_id,task_id,project_id,node_id,input) VALUES(?,?,?,?,?,?::jsonb)`, owner, request.RequestID, id, request.CanvasID, request.NodeID, string(input)).Error; err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO script_outbox(task_id) VALUES(?)`, id).Error; err != nil {
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
func makeOutputNode(source map[string]any, nodes []map[string]any, id, taskID string, in script.Input) map[string]any {
	position, _ := source["position"].(map[string]any)
	x, y := 0.0, 0.0
	if position != nil {
		x, _ = position["x"].(float64)
		y, _ = position["y"].(float64)
	}
	title := map[string]string{"free": "创意文本", "screenplay": "剧本", "storyboard": "分镜文稿", "extract": "角色／场景／道具"}[in.Preset]
	if title == "" {
		title = "生成文本"
	}
	if in.OutputMode == "board" {
		title = "分镜"
	}
	purpose := map[string]string{"free": "idea", "screenplay": "script", "storyboard": "storyboard", "extract": "material"}[in.Preset]
	if purpose == "" {
		purpose = "idea"
	}
	width := 320.0
	if d := nodeData(source); d != nil {
		if size, ok := d["displaySize"].(map[string]any); ok {
			if v, ok := size["width"].(float64); ok && v > 0 {
				width = v
			}
		}
	}
	targetX := x + width + 100
	for {
		moved := false
		for _, other := range nodes {
			if other["parentId"] != source["parentId"] {
				continue
			}
			p, ok := other["position"].(map[string]any)
			if !ok {
				continue
			}
			ox, _ := p["x"].(float64)
			oy, _ := p["y"].(float64)
			ow, oh := 320.0, 240.0
			if size, ok := nodeData(other)["displaySize"].(map[string]any); ok {
				if v, ok := size["width"].(float64); ok && v > 0 {
					ow = v
				}
				if v, ok := size["height"].(float64); ok && v > 0 {
					oh = v
				}
			}
			if ox < targetX+360 && ox+ow+40 > targetX && oy < y+300 && oy+oh+60 > y {
				y = oy + oh + 60
				moved = true
			}
		}
		if !moved {
			break
		}
	}
	n := map[string]any{"id": id, "type": "text", "position": map[string]any{"x": targetX, "y": y}, "data": map[string]any{"type": "text", "label": "文本", "customTitle": title, "prompt": []any{}, "textPurpose": purpose, "scriptOutputTaskId": taskID, "scriptOutputSource": source["id"]}}
	if in.OutputMode == "board" && in.Storyboard != nil {
		n["data"].(map[string]any)["storyboard"] = in.Storyboard
	}
	if parent, ok := source["parentId"]; ok {
		n["parentId"] = parent
	}
	return n
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
	q := s.DB.WithContext(ctx).Exec(`UPDATE script_tasks SET status=CASE WHEN status='queued' THEN 'stopped' ELSE 'stopping' END,revision=revision+1,updated_at=now() WHERE id=? AND owner_id=? AND status IN ('queued','running')`, id, owner)
	if q.Error != nil {
		return script.Task{}, q.Error
	}
	t, err := s.Get(ctx, owner, id)
	if err == nil && q.RowsAffected > 0 {
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
		q := tx.Raw(`SELECT * FROM script_tasks WHERE id=? AND status='queued' FOR UPDATE SKIP LOCKED`, id).Scan(&r)
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
			return tx.Exec(`UPDATE script_tasks SET status='stopped',error='项目已删除',revision=revision+1,updated_at=now() WHERE id=?`, id).Error
		}
		if err := tx.Exec(`UPDATE script_tasks SET status='running',lease_id=?,lease_until=?,revision=revision+1,updated_at=now() WHERE id=?`, lease, time.Now().Add(leaseFor), id).Error; err != nil {
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
	q := s.DB.WithContext(ctx).Exec(`UPDATE script_tasks SET phase=?,revision=revision+1,updated_at=now() WHERE id=? AND lease_id=? AND lease_until>now() AND status='running'`, phase, id, lease)
	if q.RowsAffected > 0 {
		s.notify(ctx, id)
	}
	return q.RowsAffected > 0, q.Error
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
func (s *Store) UpdateWorkflow(ctx context.Context, id, lease string, state script.Workflow, allowStopping bool) (bool, error) {
	raw, err := json.Marshal(state)
	if err != nil {
		return false, err
	}
	status := "running"
	if allowStopping {
		status = "stopping"
	}
	q := s.DB.WithContext(ctx).Exec(`UPDATE script_tasks SET workflow=?::jsonb,text=?,revision=revision+1,updated_at=now() WHERE id=? AND lease_id=? AND lease_until>now() AND status IN (?,'running')`, string(raw), state.Text(), id, lease, status)
	if q.RowsAffected > 0 {
		s.notify(ctx, id)
	}
	return q.RowsAffected > 0, q.Error
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
		if r.OutputNodeID != nil && r.Text != "" {
			var p struct {
				Snapshot            []byte
				DeletedAt, PurgedAt *time.Time
			}
			if err := tx.Raw(`SELECT snapshot,deleted_at,purged_at FROM projects WHERE id=? AND owner_id=? FOR UPDATE`, r.ProjectID, r.OwnerID).Scan(&p).Error; err != nil {
				return err
			}
			if p.DeletedAt == nil && p.PurgedAt == nil && len(p.Snapshot) > 0 {
				g, err := readGraph(p.Snapshot)
				if err != nil {
					return err
				}
				target := node(g, *r.OutputNodeID)
				if target != nil {
					d := nodeData(target)
					if d["scriptOutputTaskId"] == r.ID {
						if prompt, ok := d["prompt"].([]any); ok && len(prompt) == 0 {
							d["prompt"] = []any{map[string]string{"text": r.Text}}
							updated, err := g.bytes()
							if err != nil {
								return err
							}
							if err := tx.Exec(`UPDATE projects SET snapshot=?::jsonb,version=version+1,updated_at=now() WHERE id=?`, string(updated), r.ProjectID).Error; err != nil {
								return err
							}
						}
					}
				}
			}
		}
		return tx.Exec(`UPDATE script_tasks SET status=?,error=NULLIF(?,''),lease_id=NULL,lease_until=NULL,revision=revision+1,updated_at=now() WHERE id=?`, status, message, id).Error
	})
	if err == nil {
		s.notify(ctx, id)
	}
	return err
}
func (s *Store) Recover(ctx context.Context) error {
	q := s.DB.WithContext(ctx).Exec(`UPDATE script_tasks SET status=CASE WHEN status='stopping' THEN 'stopped' ELSE 'interrupted' END,error='执行中断，已保存正文保留',lease_id=NULL,lease_until=NULL,revision=revision+1,updated_at=now() WHERE status IN ('running','stopping') AND (lease_until IS NULL OR lease_until<=now())`)
	return q.Error
}
func (s *Store) Pending(ctx context.Context) ([]string, error) {
	var ids []string
	err := s.DB.WithContext(ctx).Raw(`SELECT id FROM script_tasks WHERE status='queued' ORDER BY created_at LIMIT 100`).Scan(&ids).Error
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
