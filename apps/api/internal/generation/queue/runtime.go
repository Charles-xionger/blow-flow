package queue

import (
	"blow-flow/api/internal/generation"
	"blow-flow/api/internal/generation/postgres"
	"context"
	"gorm.io/gorm"
	"time"
)

type Publisher struct {
	DB     *gorm.DB
	Rabbit *Rabbit
}

func (p Publisher) PublishPending(ctx context.Context) error {
	var rows []struct {
		ID     int64
		TaskID string
	}
	if err := p.DB.WithContext(ctx).Raw(`SELECT id,task_id FROM generation_outbox WHERE published_at IS NULL ORDER BY id LIMIT 100`).Scan(&rows).Error; err != nil {
		return err
	}
	for _, r := range rows {
		if err := p.Rabbit.Publish(ctx, r.TaskID); err != nil {
			return err
		}
		if err := p.DB.WithContext(ctx).Exec(`UPDATE generation_outbox SET published_at=? WHERE id=? AND published_at IS NULL`, time.Now().UTC(), r.ID).Error; err != nil {
			return err
		}
	}
	return nil
}

type Provider interface {
	Generate(context.Context, generation.Input) (string, error)
}
type Worker struct {
	Store    *postgres.Store
	Rabbit   *Rabbit
	Provider Provider
}

func (w Worker) Run(ctx context.Context) error {
	return w.Rabbit.Consume(ctx, func(ctx context.Context, id string) error {
		input, claimed, err := w.Store.Claim(ctx, id)
		if err != nil {
			return err
		}
		if !claimed {
			return nil
		}
		url, runErr := w.Provider.Generate(ctx, input)
		return w.Store.Finish(ctx, id, url, runErr)
	})
}

type SimulatedProvider struct{}

func (SimulatedProvider) Generate(_ context.Context, input generation.Input) (string, error) {
	return "simulated://krea2/result", nil
}
