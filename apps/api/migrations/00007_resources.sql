-- +goose Up
CREATE TABLE project_folders (
    id text PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES users(id),
    name text NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    UNIQUE (id, owner_id)
);
CREATE INDEX project_folders_owner_idx ON project_folders(owner_id, updated_at DESC);

CREATE TABLE projects (
    id text PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES users(id),
    folder_id text,
    name text NOT NULL,
    snapshot jsonb NOT NULL,
    version bigint NOT NULL CHECK (version > 0),
    cover_url text,
    node_count integer NOT NULL DEFAULT 0 CHECK (node_count >= 0),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    purged_at timestamptz,
    FOREIGN KEY (folder_id, owner_id) REFERENCES project_folders(id, owner_id),
    UNIQUE (id, owner_id)
);
CREATE INDEX projects_workspace_idx ON projects(owner_id, deleted_at, updated_at DESC);

CREATE TABLE project_save_receipts (
    project_id text NOT NULL REFERENCES projects(id),
    request_id text NOT NULL,
    digest text NOT NULL,
    version bigint NOT NULL,
    PRIMARY KEY(project_id, request_id)
);
CREATE TABLE project_deleted_nodes (
    project_id text NOT NULL REFERENCES projects(id),
    node_id text NOT NULL,
    PRIMARY KEY(project_id, node_id)
);
CREATE TABLE media_assets (
    id text PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES users(id),
    project_id text,
    kind text NOT NULL CHECK (kind IN ('image','video','audio')),
    object_key text,
    url text,
    original_name text,
    content_type text,
    size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    created_at timestamptz NOT NULL,
    FOREIGN KEY (project_id, owner_id) REFERENCES projects(id, owner_id),
    CHECK (object_key IS NOT NULL OR url IS NOT NULL)
);
CREATE INDEX media_assets_owner_project_idx ON media_assets(owner_id, project_id, created_at DESC);

-- Ownership is authoritative in projects and media_assets. Historical test grants
-- must not remain an alternate authorization path after the cutover.
DROP TABLE generation_resource_grants;

-- No destructive down migration for imported user content.
