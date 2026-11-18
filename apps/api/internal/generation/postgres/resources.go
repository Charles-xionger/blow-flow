package postgres

import (
	"context"
	"gorm.io/gorm"
)

type Resources struct{ DB *gorm.DB }

func (r Resources) OwnsProject(ctx context.Context, owner, id string) (bool, error) {
	return r.owns(ctx, owner, "project", id)
}
func (r Resources) OwnsReference(ctx context.Context, owner, id string) (bool, error) {
	return r.owns(ctx, owner, "reference", id)
}
func (r Resources) owns(ctx context.Context, owner, kind, id string) (bool, error) {
	var n int64
	err := r.DB.WithContext(ctx).Raw(`SELECT count(*) FROM generation_resource_grants WHERE owner_id=? AND resource_type=? AND resource_id=?`, owner, kind, id).Scan(&n).Error
	return n == 1, err
}
