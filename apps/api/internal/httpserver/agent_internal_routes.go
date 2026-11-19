package httpserver

import (
	"context"
	"crypto/subtle"
	"errors"
	"net/http"
	"strings"

	"blow-flow/api/internal/agent"
	"blow-flow/api/internal/resource"
	"github.com/gin-gonic/gin"
)

func bearer(c *gin.Context) string {
	parts := strings.SplitN(c.GetHeader("Authorization"), " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
}
func agentError(c *gin.Context, err error) {
	status, code := http.StatusInternalServerError, "internal_error"
	switch {
	case errors.Is(err, agent.ErrInvalid), errors.Is(err, resource.ErrInvalid):
		status, code = 400, "invalid_request"
	case errors.Is(err, agent.ErrRunExpired):
		status, code = 401, "run_expired"
	case errors.Is(err, agent.ErrForbidden):
		status, code = 403, "forbidden"
	case errors.Is(err, agent.ErrNotFound), errors.Is(err, resource.ErrNotFound):
		status, code = 404, "not_found"
	case errors.Is(err, agent.ErrRequestConflict), errors.Is(err, resource.ErrRequestConflict):
		status, code = 409, "request_conflict"
	case errors.Is(err, agent.ErrConflict), errors.Is(err, resource.ErrConflict):
		status, code = 409, "version_conflict"
	case errors.Is(err, resource.ErrDeleted):
		status, code = 410, "project_deleted"
	}
	c.JSON(status, errorBody(c, code))
}
func registerAgentInternalRoutes(r *gin.Engine, d Dependencies) {
	g := r.Group("/internal/agent")
	g.Use(func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		if d.AgentRuns == nil || len(d.AgentRunnerKey) < 32 {
			c.AbortWithStatusJSON(503, errorBody(c, "service_unavailable"))
			return
		}
		c.Next()
	})
	g.POST("/tasks/:id/claim", func(c *gin.Context) {
		key := bearer(c)
		if len(key) != len(d.AgentRunnerKey) || subtle.ConstantTimeCompare([]byte(key), d.AgentRunnerKey) != 1 {
			c.JSON(401, errorBody(c, "unauthorized"))
			return
		}
		run, err := d.AgentRuns.Claim(c.Request.Context(), c.Param("id"))
		if err != nil {
			agentError(c, err)
			return
		}
		c.JSON(200, run)
	})
	g.POST("/run/heartbeat", func(c *gin.Context) {
		lease, err := d.AgentRuns.Heartbeat(c.Request.Context(), bearer(c))
		if err != nil {
			agentError(c, err)
			return
		}
		c.JSON(200, gin.H{"leaseUntil": lease})
	})
	g.GET("/run/canvas", func(c *gin.Context) {
		canvas, err := d.AgentRuns.ReadCanvas(c.Request.Context(), bearer(c))
		if err != nil {
			agentError(c, err)
			return
		}
		c.JSON(200, canvas)
	})
	g.GET("/run/context", func(c *gin.Context) {
		service, ok := d.AgentRuns.(interface {
			Context(context.Context, string) (agent.RunContext, error)
		})
		if !ok {
			c.JSON(503, errorBody(c, "service_unavailable"))
			return
		}
		value, err := service.Context(c.Request.Context(), bearer(c))
		if err != nil {
			agentError(c, err)
			return
		}
		c.JSON(200, value)
	})
	g.POST("/run/reply", func(c *gin.Context) {
		service, ok := d.AgentRuns.(interface {
			AppendReply(context.Context, string, string, string) error
		})
		if !ok {
			c.JSON(503, errorBody(c, "service_unavailable"))
			return
		}
		var body struct {
			CallID string `json:"callId"`
			Text   string `json:"text"`
		}
		if decodeJSONLimited(c, &body, 110<<10) != nil {
			agentError(c, agent.ErrInvalid)
			return
		}
		if err := service.AppendReply(c.Request.Context(), bearer(c), body.CallID, body.Text); err != nil {
			agentError(c, err)
			return
		}
		c.Status(204)
	})
	g.POST("/run/steps/start", func(c *gin.Context) {
		service, ok := d.AgentRuns.(interface {
			StartStep(context.Context, string, agent.StepStart) (agent.Step, error)
		})
		if !ok {
			c.JSON(503, errorBody(c, "service_unavailable"))
			return
		}
		var body agent.StepStart
		if decodeJSONLimited(c, &body, 1<<20) != nil {
			agentError(c, agent.ErrInvalid)
			return
		}
		step, err := service.StartStep(c.Request.Context(), bearer(c), body)
		if err != nil {
			agentError(c, err)
			return
		}
		c.JSON(200, step)
	})
	g.POST("/run/steps/finish", func(c *gin.Context) {
		service, ok := d.AgentRuns.(interface {
			FinishStep(context.Context, string, agent.StepFinish) (agent.Step, error)
		})
		if !ok {
			c.JSON(503, errorBody(c, "service_unavailable"))
			return
		}
		var body agent.StepFinish
		if decodeJSONLimited(c, &body, 13<<20) != nil {
			agentError(c, agent.ErrInvalid)
			return
		}
		step, err := service.FinishStep(c.Request.Context(), bearer(c), body)
		if err != nil {
			agentError(c, err)
			return
		}
		c.JSON(200, step)
	})
	g.POST("/run/question", func(c *gin.Context) {
		service, ok := d.AgentRuns.(interface {
			AskQuestion(context.Context, string, agent.Question) error
		})
		if !ok {
			c.JSON(503, errorBody(c, "service_unavailable"))
			return
		}
		var body agent.Question
		if decodeJSONLimited(c, &body, 1<<20) != nil {
			agentError(c, agent.ErrInvalid)
			return
		}
		if err := service.AskQuestion(c.Request.Context(), bearer(c), body); err != nil {
			agentError(c, err)
			return
		}
		c.Status(204)
	})
	g.POST("/run/deleted-nodes/check", func(c *gin.Context) {
		var body struct {
			IDs []string `json:"ids"`
		}
		if decodeJSON(c, &body) != nil {
			agentError(c, agent.ErrInvalid)
			return
		}
		deleted, err := d.AgentRuns.DeletedNodes(c.Request.Context(), bearer(c), body.IDs)
		if err != nil {
			agentError(c, err)
			return
		}
		c.JSON(200, gin.H{"deleted": deleted})
	})
	g.GET("/run/canvas/receipt/:callId", func(c *gin.Context) {
		receipt, found, err := d.AgentRuns.CanvasReceipt(c.Request.Context(), bearer(c), c.Param("callId"))
		if err != nil {
			agentError(c, err)
			return
		}
		if !found {
			agentError(c, agent.ErrNotFound)
			return
		}
		c.JSON(200, receipt)
	})
	g.PUT("/run/canvas", func(c *gin.Context) {
		var body agent.Commit
		if decodeJSONLimited(c, &body, 12<<20) != nil {
			agentError(c, agent.ErrInvalid)
			return
		}
		receipt, err := d.AgentRuns.CommitCanvas(c.Request.Context(), bearer(c), body)
		if err != nil {
			agentError(c, err)
			return
		}
		c.JSON(200, receipt)
	})
	g.POST("/run/finish", func(c *gin.Context) {
		var body struct {
			Status string `json:"status"`
		}
		if decodeJSON(c, &body) != nil {
			agentError(c, agent.ErrInvalid)
			return
		}
		if err := d.AgentRuns.Finish(c.Request.Context(), bearer(c), body.Status); err != nil {
			agentError(c, err)
			return
		}
		c.Status(204)
	})
}
