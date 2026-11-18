package postgres

import (
	"context"
	"gorm.io/gorm"
)

type Resources struct{ DB *gorm.DB }

func (r Resources) OwnsProject(ctx context.Context, owner, id string) (bool, error) {
	var n int64
	err := r.DB.WithContext(ctx).Raw(`SELECT count(*) FROM projects WHERE owner_id=? AND id=? AND deleted_at IS NULL AND purged_at IS NULL`, owner, id).Scan(&n).Error
	return n == 1, err
}
func (r Resources) OwnsReference(ctx context.Context, owner, id string) (bool, error) {
	var n int64
	err := r.DB.WithContext(ctx).Raw(`SELECT count(*) FROM media_assets a LEFT JOIN projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE a.owner_id=? AND a.id=? AND (a.project_id IS NULL OR (p.id IS NOT NULL AND p.deleted_at IS NULL AND p.purged_at IS NULL))`, owner, id).Scan(&n).Error
	return n == 1, err
}
