package postgres

import (
	"blow-flow/api/internal/generation"
	"context"
)

func (s *Store) StageInlineResult(ctx context.Context, taskID, fileType string, body []byte) error {
	if len(body) == 0 || len(body) > 50<<20 || (fileType != "png" && fileType != "jpeg") {
		return generation.ErrInvalid
	}
	var status string
	if err := s.DB.WithContext(ctx).Raw(`SELECT status FROM generation_tasks WHERE id=?`, taskID).Scan(&status).Error; err != nil {
		return err
	}
	if status != "submitting" {
		return ErrStaleLease
	}
	return s.DB.WithContext(ctx).Exec(`INSERT INTO generation_inline_results(task_id,file_type,body) VALUES(?,?,?) ON CONFLICT(task_id) DO NOTHING`, taskID, fileType, body).Error
}
func (s *Store) InlineResult(ctx context.Context, taskID string) ([]byte, string, error) {
	var row struct {
		Body     []byte
		FileType string
	}
	err := s.DB.WithContext(ctx).Raw(`SELECT body,file_type FROM generation_inline_results WHERE task_id=?`, taskID).Scan(&row).Error
	return row.Body, row.FileType, err
}
