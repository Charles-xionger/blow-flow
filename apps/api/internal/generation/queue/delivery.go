package queue

import (
	"blow-flow/api/internal/generation"
	"blow-flow/api/internal/generation/postgres"
	"context"
	"errors"
	"time"
)

type Tracker interface {
	Query(context.Context, string) (Observation, error)
	Watch(context.Context, string, func(Progress) error) error
}
type ModelTracker interface {
	QueryModel(context.Context, string, string) (Observation, error)
}
type InputTracker interface {
	QueryInput(context.Context, generation.Input, string) (Observation, error)
}
type ArtifactStore interface {
	Save(context.Context, string, string, string) (string, error)
}
type DeliveryStore interface {
	ClaimDelivery(context.Context, string) (postgres.DeliveryClaim, bool, error)
	BeginOperation(context.Context, postgres.DeliveryClaim, string) (bool, error)
	RecordOperation(context.Context, postgres.DeliveryClaim, string, error) error
	DeferOperation(context.Context, postgres.DeliveryClaim) error
	DueDeliveries(context.Context, int) ([]string, error)
	SaveFailed(context.Context, postgres.DeliveryClaim, string, bool) error
	Delivered(context.Context, postgres.DeliveryClaim, string) error
	ScheduleQuery(context.Context, postgres.DeliveryClaim, string, error, time.Duration) error
	ProviderSucceeded(context.Context, postgres.DeliveryClaim, string, string) error
	ProviderFailed(context.Context, postgres.DeliveryClaim) error
	RecordProgress(context.Context, string, string, string, *float64) error
}
type DeliveryWorker struct {
	Store       DeliveryStore
	Provider    Tracker
	Artifacts   ArtifactStore
	WaitTimeout time.Duration
}

// ProcessOne does one recoverable step. The database claim fences old workers, and
// all provider reads use the task ID persisted at submission.
func (w DeliveryWorker) ProcessOne(ctx context.Context, id string) error {
	claim, ok, err := w.Store.ClaimDelivery(ctx, id)
	if err != nil || !ok {
		return err
	}
	if claim.ProviderURL != "" {
		allowed, err := w.Store.BeginOperation(ctx, claim, "save")
		if err != nil {
			return err
		}
		if !allowed {
			return w.Store.DeferOperation(ctx, claim)
		}
		if w.Artifacts == nil {
			return w.Store.SaveFailed(ctx, claim, "storage_unconfigured", false)
		}
		url, saveErr := w.Artifacts.Save(ctx, claim.ProviderURL, claim.TaskID, claim.FileType)
		circuitErr := saveErr
		if errors.Is(saveErr, ErrArtifactUnavailable) {
			circuitErr = nil
		}
		if err := w.Store.RecordOperation(ctx, claim, "save", circuitErr); err != nil {
			return err
		}
		if saveErr != nil {
			return w.Store.SaveFailed(ctx, claim, saveCode(saveErr), errors.Is(saveErr, ErrArtifactUnavailable))
		}
		return w.Store.Delivered(ctx, claim, url)
	}
	timeout := w.WaitTimeout
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	allowed, err := w.Store.BeginOperation(ctx, claim, "query")
	if err != nil {
		return err
	}
	if !allowed {
		return w.Store.DeferOperation(ctx, claim)
	}
	query := func() (Observation, error) {
		if claim.Input.Workflow != nil {
			if routed, ok := w.Provider.(InputTracker); ok {
				return routed.QueryInput(ctx, claim.Input, claim.ProviderID)
			}
		}
		if routed, ok := w.Provider.(ModelTracker); ok {
			return routed.QueryModel(ctx, claim.Model, claim.ProviderID)
		}
		return w.Provider.Query(ctx, claim.ProviderID)
	}
	observation, queryErr := query()
	if err := w.Store.RecordOperation(ctx, claim, "query", queryErr); err != nil {
		return err
	}
	if queryErr != nil {
		return w.Store.ScheduleQuery(ctx, claim, "waiting_provider", queryErr, timeout)
	}
	if observation.Failed {
		return w.Store.ProviderFailed(ctx, claim)
	}
	if observation.OutputURL != "" {
		return w.Store.ProviderSucceeded(ctx, claim, observation.OutputURL, observation.FileType)
	}
	if observation.WSSURL != "" {
		socketCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		_ = w.Provider.Watch(socketCtx, observation.WSSURL, func(p Progress) error {
			// The documented fraction is within one node, not overall Krea2 progress.
			return w.Store.RecordProgress(ctx, claim.TaskID, claim.Token, p.Stage, nil)
		})
		cancel()
		// Socket completion, disconnection and timeout all lead back to the same HTTP query.
		observation, queryErr = query()
		if err := w.Store.RecordOperation(ctx, claim, "query", queryErr); err != nil {
			return err
		}
		if queryErr != nil {
			return w.Store.ScheduleQuery(ctx, claim, "generating", queryErr, timeout)
		}
		if observation.Failed {
			return w.Store.ProviderFailed(ctx, claim)
		}
		if observation.OutputURL != "" {
			return w.Store.ProviderSucceeded(ctx, claim, observation.OutputURL, observation.FileType)
		}
		return w.Store.ScheduleQuery(ctx, claim, "generating", nil, timeout)
	}
	return w.Store.ScheduleQuery(ctx, claim, observation.Stage, nil, timeout)
}
func (w DeliveryWorker) ProcessDue(ctx context.Context) error {
	ids, err := w.Store.DueDeliveries(ctx, 25)
	if err != nil {
		return err
	}
	var failures []error
	for _, id := range ids {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := w.ProcessOne(ctx, id); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
func saveCode(err error) string {
	if errors.Is(err, ErrArtifactUnavailable) {
		return "provider_file_unavailable"
	}
	return "save_retryable"
}
