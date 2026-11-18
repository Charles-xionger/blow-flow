package postgres

import (
	"blow-flow/api/internal/resource"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"
)

type Repository struct{ DB *gorm.DB }

func New(db *gorm.DB) *Repository { return &Repository{DB: db} }

type projectRow struct {
	ID        string
	OwnerID   string
	Name      string
	FolderID  *string
	Snapshot  json.RawMessage
	Version   int64
	CoverURL  *string
	NodeCount int
	CreatedAt time.Time
	UpdatedAt time.Time
	DeletedAt *time.Time
	PurgedAt  *time.Time
}

func (r projectRow) domain() resource.Project {
	return resource.Project{ID: r.ID, Name: r.Name, FolderID: r.FolderID, Snapshot: r.Snapshot, Version: r.Version, CoverURL: r.CoverURL, NodeCount: r.NodeCount, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, DeletedAt: r.DeletedAt, PurgedAt: r.PurgedAt}
}
func (r projectRow) summary() resource.ProjectSummary {
	return resource.ProjectSummary{ID: r.ID, Name: r.Name, FolderID: r.FolderID, Version: r.Version, CoverURL: r.CoverURL, NodeCount: r.NodeCount, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, DeletedAt: r.DeletedAt}
}

type folderRow struct {
	ID        string
	OwnerID   string
	Name      string
	CreatedAt time.Time
	UpdatedAt time.Time
}

func (r folderRow) domain() resource.Folder {
	return resource.Folder{ID: r.ID, Name: r.Name, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt}
}

type assetRow struct {
	ID           string
	OwnerID      string
	ProjectID    *string
	Kind         string
	URL          string
	ObjectKey    string
	OriginalName string
	ContentType  string
	SizeBytes    int64
	CreatedAt    time.Time
}

func (r assetRow) domain() resource.Asset {
	return resource.Asset{ID: r.ID, ProjectID: r.ProjectID, Kind: r.Kind, URL: r.URL, ObjectKey: r.ObjectKey, OriginalName: r.OriginalName, ContentType: r.ContentType, SizeBytes: r.SizeBytes, CreatedAt: r.CreatedAt}
}

func (r *Repository) CreateProject(ctx context.Context, owner, id, name string, folderID *string) (resource.Project, error) {
	now := time.Now().UTC()
	snapshot, _ := json.Marshal(map[string]any{"name": name, "nodes": []any{}, "edges": []any{}, "viewport": map[string]any{"x": 0, "y": 0, "zoom": 1}})
	err := r.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if folderID != nil {
			var folder folderRow
			res := tx.Raw(`SELECT * FROM project_folders WHERE id=? AND owner_id=? FOR SHARE`, *folderID, owner).Scan(&folder)
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected == 0 {
				return resource.ErrNotFound
			}
		}
		result := tx.Exec(`INSERT INTO projects(id,owner_id,folder_id,name,snapshot,version,created_at,updated_at) VALUES(?,?,?, ?, ?::jsonb,1,?,?) ON CONFLICT(id) DO NOTHING`, id, owner, folderID, name, string(snapshot), now, now)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return resource.ErrDuplicate
		}
		return nil
	})
	if err != nil {
		return resource.Project{}, err
	}
	return r.GetProject(ctx, owner, id)
}
func (r *Repository) Workspace(ctx context.Context, owner string, trash bool) (resource.Workspace, error) {
	var rows []projectRow
	deleted := "IS NULL"
	if trash {
		deleted = "IS NOT NULL"
	}
	if err := r.DB.WithContext(ctx).Raw(`SELECT * FROM projects WHERE owner_id=? AND purged_at IS NULL AND deleted_at `+deleted+` ORDER BY updated_at DESC,id DESC`, owner).Scan(&rows).Error; err != nil {
		return resource.Workspace{}, err
	}
	var folders []folderRow
	if err := r.DB.WithContext(ctx).Raw(`SELECT * FROM project_folders WHERE owner_id=? ORDER BY updated_at DESC,id DESC`, owner).Scan(&folders).Error; err != nil {
		return resource.Workspace{}, err
	}
	view := resource.Workspace{Projects: make([]resource.ProjectSummary, 0, len(rows)), Folders: make([]resource.Folder, 0, len(folders))}
	for _, row := range rows {
		view.Projects = append(view.Projects, row.summary())
	}
	for _, row := range folders {
		view.Folders = append(view.Folders, row.domain())
	}
	return view, nil
}
func (r *Repository) GetProject(ctx context.Context, owner, id string) (resource.Project, error) {
	var row projectRow
	result := r.DB.WithContext(ctx).Raw(`SELECT * FROM projects WHERE id=? AND owner_id=? AND purged_at IS NULL`, id, owner).Scan(&row)
	if result.Error != nil {
		return resource.Project{}, result.Error
	}
	if result.RowsAffected == 0 {
		return resource.Project{}, resource.ErrNotFound
	}
	if row.DeletedAt != nil {
		return resource.Project{}, resource.ErrDeleted
	}
	return row.domain(), nil
}
func (r *Repository) SaveCanvas(ctx context.Context, owner, id string, input resource.SaveCanvas, digest string, nodeCount int) (resource.SaveReceipt, error) {
	var receipt resource.SaveReceipt
	err := r.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row projectRow
		result := tx.Raw(`SELECT * FROM projects WHERE id=? AND owner_id=? FOR UPDATE`, id, owner).Scan(&row)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return resource.ErrNotFound
		}
		if row.DeletedAt != nil || row.PurgedAt != nil {
			return resource.ErrDeleted
		}
		var old struct {
			Digest  string
			Version int64
		}
		res := tx.Raw(`SELECT digest,version FROM project_save_receipts WHERE project_id=? AND request_id=?`, id, input.RequestID).Scan(&old)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected > 0 {
			if old.Digest != digest {
				return resource.ErrConflict
			}
			receipt = resource.SaveReceipt{ID: id, RequestID: input.RequestID, Version: old.Version}
			return nil
		}
		if row.Version != input.BaseVersion {
			return resource.ErrConflict
		}
		var previous, current struct {
			Nodes []struct {
				ID string `json:"id"`
			} `json:"nodes"`
			Name string `json:"name"`
		}
		if err := json.Unmarshal(row.Snapshot, &previous); err != nil {
			return err
		}
		if err := json.Unmarshal(input.Snapshot, &current); err != nil {
			return err
		}
		present := make(map[string]bool, len(current.Nodes))
		for _, node := range current.Nodes {
			present[node.ID] = true
		}
		for _, node := range previous.Nodes {
			if !present[node.ID] {
				if err := tx.Exec(`INSERT INTO project_deleted_nodes(project_id,node_id) VALUES(?,?) ON CONFLICT DO NOTHING`, id, node.ID).Error; err != nil {
					return err
				}
			}
		}
		now := time.Now().UTC()
		if err := tx.Exec(`UPDATE projects SET name=?,snapshot=?::jsonb,version=version+1,node_count=?,updated_at=? WHERE id=?`, current.Name, string(input.Snapshot), nodeCount, now, id).Error; err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO project_save_receipts(project_id,request_id,digest,version) VALUES(?,?,?,?)`, id, input.RequestID, digest, row.Version+1).Error; err != nil {
			return err
		}
		receipt = resource.SaveReceipt{ID: id, RequestID: input.RequestID, Version: row.Version + 1}
		return nil
	})
	return receipt, err
}
func (r *Repository) ChangeProject(ctx context.Context, owner, id string, change resource.ProjectChange) (resource.Project, error) {
	err := r.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row projectRow
		res := tx.Raw(`SELECT * FROM projects WHERE id=? AND owner_id=? FOR UPDATE`, id, owner).Scan(&row)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 || row.PurgedAt != nil {
			return resource.ErrNotFound
		}
		if row.Version != change.ExpectedVersion {
			return resource.ErrConflict
		}
		if row.DeletedAt != nil && change.Action != "restore" && change.Action != "purge" {
			return resource.ErrDeleted
		}
		if row.DeletedAt == nil && (change.Action == "restore" || change.Action == "purge") {
			return resource.ErrConflict
		}
		now := time.Now().UTC()
		switch change.Action {
		case "rename":
			return tx.Exec(`UPDATE projects SET name=?,snapshot=jsonb_set(snapshot,'{name}',to_jsonb(CAST(? AS text)),true),version=version+1,updated_at=? WHERE id=?`, change.Name, change.Name, now, id).Error
		case "move":
			if change.FolderID != nil {
				var n int64
				if err := tx.Raw(`SELECT count(*) FROM project_folders WHERE id=? AND owner_id=?`, *change.FolderID, owner).Scan(&n).Error; err != nil {
					return err
				}
				if n == 0 {
					return resource.ErrNotFound
				}
			}
			return tx.Exec(`UPDATE projects SET folder_id=?,version=version+1,updated_at=? WHERE id=?`, change.FolderID, now, id).Error
		case "trash":
			return tx.Exec(`UPDATE projects SET deleted_at=?,version=version+1 WHERE id=?`, now, id).Error
		case "restore":
			if err := tx.Exec(`UPDATE projects SET deleted_at=NULL,version=version+1,updated_at=? WHERE id=?`, now, id).Error; err != nil {
				return err
			}
			return tx.Exec(`DELETE FROM project_save_receipts WHERE project_id=?`, id).Error
		case "purge":
			if err := tx.Exec(`UPDATE projects SET name='',snapshot='{}'::jsonb,cover_url=NULL,node_count=0,folder_id=NULL,purged_at=?,version=version+1 WHERE id=?`, now, id).Error; err != nil {
				return err
			}
			return tx.Exec(`DELETE FROM project_save_receipts WHERE project_id=?`, id).Error
		}
		return resource.ErrInvalid
	})
	if err != nil {
		return resource.Project{}, err
	}
	var row projectRow
	result := r.DB.WithContext(ctx).Raw(`SELECT * FROM projects WHERE id=? AND owner_id=?`, id, owner).Scan(&row)
	if result.Error != nil {
		return resource.Project{}, result.Error
	}
	if result.RowsAffected == 0 {
		return resource.Project{}, resource.ErrNotFound
	}
	return row.domain(), nil
}
func (r *Repository) CreateFolder(ctx context.Context, owner, id, name string) (resource.Folder, error) {
	now := time.Now().UTC()
	res := r.DB.WithContext(ctx).Exec(`INSERT INTO project_folders(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, id, owner, name, now, now)
	if res.Error != nil {
		return resource.Folder{}, res.Error
	}
	if res.RowsAffected == 0 {
		return resource.Folder{}, resource.ErrDuplicate
	}
	return resource.Folder{ID: id, Name: name, CreatedAt: now, UpdatedAt: now}, nil
}
func (r *Repository) RenameFolder(ctx context.Context, owner, id, name string) (resource.Folder, error) {
	now := time.Now().UTC()
	res := r.DB.WithContext(ctx).Exec(`UPDATE project_folders SET name=?,updated_at=? WHERE id=? AND owner_id=?`, name, now, id, owner)
	if res.Error != nil {
		return resource.Folder{}, res.Error
	}
	if res.RowsAffected == 0 {
		return resource.Folder{}, resource.ErrNotFound
	}
	var row folderRow
	if err := r.DB.WithContext(ctx).Raw(`SELECT * FROM project_folders WHERE id=? AND owner_id=?`, id, owner).Scan(&row).Error; err != nil {
		return resource.Folder{}, err
	}
	return row.domain(), nil
}
func (r *Repository) DeleteFolder(ctx context.Context, owner, id string) error {
	return r.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(`UPDATE projects SET folder_id=NULL WHERE folder_id=? AND owner_id=?`, id, owner).Error; err != nil {
			return err
		}
		res := tx.Exec(`DELETE FROM project_folders WHERE id=? AND owner_id=?`, id, owner)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return resource.ErrNotFound
		}
		return nil
	})
}
func (r *Repository) CreateAsset(ctx context.Context, owner string, input resource.AssetInput) (resource.Asset, error) {
	if _, err := r.GetProject(ctx, owner, input.ProjectID); err != nil {
		return resource.Asset{}, err
	}
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return resource.Asset{}, err
	}
	id := hex.EncodeToString(b[:])
	now := time.Now().UTC()
	if err := r.DB.WithContext(ctx).Exec(`INSERT INTO media_assets(id,owner_id,project_id,kind,object_key,url,original_name,content_type,size_bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, id, owner, input.ProjectID, input.Kind, input.ObjectKey, input.URL, input.OriginalName, input.ContentType, input.SizeBytes, now).Error; err != nil {
		return resource.Asset{}, err
	}
	projectID := input.ProjectID
	return resource.Asset{ID: id, ProjectID: &projectID, Kind: input.Kind, ObjectKey: input.ObjectKey, URL: input.URL, OriginalName: input.OriginalName, ContentType: input.ContentType, SizeBytes: input.SizeBytes, CreatedAt: now}, nil
}
func (r *Repository) GetAsset(ctx context.Context, owner, id string) (resource.Asset, error) {
	var row assetRow
	res := r.DB.WithContext(ctx).Raw(`SELECT a.* FROM media_assets a LEFT JOIN projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE a.id=? AND a.owner_id=? AND (a.project_id IS NULL OR (p.id IS NOT NULL AND p.deleted_at IS NULL AND p.purged_at IS NULL))`, id, owner).Scan(&row)
	if res.Error != nil {
		return resource.Asset{}, res.Error
	}
	if res.RowsAffected == 0 {
		return resource.Asset{}, resource.ErrNotFound
	}
	return row.domain(), nil
}

var _ resource.Repository = (*Repository)(nil)
var _ = errors.Is
