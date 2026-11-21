package queue

import (
	"blow-flow/api/internal/generation"
	"blow-flow/api/internal/generation/postgres"
	"context"
	"errors"
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

type Submitter interface {
	Submit(context.Context, generation.Input) (string, error)
}
type submissionResult struct {
	ID    string
	Usage *generation.ProviderUsage
}

type taskSubmitter interface {
	submitTask(context.Context, string, generation.Input) (submissionResult, error)
}
type SubmissionWorker struct {
	Store    *postgres.Store
	Rabbit   *Rabbit
	Provider Submitter
}

func (w SubmissionWorker) Run(ctx context.Context) error {
	return w.Rabbit.Consume(ctx, w.ProcessOne)
}

func (w SubmissionWorker) ProcessOne(ctx context.Context, id string) error {
	claim, ok, err := w.Store.ClaimSubmission(ctx, id)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	allowed, err := w.Store.CheckSubmission(ctx, id, claim.Token)
	if errors.Is(err, postgres.ErrSubmitCircuitOpen) {
		if requeueErr := w.Store.RequeueSubmission(ctx, id, claim.Token); requeueErr != nil {
			return requeueErr
		}
		return err
	}
	if err != nil {
		return err
	}
	if !allowed {
		return w.Store.ResolveSubmission(ctx, id, claim.Token, "", generation.ErrSubmissionRejected)
	}
	var result submissionResult
	var submitErr error
	if provider, ok := w.Provider.(taskSubmitter); ok {
		result, submitErr = provider.submitTask(ctx, id, claim.Input)
	} else {
		result.ID, submitErr = w.Provider.Submit(ctx, claim.Input)
	}
	return w.Store.ResolveSubmissionWithUsage(ctx, id, claim.Token, result.ID, submitErr, result.Usage)
}

// ProcessDue recovers queued tasks even when a published Rabbit wakeup was
// lost. The bounded database scan also revisits tasks after capacity or grants
// change; ClaimSubmission remains the sole authority for paid submission.
func (w SubmissionWorker) ProcessDue(ctx context.Context) error {
	ids, err := w.Store.DueQueued(ctx, 25)
	if err != nil {
		return err
	}
	var failures []error
	for _, id := range ids {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		err := w.ProcessOne(ctx, id)
		if err != nil && !errors.Is(err, postgres.ErrNoCapacity) && !errors.Is(err, postgres.ErrSubmitCircuitOpen) {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
