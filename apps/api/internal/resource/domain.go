package resource

import (
	"encoding/json"
	"errors"
	"time"
)

var (
	ErrInvalid   = errors.New("invalid resource input")
	ErrNotFound  = errors.New("resource not found")
	ErrConflict  = errors.New("resource version conflict")
	ErrDeleted   = errors.New("project is deleted")
	ErrDuplicate = errors.New("resource ID already exists")
)

type Project struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	FolderID  *string         `json:"folderId"`
	Snapshot  json.RawMessage `json:"snapshot"`
	Version   int64           `json:"version"`
	CoverURL  *string         `json:"coverUrl,omitempty"`
	NodeCount int             `json:"nodeCount"`
	CreatedAt time.Time       `json:"createdAt"`
	UpdatedAt time.Time       `json:"updatedAt"`
	DeletedAt *time.Time      `json:"deletedAt,omitempty"`
	PurgedAt  *time.Time      `json:"purgedAt,omitempty"`
}

type ProjectSummary struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	FolderID  *string    `json:"folderId"`
	Version   int64      `json:"version"`
	CoverURL  *string    `json:"coverUrl,omitempty"`
	NodeCount int        `json:"nodeCount"`
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
	DeletedAt *time.Time `json:"deletedAt,omitempty"`
}

type Folder struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	ProjectCount int64     `json:"projectCount"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

type Workspace struct {
	Projects []ProjectSummary `json:"projects"`
	Folders  []Folder         `json:"folders"`
}

type SaveCanvas struct {
	RequestID   string          `json:"requestId"`
	BaseVersion int64           `json:"baseVersion"`
	Snapshot    json.RawMessage `json:"snapshot"`
}

type SaveReceipt struct {
	ID        string `json:"id"`
	RequestID string `json:"requestId"`
	Version   int64  `json:"version"`
}

type ProjectChange struct {
	Action          string  `json:"action"`
	ExpectedVersion int64   `json:"expectedVersion"`
	Name            string  `json:"name,omitempty"`
	FolderID        *string `json:"folderId,omitempty"`
}

type Asset struct {
	ID           string    `json:"id"`
	ProjectID    *string   `json:"projectId,omitempty"`
	Kind         string    `json:"kind"`
	URL          string    `json:"url"`
	ObjectKey    string    `json:"objectKey,omitempty"`
	OriginalName string    `json:"originalName,omitempty"`
	ContentType  string    `json:"contentType,omitempty"`
	SizeBytes    int64     `json:"sizeBytes"`
	CreatedAt    time.Time `json:"createdAt"`
}

type AssetInput struct {
	ProjectID    string
	Kind         string
	ObjectKey    string
	URL          string
	OriginalName string
	ContentType  string
	SizeBytes    int64
}
