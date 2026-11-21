package queue

import (
	"blow-flow/api/internal/generation"
	"blow-flow/api/internal/generation/postgres"
	"context"
	"errors"
	"testing"
	"time"
)

type deliveryStoreFake struct {
	claim                       postgres.DeliveryClaim
	status, stage, code, result string
	percent                     *float64
	events                      []string
}

func (s *deliveryStoreFake) ClaimDelivery(_ context.Context, id string) (postgres.DeliveryClaim, bool, error) {
	if s.status == "completed" || s.status == "failed" {
		return postgres.DeliveryClaim{}, false, nil
	}
	s.claim.TaskID = id
	s.claim.Status = s.status
	return s.claim, true, nil
}
func (s *deliveryStoreFake) BeginOperation(context.Context, postgres.DeliveryClaim, string) (bool, error) {
	return true, nil
}
func (s *deliveryStoreFake) RecordOperation(context.Context, postgres.DeliveryClaim, string, error) error {
	return nil
}
func (s *deliveryStoreFake) DeferOperation(context.Context, postgres.DeliveryClaim) error { return nil }
func (s *deliveryStoreFake) DueDeliveries(context.Context, int) ([]string, error) {
	return []string{s.claim.TaskID}, nil
}
func (s *deliveryStoreFake) SaveFailed(_ context.Context, _ postgres.DeliveryClaim, code string, permanent bool) error {
	s.status = "save_failed"
	if permanent {
		s.status = "save_unavailable"
	}
	s.code = code
	s.events = append(s.events, s.status)
	return nil
}
func (s *deliveryStoreFake) Delivered(_ context.Context, _ postgres.DeliveryClaim, url string) error {
	s.status = "completed"
	s.result = url
	s.events = append(s.events, "delivered")
	return nil
}
func (s *deliveryStoreFake) ScheduleQuery(_ context.Context, _ postgres.DeliveryClaim, stage string, _ error, _ time.Duration) error {
	s.stage = stage
	s.events = append(s.events, "query_retry")
	return nil
}
func (s *deliveryStoreFake) ProviderSucceeded(_ context.Context, _ postgres.DeliveryClaim, url, fileType string, _ *generation.ProviderUsage) error {
	s.claim.ProviderURL = url
	s.claim.FileType = fileType
	s.status = "saving"
	s.events = append(s.events, "provider_succeeded")
	return nil
}
func (s *deliveryStoreFake) ProviderFailed(_ context.Context, _ postgres.DeliveryClaim, _ *generation.ProviderUsage) error {
	s.status = "failed"
	s.events = append(s.events, "provider_failed")
	return nil
}
func (s *deliveryStoreFake) RecordProgress(_ context.Context, _, _, stage string, percent *float64) error {
	s.stage = stage
	s.percent = percent
	s.events = append(s.events, "progress")
	return nil
}

type trackerFake struct {
	calls        []string
	observations []Observation
	watch        func(func(Progress) error) error
}

func (p *trackerFake) Query(_ context.Context, id string) (Observation, error) {
	p.calls = append(p.calls, id)
	if len(p.observations) == 0 {
		return Observation{}, errors.New("query timeout")
	}
	value := p.observations[0]
	p.observations = p.observations[1:]
	return value, nil
}
func (p *trackerFake) Watch(_ context.Context, _ string, emit func(Progress) error) error {
	if p.watch != nil {
		return p.watch(emit)
	}
	return nil
}

type artifactFake struct {
	calls int
	fail  error
}

func (a *artifactFake) Save(_ context.Context, _, _, _ string) (string, error) {
	a.calls++
	if a.fail != nil {
		return "", a.fail
	}
	return "https://project-oss/result.png", nil
}
func TestDeliveryRecoversSocketDisconnectAndRetriesOnlySaving(t *testing.T) {
	store := &deliveryStoreFake{status: "running", claim: postgres.DeliveryClaim{ProviderID: "original"}}
	provider := &trackerFake{observations: []Observation{{WSSURL: "wss://example.test/ws"}, {OutputURL: "https://provider.test/image.png", FileType: "png"}}, watch: func(emit func(Progress) error) error {
		value := 42.0
		if err := emit(Progress{Stage: "generating", Percent: &value}); err != nil {
			return err
		}
		return errors.New("socket closed")
	}}
	artifacts := &artifactFake{fail: errors.New("upload timeout")}
	worker := DeliveryWorker{Store: store, Provider: provider, Artifacts: artifacts}
	if err := worker.ProcessOne(context.Background(), "task"); err != nil {
		t.Fatal(err)
	}
	if store.status != "saving" || store.percent != nil || len(provider.calls) != 2 {
		t.Fatalf("provider success %+v %+v", store, provider.calls)
	}
	if err := worker.ProcessOne(context.Background(), "task"); err != nil {
		t.Fatal(err)
	}
	if store.status != "save_failed" || store.claim.ProviderURL == "" {
		t.Fatalf("save failure %+v", store)
	}
	artifacts.fail = nil
	if err := worker.ProcessOne(context.Background(), "task"); err != nil {
		t.Fatal(err)
	}
	if store.status != "completed" || store.result != "https://project-oss/result.png" || len(provider.calls) != 2 || artifacts.calls != 2 {
		t.Fatalf("retry %+v calls=%v saves=%d", store, provider.calls, artifacts.calls)
	}
	if err := worker.ProcessOne(context.Background(), "task"); err != nil {
		t.Fatal(err)
	}
	if artifacts.calls != 2 {
		t.Fatalf("duplicate save: %d", artifacts.calls)
	}
}
func TestDeliveryQueryTimeoutAndUnavailableFileNeverResubmit(t *testing.T) {
	store := &deliveryStoreFake{status: "running", claim: postgres.DeliveryClaim{ProviderID: "old-provider-task"}}
	provider := &trackerFake{}
	worker := DeliveryWorker{Store: store, Provider: provider, Artifacts: &artifactFake{fail: ErrArtifactUnavailable}}
	if err := worker.ProcessOne(context.Background(), "task"); err != nil {
		t.Fatal(err)
	}
	if store.stage != "waiting_provider" || len(provider.calls) != 1 || provider.calls[0] != "old-provider-task" {
		t.Fatalf("query retry %+v %v", store, provider.calls)
	}
	provider.observations = []Observation{{OutputURL: "https://provider.test/image.png", FileType: "png"}}
	if err := worker.ProcessOne(context.Background(), "task"); err != nil {
		t.Fatal(err)
	}
	if err := worker.ProcessOne(context.Background(), "task"); err != nil {
		t.Fatal(err)
	}
	if store.status != "save_unavailable" || store.code != "provider_file_unavailable" || len(provider.calls) != 2 {
		t.Fatalf("unavailable %+v %v", store, provider.calls)
	}
}

type scanStore struct{ *deliveryStoreFake }

func (s scanStore) DueDeliveries(context.Context, int) ([]string, error) {
	return []string{"bad", "good"}, nil
}
func (s scanStore) ClaimDelivery(ctx context.Context, id string) (postgres.DeliveryClaim, bool, error) {
	if id == "bad" {
		return postgres.DeliveryClaim{}, false, errors.New("temporary database failure")
	}
	return s.deliveryStoreFake.ClaimDelivery(ctx, id)
}
func TestDeliveryScanContinuesPastOneTaskError(t *testing.T) {
	store := &deliveryStoreFake{status: "running", claim: postgres.DeliveryClaim{ProviderID: "original"}}
	provider := &trackerFake{observations: []Observation{{OutputURL: "https://provider.test/image.png", FileType: "png"}}}
	err := (DeliveryWorker{Store: scanStore{store}, Provider: provider}).ProcessDue(context.Background())
	if err == nil || store.status != "saving" || len(provider.calls) != 1 {
		t.Fatalf("scan result: %v %+v %v", err, store, provider.calls)
	}
}
