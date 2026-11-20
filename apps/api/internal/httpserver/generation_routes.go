package httpserver

import (
	"blow-flow/api/internal/generation"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/gin-gonic/gin"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type GenerationService interface {
	Create(context.Context, generation.Actor, string, generation.Input) (generation.Task, error)
	Get(context.Context, generation.Actor, string) (generation.Task, error)
	Cancel(context.Context, generation.Actor, string) (generation.Task, error)
}

var generationStreamSlots = make(chan struct{}, 256)

type GenerationWakeups interface {
	Subscribe(context.Context, string) (<-chan string, func(), error)
}

type GenerationEvents interface {
	Events(context.Context, generation.Actor, string, int64) ([]generation.Event, error)
}
type GenerationResume interface {
	Resume(context.Context, generation.Actor, string) (generation.Task, error)
}

func registerGenerationRoutes(v1 *gin.RouterGroup, d Dependencies) {
	g := v1.Group("/generation/tasks")
	g.POST("", func(c *gin.Context) {
		if d.Generation == nil {
			c.JSON(503, errorBody(c, "service_unavailable"))
			return
		}
		var input generation.Input
		if decodeJSON(c, &input) != nil {
			generationError(c, generation.ErrInvalid)
			return
		}
		// Frozen admin workflow snapshots are only supplied by the internal agent
		// approval path; clients may select a model but cannot author its graph.
		if input.Workflow != nil {
			generationError(c, generation.ErrInvalid)
			return
		}
		t, err := d.Generation.Create(c.Request.Context(), generationActor(c), c.GetHeader("Idempotency-Key"), input)
		if err != nil {
			generationError(c, err)
			return
		}
		c.JSON(http.StatusAccepted, t)
	})
	g.GET("/:id", func(c *gin.Context) {
		if d.Generation == nil {
			c.JSON(503, errorBody(c, "service_unavailable"))
			return
		}
		t, err := d.Generation.Get(c.Request.Context(), generationActor(c), c.Param("id"))
		if err != nil {
			generationError(c, err)
			return
		}
		c.JSON(200, t)
	})
	g.POST("/:id/cancel", func(c *gin.Context) {
		if d.Generation == nil {
			c.JSON(503, errorBody(c, "service_unavailable"))
			return
		}
		t, err := d.Generation.Cancel(c.Request.Context(), generationActor(c), c.Param("id"))
		if err != nil {
			generationError(c, err)
			return
		}
		c.JSON(200, t)
	})
	g.POST("/:id/resume", func(c *gin.Context) {
		service, ok := d.Generation.(GenerationResume)
		if !ok {
			c.JSON(503, errorBody(c, "service_unavailable"))
			return
		}
		task, err := service.Resume(c.Request.Context(), generationActor(c), c.Param("id"))
		if err != nil {
			generationError(c, err)
			return
		}
		c.JSON(200, task)
	})
	g.GET("/:id/events", func(c *gin.Context) {
		if strings.Contains(c.GetHeader("Accept"), "text/event-stream") {
			streamGeneration(c, d)
			return
		}
		service, ok := d.Generation.(GenerationEvents)
		if !ok {
			c.JSON(503, errorBody(c, "service_unavailable"))
			return
		}
		after, _ := strconv.ParseInt(c.Query("after"), 10, 64)
		if after < 0 {
			after = 0
		}
		task, err := d.Generation.Get(c.Request.Context(), generationActor(c), c.Param("id"))
		if err != nil {
			generationError(c, err)
			return
		}
		events, err := service.Events(c.Request.Context(), generationActor(c), c.Param("id"), after)
		if err != nil {
			generationError(c, err)
			return
		}
		c.JSON(200, gin.H{"task": task, "events": events})
	})
}
func generationActor(c *gin.Context) generation.Actor {
	u := currentUser(c)
	return generation.Actor{ID: u.ID, Admin: u.Role == "admin"}
}
func generationError(c *gin.Context, err error) {
	status, code := 500, "internal_error"
	switch {
	case errors.Is(err, generation.ErrInvalid):
		status, code = 400, "invalid_request"
	case errors.Is(err, generation.ErrForbidden):
		status, code = 403, "forbidden"
	case errors.Is(err, generation.ErrNotFound):
		status, code = 404, "not_found"
	case errors.Is(err, generation.ErrConflict):
		status, code = 409, "idempotency_conflict"
	case errors.Is(err, generation.ErrUserQueueFull):
		status, code = 429, "user_queue_full"
	case errors.Is(err, generation.ErrModelQueueFull):
		status, code = 429, "model_queue_full"
	case errors.Is(err, generation.ErrConnectionQueueFull):
		status, code = 503, "connection_queue_full"
	}
	c.JSON(status, errorBody(c, code))
}

// Each stream is bounded by request cancellation and periodic database catchup.
func streamGeneration(c *gin.Context, d Dependencies) {
	if d.Generation == nil {
		c.JSON(503, errorBody(c, "service_unavailable"))
		return
	}
	actor, id := generationActor(c), c.Param("id")
	actor.Admin = false // SSE subscriptions are restricted to the resource owner.
	task, err := d.Generation.Get(c.Request.Context(), actor, id)
	if err != nil {
		generationError(c, err)
		return
	}
	select {
	case generationStreamSlots <- struct{}{}:
		defer func() { <-generationStreamSlots }()
	default:
		c.JSON(http.StatusServiceUnavailable, errorBody(c, "stream_capacity"))
		return
	}
	var wakeups <-chan string
	closeSub := func() {}
	if d.GenerationWakeups != nil {
		channel, closeFn, err := d.GenerationWakeups.Subscribe(c.Request.Context(), id)
		if err == nil {
			wakeups, closeSub = channel, closeFn
		}
	}
	defer closeSub()
	if latest, err := d.Generation.Get(c.Request.Context(), actor, id); err == nil {
		task = latest
	} else {
		generationError(c, err)
		return
	}
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("X-Accel-Buffering", "no")
	c.Status(200)
	version := -int64(1)
	emit := func(t generation.Task) bool {
		if t.Version <= version {
			return true
		}
		data, err := json.Marshal(t)
		if err != nil {
			return false
		}
		if _, err = fmt.Fprintf(c.Writer, "id: %d\nevent: task\ndata: %s\n\n", t.Version, data); err != nil {
			return false
		}
		c.Writer.Flush()
		version = t.Version
		return true
	}
	if !emit(task) {
		return
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	lifetime := time.NewTimer(25 * time.Second)
	defer lifetime.Stop()
	for {
		select {
		case <-c.Request.Context().Done():
			return
		case <-d.GenerationStreamClose:
			return
		case <-lifetime.C:
			return
		case _, ok := <-wakeups:
			if !ok {
				wakeups = nil
			}
		case <-ticker.C:
		}
		query, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		latest, err := d.Generation.Get(query, actor, id)
		cancel()
		if err == nil && !emit(latest) {
			return
		}
		if errors.Is(err, generation.ErrNotFound) || errors.Is(err, generation.ErrForbidden) {
			return
		}
	}
}
