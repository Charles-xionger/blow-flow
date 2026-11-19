package httpserver

import (
	"net/http"

	"blow-flow/api/internal/agent"
	"github.com/gin-gonic/gin"
)

func registerAgentRoutes(v1 *gin.RouterGroup, d Dependencies) {
	g := v1.Group("/agent/projects/:projectId")
	g.GET("", func(c *gin.Context) {
		if d.AgentCommands == nil {
			c.JSON(http.StatusServiceUnavailable, errorBody(c, "service_unavailable"))
			return
		}
		value, err := d.AgentCommands.Snapshot(c.Request.Context(), currentUser(c).ID, c.Param("projectId"))
		if err != nil {
			agentError(c, err)
			return
		}
		c.JSON(http.StatusOK, value)
	})
	g.POST("/commands", func(c *gin.Context) {
		if d.AgentCommands == nil {
			c.JSON(http.StatusServiceUnavailable, errorBody(c, "service_unavailable"))
			return
		}
		var input agent.Command
		if decodeJSONLimited(c, &input, 15<<20) != nil {
			agentError(c, agent.ErrInvalid)
			return
		}
		task, err := d.AgentCommands.Command(c.Request.Context(), currentUser(c).ID, c.Param("projectId"), input)
		if err != nil {
			agentError(c, err)
			return
		}
		c.JSON(http.StatusOK, task)
	})
}
