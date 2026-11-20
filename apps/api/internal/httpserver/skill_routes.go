package httpserver

import (
	"blow-flow/api/internal/skill"
	"context"
	"errors"
	"github.com/gin-gonic/gin"
	"net/http"
)

type SkillService interface {
	List(context.Context, string) ([]skill.Summary, error)
	Get(context.Context, string, string) (skill.Detail, error)
	Read(context.Context, string, string, string) (string, error)
	Upload(context.Context, string, skill.Upload) (skill.Summary, error)
	Delete(context.Context, string, string) error
}

func skillError(c *gin.Context, err error) {
	status, code := 500, "internal_error"
	switch {
	case errors.Is(err, skill.ErrInvalid):
		status, code = 400, "invalid_request"
	case errors.Is(err, skill.ErrNotFound):
		status, code = 404, "not_found"
	case errors.Is(err, skill.ErrConflict):
		status, code = 409, "skill_exists"
	case errors.Is(err, skill.ErrReadOnly):
		status, code = 403, "read_only"
	}
	c.JSON(status, errorBody(c, code))
}
func registerSkillRoutes(v1 *gin.RouterGroup, d Dependencies) {
	g := v1.Group("/personal/skills")
	g.Use(func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		if d.Skills == nil {
			c.AbortWithStatusJSON(503, errorBody(c, "service_unavailable"))
			return
		}
		c.Next()
	})
	g.GET("", func(c *gin.Context) {
		rows, err := d.Skills.List(c.Request.Context(), currentUser(c).ID)
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(200, rows)
	})
	g.GET("/:id", func(c *gin.Context) {
		row, err := d.Skills.Get(c.Request.Context(), currentUser(c).ID, c.Param("id"))
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(200, row)
	})
	g.POST("", func(c *gin.Context) {
		var input skill.Upload
		if decodeJSONLimited(c, &input, 280<<20) != nil {
			skillError(c, skill.ErrInvalid)
			return
		}
		row, err := d.Skills.Upload(c.Request.Context(), currentUser(c).ID, input)
		if err != nil {
			skillError(c, err)
			return
		}
		c.JSON(http.StatusCreated, row)
	})
	g.DELETE("/:id", func(c *gin.Context) {
		if err := d.Skills.Delete(c.Request.Context(), currentUser(c).ID, c.Param("id")); err != nil {
			skillError(c, err)
			return
		}
		c.Status(204)
	})
}
