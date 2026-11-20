package postgres

import (
	"blow-flow/api/internal/generation"
	"context"
	"gorm.io/gorm"
)

// Admission provisions per-connection controls for admin configured workflows.
// Existing limits remain operator managed when configuration changes.
func (s *Store) ensureWorkflowConnection(ctx context.Context, m *generation.WorkflowSnapshot) error {
	c := m.Connection
	return s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(`INSERT INTO generation_connection_limits(id,max_active) VALUES(?,?) ON CONFLICT(id) DO NOTHING`, c.ID, c.Concurrency).Error; err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO generation_queue_limits(scope,key,max_active,max_queued) VALUES('connection',?,?,100) ON CONFLICT(scope,key) DO NOTHING`, c.ID, c.Concurrency).Error; err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO generation_queue_limits(scope,key,max_active,max_queued) VALUES('model',?,?,100) ON CONFLICT(scope,key) DO NOTHING`, m.ID, c.Concurrency).Error; err != nil {
			return err
		}
		for _, op := range []string{"submit", "query", "save"} {
			if err := tx.Exec(`INSERT INTO generation_circuits(connection_id,operation) VALUES(?,?) ON CONFLICT(connection_id,operation) DO NOTHING`, c.ID, op).Error; err != nil {
				return err
			}
		}
		return nil
	})
}
