package script

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"blow-flow/api/internal/textmodel"
)

type Publisher interface {
	Publish(context.Context, string) error
}
type Streamer interface {
	Stream(context.Context, textmodel.Request, textmodel.Emit) error
}

var errLocalStore = errors.New("local script store error")

type Worker struct {
	Store      ExecutorStore
	Queue      Publisher
	Model      Streamer
	HTTP       *http.Client
	AssetHosts []string
	Slots      chan struct{}
}

func (w Worker) PublishPending(ctx context.Context) error {
	ids, err := w.Store.Unpublished(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err = w.Queue.Publish(ctx, id); err != nil {
			return err
		}
		if err = w.Store.MarkPublished(ctx, id); err != nil {
			return err
		}
	}
	return nil
}
func (w Worker) ProcessDue(ctx context.Context) error {
	ids, err := w.Store.Pending(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		w.Dispatch(ctx, id)
	}
	return nil
}

// A Rabbit delivery only wakes the worker. PostgreSQL retains queued work if
// the process exits after the message is acknowledged.
func (w Worker) Dispatch(ctx context.Context, id string) {
	if w.Slots == nil {
		return
	}
	select {
	case w.Slots <- struct{}{}:
		go func() {
			defer func() { <-w.Slots }()
			if err := w.Process(ctx, id); err != nil && ctx.Err() == nil {
				slog.Warn("script task processing retry", "reason", err.Error())
			}
		}()
	default:
	}
}
func (w Worker) Process(ctx context.Context, id string) error {
	claim, err := w.Store.Claim(ctx, id, 30*time.Second)
	if err != nil || claim == nil {
		return err
	}
	task := claim.Task
	deadline := 180 * time.Second
	if task.Input.OutputMode == "workflow" {
		deadline = 10 * time.Minute
	}
	runCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	done := make(chan struct{})
	go w.watch(runCtx, cancel, claim, done)
	defer close(done)
	images, err := w.images(runCtx, task.Input)
	provider := ""
	if model, ok := textmodel.Lookup(task.Input.Model); ok {
		provider = model.Provider
	}
	permitted := false
	var grant CircuitGrant
	if err == nil && provider != "" {
		grant, err = w.Store.CircuitPermit(runCtx, provider)
		if err == nil && grant.Wait > 0 {
			return w.Store.Defer(ctx, id, claim.Lease, grant.Wait)
		}
		permitted = err == nil
	}
	if err == nil {
		var ok bool
		ok, err = w.Store.SetPhase(runCtx, id, claim.Lease, "connecting")
		if err == nil && !ok {
			current, e := w.Store.Get(runCtx, claim.Owner, id)
			if e != nil || current.Status != "running" {
				err = context.Canceled
			}
		}
	}
	called := err == nil
	if err == nil {
		if task.Input.OutputMode == "workflow" {
			err = w.runWorkflow(runCtx, claim, images)
		} else {
			writing := false
			err = w.Model.Stream(runCtx, textmodel.Request{Model: task.Input.Model, Prompt: Prompt(task.Input), Images: images}, func(delta string) error {
				if delta != "" && !writing {
					if ok, e := w.Store.SetPhase(runCtx, id, claim.Lease, "writing"); e != nil {
						return fmt.Errorf("%w: %v", errLocalStore, e)
					} else if !ok {
						return context.Canceled
					}
					writing = true
				}
				ok, e := w.Store.Append(runCtx, id, claim.Lease, delta)
				if e != nil {
					return fmt.Errorf("%w: %v", errLocalStore, e)
				}
				if !ok {
					return context.Canceled
				}
				return nil
			})
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if permitted {
		recordCtx, recordCancel := context.WithTimeout(context.Background(), 5*time.Second)
		if called {
			_ = w.Store.RecordCircuit(recordCtx, provider, err == nil || errors.Is(err, ErrWorkflow) || errors.Is(err, context.Canceled) || errors.Is(err, errLocalStore), grant.ProbeToken)
		} else {
			_ = w.Store.RecordCircuit(recordCtx, provider, true, grant.ProbeToken)
		}
		recordCancel()
	}
	if err == nil && task.Input.OutputMode != "workflow" {
		latest, e := w.Store.Get(runCtx, claim.Owner, id)
		if e != nil {
			err = e
		} else if strings.TrimSpace(latest.Text) == "" {
			err = ErrWorkflow
		} else if task.Input.OutputMode == "board" && task.Input.Storyboard != nil {
			err = ValidateBoard(latest.Text, *task.Input.Storyboard)
		}
	}
	status, message := "completed", ""
	if err != nil {
		status = "failed"
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			message = "生成超时，已收到的正文保留"
		} else if errors.Is(err, context.Canceled) {
			status = "stopped"
		} else {
			message = "模型调用或输出异常，已收到的正文保留"
		}
	}
	finishCtx, finishCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer finishCancel()
	return w.Store.Finish(finishCtx, id, claim.Lease, status, message)
}
func (w Worker) watch(ctx context.Context, cancel context.CancelFunc, claim *Claimed, done <-chan struct{}) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	lastBeat := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case <-ticker.C:
			if time.Since(lastBeat) >= 5*time.Second {
				ok, err := w.Store.Heartbeat(ctx, claim.Task.ID, claim.Lease, 30*time.Second)
				if err != nil || !ok {
					cancel()
					return
				}
				lastBeat = time.Now()
			}
			t, err := w.Store.Get(ctx, claim.Owner, claim.Task.ID)
			if err != nil || t.Status != "running" {
				cancel()
				return
			}
		}
	}
}
func (w Worker) images(ctx context.Context, in Input) ([]string, error) {
	result := []string{}
	for _, ref := range in.References {
		if ref.Type != "image" {
			continue
		}
		if strings.HasPrefix(ref.Content, "data:image/") {
			result = append(result, ref.Content)
			continue
		}
		u, err := url.Parse(ref.Content)
		if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.RawQuery != "" || u.Fragment != "" || !slices.Contains(w.AssetHosts, u.Hostname()) {
			return nil, fmt.Errorf("reference image host is not trusted")
		}
		client := w.HTTP
		if client == nil {
			client = &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, ref.Content, nil)
		if err != nil {
			return nil, err
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != 200 {
			resp.Body.Close()
			return nil, fmt.Errorf("reference image unavailable")
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, (10<<20)+1))
		resp.Body.Close()
		if err != nil || len(body) > 10<<20 {
			return nil, fmt.Errorf("reference image too large")
		}
		mime := http.DetectContentType(body)
		if mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" {
			return nil, fmt.Errorf("unsupported reference image")
		}
		result = append(result, "data:"+mime+";base64,"+base64.StdEncoding.EncodeToString(body))
	}
	return result, nil
}
