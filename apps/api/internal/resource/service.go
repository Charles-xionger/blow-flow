package resource

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
)

type Repository interface {
	CreateProject(context.Context, string, string, string, *string) (Project, error)
	Workspace(context.Context, string, bool) (Workspace, error)
	GetProject(context.Context, string, string) (Project, error)
	DeletedNodes(context.Context, string, string, []string) ([]string, error)
	SaveCanvas(context.Context, string, string, SaveCanvas, string, int) (SaveReceipt, error)
	ChangeProject(context.Context, string, string, ProjectChange) (Project, error)
	CreateFolder(context.Context, string, string, string) (Folder, error)
	RenameFolder(context.Context, string, string, string) (Folder, error)
	DeleteFolder(context.Context, string, string) error
	CreateAsset(context.Context, string, AssetInput) (Asset, error)
	GetAsset(context.Context, string, string) (Asset, error)
}

type Service struct{ Repository Repository }

func validID(id string) bool { return id != "" && len(id) <= 200 && strings.TrimSpace(id) == id }
func validName(name string) bool {
	return name != "" && len(name) <= 200 && strings.TrimSpace(name) == name
}

func (s Service) CreateProject(ctx context.Context, owner, id, name string, folderID *string) (Project, error) {
	if !validID(owner) || !validID(id) || !validName(name) || folderID != nil && !validID(*folderID) {
		return Project{}, ErrInvalid
	}
	return s.Repository.CreateProject(ctx, owner, id, name, folderID)
}
func (s Service) Workspace(ctx context.Context, owner string, trash bool) (Workspace, error) {
	if !validID(owner) {
		return Workspace{}, ErrInvalid
	}
	return s.Repository.Workspace(ctx, owner, trash)
}
func (s Service) GetProject(ctx context.Context, owner, id string) (Project, error) {
	if !validID(owner) || !validID(id) {
		return Project{}, ErrInvalid
	}
	return s.Repository.GetProject(ctx, owner, id)
}
func (s Service) DeletedNodes(ctx context.Context, owner, id string, ids []string) ([]string, error) {
	if !validID(owner) || !validID(id) || len(ids) > 100 {
		return nil, ErrInvalid
	}
	for _, nodeID := range ids {
		if !validID(nodeID) {
			return nil, ErrInvalid
		}
	}
	return s.Repository.DeletedNodes(ctx, owner, id, ids)
}
func (s Service) SaveCanvas(ctx context.Context, owner, id string, input SaveCanvas) (SaveReceipt, error) {
	if !validID(owner) || !validID(id) || !validID(input.RequestID) || input.BaseVersion < 1 || len(input.Snapshot) == 0 || len(input.Snapshot) > 10<<20 {
		return SaveReceipt{}, ErrInvalid
	}
	var snapshot struct {
		Name  string `json:"name"`
		Nodes []struct {
			ID       string `json:"id"`
			Position *struct {
				X float64 `json:"x"`
				Y float64 `json:"y"`
			} `json:"position"`
			Data json.RawMessage `json:"data"`
		} `json:"nodes"`
		Edges []struct {
			ID     string `json:"id"`
			Source string `json:"source"`
			Target string `json:"target"`
		} `json:"edges"`
		Viewport *struct {
			X    float64 `json:"x"`
			Y    float64 `json:"y"`
			Zoom float64 `json:"zoom"`
		} `json:"viewport"`
	}
	if json.Unmarshal(input.Snapshot, &snapshot) != nil || !validName(snapshot.Name) || snapshot.Nodes == nil || snapshot.Edges == nil || snapshot.Viewport == nil || snapshot.Viewport.Zoom <= 0 {
		return SaveReceipt{}, ErrInvalid
	}
	ids := make(map[string]struct{}, len(snapshot.Nodes))
	for _, node := range snapshot.Nodes {
		if !validID(node.ID) || node.Position == nil || len(node.Data) == 0 || node.Data[0] != '{' {
			return SaveReceipt{}, ErrInvalid
		}
		if _, exists := ids[node.ID]; exists {
			return SaveReceipt{}, ErrInvalid
		}
		ids[node.ID] = struct{}{}
	}
	for _, edge := range snapshot.Edges {
		if !validID(edge.ID) || !validID(edge.Source) || !validID(edge.Target) {
			return SaveReceipt{}, ErrInvalid
		}
	}
	var canonical any
	decoder := json.NewDecoder(strings.NewReader(string(input.Snapshot)))
	decoder.UseNumber()
	if decoder.Decode(&canonical) != nil {
		return SaveReceipt{}, ErrInvalid
	}
	var canonicalBytes bytes.Buffer
	encoder := json.NewEncoder(&canonicalBytes)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(struct {
		BaseVersion int64 `json:"baseVersion"`
		Snapshot    any   `json:"snapshot"`
	}{input.BaseVersion, canonical}); err != nil {
		return SaveReceipt{}, err
	}
	digest := sha256.Sum256(bytes.TrimSpace(canonicalBytes.Bytes()))
	return s.Repository.SaveCanvas(ctx, owner, id, input, hex.EncodeToString(digest[:]), len(snapshot.Nodes))
}
func (s Service) ChangeProject(ctx context.Context, owner, id string, change ProjectChange) (Project, error) {
	if !validID(owner) || !validID(id) || change.ExpectedVersion < 1 {
		return Project{}, ErrInvalid
	}
	switch change.Action {
	case "rename":
		if !validName(change.Name) {
			return Project{}, ErrInvalid
		}
	case "move":
		if change.FolderID != nil && !validID(*change.FolderID) {
			return Project{}, ErrInvalid
		}
	case "trash", "restore", "purge":
	default:
		return Project{}, ErrInvalid
	}
	return s.Repository.ChangeProject(ctx, owner, id, change)
}
func (s Service) CreateFolder(ctx context.Context, owner, id, name string) (Folder, error) {
	if !validID(owner) || !validID(id) || !validName(name) {
		return Folder{}, ErrInvalid
	}
	return s.Repository.CreateFolder(ctx, owner, id, name)
}
func (s Service) RenameFolder(ctx context.Context, owner, id, name string) (Folder, error) {
	if !validID(owner) || !validID(id) || !validName(name) {
		return Folder{}, ErrInvalid
	}
	return s.Repository.RenameFolder(ctx, owner, id, name)
}
func (s Service) DeleteFolder(ctx context.Context, owner, id string) error {
	if !validID(owner) || !validID(id) {
		return ErrInvalid
	}
	return s.Repository.DeleteFolder(ctx, owner, id)
}
func (s Service) CreateAsset(ctx context.Context, owner string, input AssetInput) (Asset, error) {
	if !validID(owner) || !validID(input.ProjectID) || input.ObjectKey == "" || input.URL == "" || input.SizeBytes < 1 || input.SizeBytes > 30<<20 || input.Kind != "image" && input.Kind != "video" && input.Kind != "audio" {
		return Asset{}, ErrInvalid
	}
	return s.Repository.CreateAsset(ctx, owner, input)
}
func (s Service) GetAsset(ctx context.Context, owner, id string) (Asset, error) {
	if !validID(owner) || !validID(id) {
		return Asset{}, ErrInvalid
	}
	return s.Repository.GetAsset(ctx, owner, id)
}
