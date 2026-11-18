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
	"time"
)

type GenerationService interface {
	Create(context.Context, generation.Actor, string, generation.Input) (generation.Task, error)
	Get(context.Context, generation.Actor, string) (generation.Task, error)
	Cancel(context.Context, generation.Actor, string) (generation.Task, error)
}

func mustJSON(value any) string { raw, _ := json.Marshal(value); return string(raw) }

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
		service, ok := d.Generation.(GenerationEvents)
		if !ok {
			c.JSON(503, errorBody(c, "service_unavailable"))
			return
		}
		after, _ := strconv.ParseInt(c.Query("after"), 10, 64)
		if after < 0 {
			after = 0
		}
		if last := c.GetHeader("Last-Event-ID"); last != "" {
			if parsed, err := strconv.ParseInt(last, 10, 64); err == nil && parsed > after {
				after = parsed
			}
		}
		task, err := d.Generation.Get(c.Request.Context(), generationActor(c), c.Param("id"))
		if err != nil {
			generationError(c, err)
			return
		}
		if c.GetHeader("Accept") != "text/event-stream" {
			events, err := service.Events(c.Request.Context(), generationActor(c), c.Param("id"), after)
			if err != nil {
				generationError(c, err)
				return
			}
			c.JSON(200, gin.H{"task": task, "events": events})
			return
		}
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		c.Header("X-Accel-Buffering", "no")
		fmt.Fprintf(c.Writer, "event: snapshot\ndata: %s\n\n", mustJSON(task))
		c.Writer.Flush()
		timer := time.NewTimer(20 * time.Second)
		defer timer.Stop()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			events, err := service.Events(c.Request.Context(), generationActor(c), c.Param("id"), after)
			if err != nil {
				return
			}
			for _, e := range events {
				fmt.Fprintf(c.Writer, "id: %d\nevent: task\ndata: %s\n\n", e.ID, mustJSON(e))
				after = e.ID
			}
			if len(events) > 0 {
				c.Writer.Flush()
			}
			select {
			case <-c.Request.Context().Done():
				return
			case <-timer.C:
				return
			case <-ticker.C:
			}
		}
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
	}
	c.JSON(status, errorBody(c, code))
}
