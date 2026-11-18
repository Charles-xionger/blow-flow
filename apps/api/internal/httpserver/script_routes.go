package httpserver

import (
	"blow-flow/api/internal/script"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

var scriptStreamSlots = make(chan struct{}, 128)

func registerScriptRoutes(v1 *gin.RouterGroup, d Dependencies) {
	v1.GET("/script/models", func(c *gin.Context) {
		if d.TextModels == nil {
			scriptUnavailable(c)
			return
		}
		c.JSON(200, gin.H{"models": d.TextModels.Catalog()})
	})
	g := v1.Group("/script/tasks")
	g.POST("", func(c *gin.Context) {
		if d.Scripts == nil {
			scriptUnavailable(c)
			return
		}
		var input script.Create
		if decodeJSONLimited(c, &input, 1<<20) != nil {
			scriptError(c, script.ErrInvalid)
			return
		}
		task, err := d.Scripts.Create(c.Request.Context(), currentUser(c).ID, input)
		if err != nil {
			scriptError(c, err)
			return
		}
		c.JSON(http.StatusAccepted, task)
	})
	g.GET("", func(c *gin.Context) {
		if d.Scripts == nil {
			scriptUnavailable(c)
			return
		}
		tasks, err := d.Scripts.List(c.Request.Context(), currentUser(c).ID, c.Query("canvasId"), c.Query("nodeId"))
		if err != nil {
			scriptError(c, err)
			return
		}
		c.JSON(200, tasks)
	})
	g.GET("/:id", func(c *gin.Context) {
		if d.Scripts == nil {
			scriptUnavailable(c)
			return
		}
		task, err := d.Scripts.Get(c.Request.Context(), currentUser(c).ID, c.Param("id"))
		if err != nil {
			scriptError(c, err)
			return
		}
		c.JSON(200, task)
	})
	g.POST("/:id/stop", func(c *gin.Context) {
		if d.Scripts == nil {
			scriptUnavailable(c)
			return
		}
		task, err := d.Scripts.Stop(c.Request.Context(), currentUser(c).ID, c.Param("id"))
		if err != nil {
			scriptError(c, err)
			return
		}
		c.JSON(200, task)
	})
	g.GET("/:id/events", func(c *gin.Context) {
		if d.Scripts == nil {
			scriptUnavailable(c)
			return
		}
		owner, id := currentUser(c).ID, c.Param("id")
		task, err := d.Scripts.Get(c.Request.Context(), owner, id)
		if err != nil {
			scriptError(c, err)
			return
		}
		select {
		case scriptStreamSlots <- struct{}{}:
			defer func() { <-scriptStreamSlots }()
		default:
			c.JSON(503, errorBody(c, "stream_capacity"))
			return
		}
		var wakeups <-chan string
		closeSub := func() {}
		if d.ScriptWakeups != nil {
			channel, closeFn, e := d.ScriptWakeups.Subscribe(c.Request.Context(), id)
			if e == nil {
				wakeups, closeSub = channel, closeFn
			}
		}
		defer closeSub()
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache, no-transform")
		c.Header("X-Accel-Buffering", "no")
		c.Status(200)
		write := func(t script.Task) bool {
			encoded, e := json.Marshal(t)
			if e != nil {
				return false
			}
			_, e = fmt.Fprintf(c.Writer, "id: %d\nevent: task\ndata: %s\n\n", t.Revision, encoded)
			if e != nil {
				return false
			}
			c.Writer.Flush()
			return true
		}
		if !write(task) {
			return
		}
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-c.Request.Context().Done():
				return
			case <-d.GenerationStreamClose:
				return
			case <-ticker.C:
			case _, ok := <-wakeups:
				if !ok {
					wakeups = nil
					continue
				}
			}
			latest, e := d.Scripts.Get(c.Request.Context(), owner, id)
			if e != nil {
				return
			}
			if latest.Revision != task.Revision {
				task = latest
				if !write(task) {
					return
				}
			} else {
				_, _ = c.Writer.WriteString(": heartbeat\n\n")
				c.Writer.Flush()
			}
		}
	})
	v1.GET("/script/events", func(c *gin.Context) {
		if d.Scripts == nil {
			scriptUnavailable(c)
			return
		}
		owner, project := currentUser(c).ID, c.Query("canvasId")
		tasks, err := d.Scripts.List(c.Request.Context(), owner, project, "")
		if err != nil {
			scriptError(c, err)
			return
		}
		select {
		case scriptStreamSlots <- struct{}{}:
			defer func() { <-scriptStreamSlots }()
		default:
			c.JSON(503, errorBody(c, "stream_capacity"))
			return
		}
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache, no-transform")
		c.Header("X-Accel-Buffering", "no")
		c.Status(200)
		versions := map[string]int64{}
		send := func(changes []script.Task) bool {
			encoded, e := json.Marshal(changes)
			if e != nil {
				return false
			}
			_, e = fmt.Fprintf(c.Writer, "event: tasks\ndata: %s\n\n", encoded)
			if e != nil {
				return false
			}
			c.Writer.Flush()
			return true
		}
		for _, t := range tasks {
			versions[t.ID] = t.Revision
		}
		if !send(tasks) {
			return
		}
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-c.Request.Context().Done():
				return
			case <-d.GenerationStreamClose:
				return
			case <-ticker.C:
			}
			latest, e := d.Scripts.List(c.Request.Context(), owner, project, "")
			if e != nil {
				return
			}
			changes := []script.Task{}
			for _, t := range latest {
				if versions[t.ID] != t.Revision {
					changes = append(changes, t)
					versions[t.ID] = t.Revision
				}
			}
			if len(changes) > 0 && !send(changes) {
				return
			}
		}
	})
}
func scriptUnavailable(c *gin.Context) { c.JSON(503, errorBody(c, "service_unavailable")) }
func scriptError(c *gin.Context, err error) {
	status, code := 500, "internal_error"
	switch {
	case errors.Is(err, script.ErrInvalid):
		status, code = 400, "invalid_request"
	case errors.Is(err, script.ErrNotFound):
		status, code = 404, "not_found"
	case errors.Is(err, script.ErrConflict):
		status, code = 409, "conflict"
	case errors.Is(err, script.ErrUnavailable):
		status, code = 503, "model_unavailable"
	}
	if strings.Contains(err.Error(), "duplicate key") {
		status, code = 409, "conflict"
	}
	c.JSON(status, errorBody(c, code))
}
