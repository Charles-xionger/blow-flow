package httpserver

import (
	"blow-flow/api/internal/generation"
	"context"
	"errors"
	"github.com/gin-gonic/gin"
	"net/http"
)

type GenerationService interface {
	Create(context.Context, generation.Actor, string, generation.Input) (generation.Task, error)
	Get(context.Context, generation.Actor, string) (generation.Task, error)
	Cancel(context.Context, generation.Actor, string) (generation.Task, error)
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
