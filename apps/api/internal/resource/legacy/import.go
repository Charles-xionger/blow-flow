package legacy

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path"
	"strings"
	"time"

	"gorm.io/gorm"
)

type Project struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Data      string  `json:"data"`
	FolderID  *string `json:"folder_id"`
	CoverURL  *string `json:"cover_url"`
	Version   int64   `json:"version"`
	NodeCount int     `json:"node_count"`
	CreatedAt int64   `json:"created_at"`
	UpdatedAt int64   `json:"updated_at"`
	DeletedAt *int64  `json:"deleted_at"`
	PurgedAt  *int64  `json:"purged_at"`
}
type Folder struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}
type MediaFile struct {
	ID         string  `json:"id"`
	Type       string  `json:"type"`
	URL        *string `json:"url"`
	Base64Data *string `json:"base64_data"`
	Size       int64   `json:"size"`
	CreatedAt  int64   `json:"created_at"`
}
type Receipt struct {
	CanvasID  string `json:"canvas_id"`
	RequestID string `json:"request_id"`
	Digest    string `json:"digest"`
	Version   int64  `json:"version"`
}
type DeletedNode struct {
	CanvasID string `json:"canvas_id"`
	NodeID   string `json:"node_id"`
}
type ScriptTask struct {
	ID           string  `json:"id"`
	RequestID    string  `json:"request_id"`
	CanvasID     string  `json:"canvas_id"`
	NodeID       string  `json:"node_id"`
	Input        string  `json:"input"`
	Status       string  `json:"status"`
	Text         string  `json:"text"`
	Pipeline     *string `json:"pipeline"`
	OutputNodeID *string `json:"output_node_id"`
	OutputSaved  int     `json:"output_saved"`
	Phase        string  `json:"phase"`
	Revision     int64   `json:"revision"`
	CreatedAt    int64   `json:"created_at"`
	UpdatedAt    int64   `json:"updated_at"`
	Error        *string `json:"error"`
}
type ScriptRequest struct {
	RequestID string `json:"request_id"`
	TaskID    string `json:"task_id"`
	CanvasID  string `json:"canvas_id"`
	NodeID    string `json:"node_id"`
	Input     string `json:"input"`
}
type Export struct {
	SchemaVersion          int                        `json:"schemaVersion"`
	Projects               []Project                  `json:"projects"`
	Folders                []Folder                   `json:"folders"`
	MediaFiles             []MediaFile                `json:"mediaFiles"`
	SaveReceipts           []Receipt                  `json:"saveReceipts"`
	DeletedNodes           []DeletedNode              `json:"deletedNodes"`
	ScriptTasks            []ScriptTask               `json:"scriptTasks"`
	ScriptRequests         []ScriptRequest            `json:"scriptRequests"`
	AgentTasks             []LegacyAgentTask          `json:"agentTasks"`
	AgentMessages          []LegacyAgentMessage       `json:"agentMessages"`
	AgentReceipts          []LegacyAgentReceipt       `json:"agentReceipts"`
	AgentGenerationBatches []LegacyAgentBatch         `json:"agentGenerationBatches"`
	AgentCanvasReceipts    []LegacyAgentCanvasReceipt `json:"agentCanvasReceipts"`
}

func (e Export) Validate() error {
	if e.SchemaVersion != 1 {
		return errors.New("unsupported legacy export version")
	}
	projects, folders, media := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, f := range e.Folders {
		if !valid(f.ID) || !valid(f.Name) || folders[f.ID] || f.CreatedAt <= 0 || f.UpdatedAt <= 0 {
			return errors.New("invalid or duplicate legacy folder")
		}
		folders[f.ID] = true
	}
	for _, p := range e.Projects {
		if !valid(p.ID) || p.Name == "" && p.PurgedAt == nil || projects[p.ID] || p.Version < 1 || p.CreatedAt <= 0 || p.UpdatedAt <= 0 {
			return errors.New("invalid or duplicate legacy project")
		}
		if p.FolderID != nil && !folders[*p.FolderID] {
			return fmt.Errorf("project %s references missing folder", p.ID)
		}
		var data map[string]any
		if json.Unmarshal([]byte(p.Data), &data) != nil || data == nil {
			return fmt.Errorf("project %s has invalid canvas JSON", p.ID)
		}
		projects[p.ID] = true
	}
	for _, m := range e.MediaFiles {
		if !valid(m.ID) || media[m.ID] || m.Size < 0 || m.CreatedAt <= 0 || m.Type != "image" && m.Type != "video" || m.URL == nil && m.Base64Data == nil {
			return errors.New("invalid or duplicate legacy media")
		}
		media[m.ID] = true
	}
	receipts := map[string]bool{}
	for _, r := range e.SaveReceipts {
		key := r.CanvasID + "\x00" + r.RequestID
		if !projects[r.CanvasID] || !valid(r.RequestID) || r.Digest == "" || r.Version < 1 || receipts[key] {
			return errors.New("invalid legacy save receipt")
		}
		receipts[key] = true
	}
	deleted := map[string]bool{}
	for _, n := range e.DeletedNodes {
		key := n.CanvasID + "\x00" + n.NodeID
		if !projects[n.CanvasID] || !valid(n.NodeID) || deleted[key] {
			return errors.New("invalid legacy deleted node")
		}
		deleted[key] = true
	}
	tasks := map[string]ScriptTask{}
	requests := map[string]bool{}
	for _, t := range e.ScriptTasks {
		decodedID, e := hex.DecodeString(strings.ReplaceAll(t.ID, "-", ""))
		if e != nil || len(decodedID) != 16 || !valid(t.RequestID) || !projects[t.CanvasID] || !valid(t.NodeID) || tasks[t.ID].ID != "" || t.Revision < 1 || t.CreatedAt <= 0 || t.UpdatedAt <= 0 || t.OutputSaved < 0 || t.OutputSaved > 1 || !strings.Contains("|queued|running|stopping|stopped|completed|failed|interrupted|", "|"+t.Status+"|") {
			return errors.New("invalid legacy script task")
		}
		var input any
		if json.Unmarshal([]byte(t.Input), &input) != nil || input == nil {
			return errors.New("invalid legacy script input")
		}
		if t.Pipeline != nil {
			var workflow any
			if json.Unmarshal([]byte(*t.Pipeline), &workflow) != nil || workflow == nil {
				return errors.New("invalid legacy storyboard")
			}
		}
		tasks[t.ID] = t
	}
	for _, r := range e.ScriptRequests {
		t, ok := tasks[r.TaskID]
		if !ok || !valid(r.RequestID) || requests[r.RequestID] || r.CanvasID != t.CanvasID || r.NodeID != t.NodeID || r.Input != t.Input {
			return errors.New("invalid legacy script request")
		}
		var input any
		if json.Unmarshal([]byte(r.Input), &input) != nil || input == nil {
			return errors.New("invalid legacy script request input")
		}
		requests[r.RequestID] = true
	}
	return e.validateAgents(projects)
}
func valid(s string) bool          { return s != "" && len(s) <= 200 && strings.TrimSpace(s) == s }
func timestamp(ms int64) time.Time { return time.UnixMilli(ms).UTC() }
func optionalTimestamp(ms *int64) *time.Time {
	if ms == nil {
		return nil
	}
	t := timestamp(*ms)
	return &t
}

// Apply is all-or-nothing and refuses ID collisions, including resources owned by
// a different user. The old SQLite database is never modified by this importer.
func Apply(ctx context.Context, db *gorm.DB, owner, ossHost string, e Export) error {
	if err := e.Validate(); err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(`SELECT pg_advisory_xact_lock(1732447021)`).Error; err != nil {
			return err
		}
		var active int64
		if err := tx.Raw(`SELECT count(*) FROM users WHERE id=? AND status='active'`, owner).Scan(&active).Error; err != nil {
			return err
		}
		if active != 1 {
			return errors.New("initial owner must be an active Go user")
		}
		for _, f := range e.Folders {
			res := tx.Exec(`INSERT INTO project_folders(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, f.ID, owner, f.Name, timestamp(f.CreatedAt), timestamp(f.UpdatedAt))
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected != 1 {
				return fmt.Errorf("folder ID collision: %s", f.ID)
			}
		}
		for _, p := range e.Projects {
			var snapshot map[string]any
			if err := json.Unmarshal([]byte(p.Data), &snapshot); err != nil {
				return err
			}
			snapshot["name"] = p.Name
			encoded, err := json.Marshal(snapshot)
			if err != nil {
				return err
			}
			res := tx.Exec(`INSERT INTO projects(id,owner_id,folder_id,name,snapshot,version,cover_url,node_count,created_at,updated_at,deleted_at,purged_at) VALUES(?,?,?,?,?::jsonb,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, p.ID, owner, p.FolderID, p.Name, string(encoded), p.Version, p.CoverURL, p.NodeCount, timestamp(p.CreatedAt), timestamp(p.UpdatedAt), optionalTimestamp(p.DeletedAt), optionalTimestamp(p.PurgedAt))
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected != 1 {
				return fmt.Errorf("project ID collision: %s", p.ID)
			}
			for _, link := range projectOSSLinks(snapshot, ossHost) {
				hash := sha256.Sum256([]byte(p.ID + "\x00" + link.URL))
				assetID := "legacy-url-" + hex.EncodeToString(hash[:])
				if err := tx.Exec(`INSERT INTO media_assets(id,owner_id,project_id,kind,object_key,url,original_name,size_bytes,created_at) VALUES(?,?,?,?,?,?,?,0,?)`, assetID, owner, p.ID, link.Kind, link.ObjectKey, link.URL, path.Base(link.ObjectKey), timestamp(p.CreatedAt)).Error; err != nil {
					return err
				}
			}
		}
		for _, r := range e.SaveReceipts {
			if err := tx.Exec(`INSERT INTO project_save_receipts(project_id,request_id,digest,version) VALUES(?,?,?,?)`, r.CanvasID, r.RequestID, r.Digest, r.Version).Error; err != nil {
				return err
			}
		}
		for _, n := range e.DeletedNodes {
			if err := tx.Exec(`INSERT INTO project_deleted_nodes(project_id,node_id) VALUES(?,?)`, n.CanvasID, n.NodeID).Error; err != nil {
				return err
			}
		}
		for _, m := range e.MediaFiles {
			var mediaURL string
			if m.URL != nil {
				mediaURL = *m.URL
			} else {
				encoded := *m.Base64Data
				if _, err := base64.StdEncoding.DecodeString(encoded); err != nil {
					return fmt.Errorf("media %s has invalid base64", m.ID)
				}
				mime := "image/png"
				if m.Type == "video" {
					mime = "video/mp4"
				}
				mediaURL = "data:" + mime + ";base64," + encoded
			}
			res := tx.Exec(`INSERT INTO media_assets(id,owner_id,kind,url,size_bytes,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, m.ID, owner, m.Type, mediaURL, m.Size, timestamp(m.CreatedAt))
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected != 1 {
				return fmt.Errorf("media ID collision: %s", m.ID)
			}
		}
		for _, task := range e.ScriptTasks {
			status := task.Status
			failure := task.Error
			if status == "queued" || status == "running" {
				status = "interrupted"
				message := "迁移时中断；已保存正文与检查点，可重新提交"
				failure = &message
			}
			if status == "stopping" {
				status = "stopped"
			}
			phase := task.Phase
			if phase == "" {
				phase = "preparing"
			}
			var workflow *string
			if task.Pipeline != nil {
				workflow = task.Pipeline
			}
			res := tx.Exec(`INSERT INTO script_tasks(id,owner_id,project_id,node_id,request_id,input,status,phase,text,workflow,output_node_id,output_saved,error,revision,created_at,updated_at) VALUES(?::uuid,?,?,?,?,?::jsonb,?,?,?,?::jsonb,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, task.ID, owner, task.CanvasID, task.NodeID, task.RequestID, task.Input, status, phase, task.Text, workflow, task.OutputNodeID, task.OutputSaved != 0, failure, task.Revision, timestamp(task.CreatedAt), timestamp(task.UpdatedAt))
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected != 1 {
				return fmt.Errorf("script task ID collision: %s", task.ID)
			}
			if err := tx.Exec(`INSERT INTO script_task_events(task_id,event_type,phase,status,occurred_at) VALUES(?::uuid,'imported',?,?,?)`, task.ID, phase, status, timestamp(task.UpdatedAt)).Error; err != nil {
				return err
			}
			if err := tx.Exec(`INSERT INTO script_requests(owner_id,request_id,task_id,project_id,node_id,input) VALUES(?,?,?::uuid,?,?,?::jsonb)`, owner, task.RequestID, task.ID, task.CanvasID, task.NodeID, task.Input).Error; err != nil {
				return err
			}
		}
		for _, request := range e.ScriptRequests {
			var existing struct{ TaskID string }
			q := tx.Raw(`SELECT task_id FROM script_requests WHERE owner_id=? AND request_id=?`, owner, request.RequestID).Scan(&existing)
			if q.Error != nil {
				return q.Error
			}
			if q.RowsAffected > 0 {
				if existing.TaskID != request.TaskID {
					return errors.New("script request collision")
				}
				continue
			}
			if err := tx.Exec(`INSERT INTO script_requests(owner_id,request_id,task_id,project_id,node_id,input) VALUES(?,?,?::uuid,?,?,?::jsonb)`, owner, request.RequestID, request.TaskID, request.CanvasID, request.NodeID, request.Input).Error; err != nil {
				return err
			}
		}
		if err := importAgents(tx, owner, e); err != nil {
			return err
		}
		return nil
	})
}

type legacyLink struct{ URL, ObjectKey, Kind string }

func projectOSSLinks(snapshot any, allowedHost string) []legacyLink {
	if allowedHost == "" {
		return nil
	}
	found := map[string]legacyLink{}
	var walk func(any)
	walk = func(value any) {
		switch v := value.(type) {
		case map[string]any:
			for _, item := range v {
				walk(item)
			}
		case []any:
			for _, item := range v {
				walk(item)
			}
		case string:
			u, err := url.Parse(v)
			if err != nil || u.Scheme != "https" || !strings.EqualFold(u.Host, allowedHost) {
				return
			}
			key := strings.TrimPrefix(u.Path, "/")
			ext := strings.ToLower(path.Ext(key))
			kind := map[string]string{".jpg": "image", ".jpeg": "image", ".png": "image", ".webp": "image", ".mp4": "video", ".mov": "video", ".mp3": "audio", ".wav": "audio", ".flac": "audio"}[ext]
			if kind == "" || key == "" {
				return
			}
			u.RawQuery = ""
			u.Fragment = ""
			link := legacyLink{URL: u.String(), ObjectKey: key, Kind: kind}
			found[link.URL] = link
		}
	}
	walk(snapshot)
	links := make([]legacyLink, 0, len(found))
	for _, link := range found {
		links = append(links, link)
	}
	return links
}
