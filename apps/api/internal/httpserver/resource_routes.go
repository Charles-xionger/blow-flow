package httpserver

import (
	"blow-flow/api/internal/resource"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

type ResourceBlobStore interface {
	Upload(context.Context, string, string, []byte, string) (objectKey, url string, err error)
	Delete(context.Context, string) error
}

func registerResourceRoutes(v1 *gin.RouterGroup, d Dependencies) {
	w := v1.Group("/workspace")
	w.GET("", func(c *gin.Context) {
		if d.Resources == nil {
			resourceUnavailable(c)
			return
		}
		view, err := d.Resources.Workspace(c.Request.Context(), currentUser(c).ID, c.Query("trash") == "true")
		if err != nil {
			resourceError(c, err)
			return
		}
		c.JSON(200, view)
	})
	p := v1.Group("/projects")
	p.POST("", func(c *gin.Context) {
		if d.Resources == nil {
			resourceUnavailable(c)
			return
		}
		var body struct {
			ID       string  `json:"id"`
			Name     string  `json:"name"`
			FolderID *string `json:"folderId"`
		}
		if decodeJSON(c, &body) != nil {
			resourceError(c, resource.ErrInvalid)
			return
		}
		project, err := d.Resources.CreateProject(c.Request.Context(), currentUser(c).ID, body.ID, body.Name, body.FolderID)
		if err != nil {
			resourceError(c, err)
			return
		}
		c.JSON(201, project)
	})
	p.GET("/:id", func(c *gin.Context) {
		if d.Resources == nil {
			resourceUnavailable(c)
			return
		}
		project, err := d.Resources.GetProject(c.Request.Context(), currentUser(c).ID, c.Param("id"))
		if err != nil {
			resourceError(c, err)
			return
		}
		c.JSON(200, project)
	})
	p.PUT("/:id/canvas", func(c *gin.Context) {
		if d.Resources == nil {
			resourceUnavailable(c)
			return
		}
		var body resource.SaveCanvas
		if decodeJSONLimited(c, &body, 11<<20) != nil {
			resourceError(c, resource.ErrInvalid)
			return
		}
		receipt, err := d.Resources.SaveCanvas(c.Request.Context(), currentUser(c).ID, c.Param("id"), body)
		if err != nil {
			resourceError(c, err)
			return
		}
		c.JSON(200, receipt)
	})
	p.POST("/:id/deleted-nodes/check", func(c *gin.Context) {
		if d.Resources == nil {
			resourceUnavailable(c)
			return
		}
		var body struct {
			IDs []string `json:"ids"`
		}
		if decodeJSON(c, &body) != nil {
			resourceError(c, resource.ErrInvalid)
			return
		}
		deleted, err := d.Resources.DeletedNodes(c.Request.Context(), currentUser(c).ID, c.Param("id"), body.IDs)
		if err != nil {
			resourceError(c, err)
			return
		}
		c.JSON(200, gin.H{"deleted": deleted})
	})
	p.PATCH("/:id", func(c *gin.Context) {
		if d.Resources == nil {
			resourceUnavailable(c)
			return
		}
		var body resource.ProjectChange
		if decodeJSON(c, &body) != nil {
			resourceError(c, resource.ErrInvalid)
			return
		}
		project, err := d.Resources.ChangeProject(c.Request.Context(), currentUser(c).ID, c.Param("id"), body)
		if err != nil {
			resourceError(c, err)
			return
		}
		c.JSON(200, project)
	})
	p.POST("/:id/assets", func(c *gin.Context) {
		if d.Resources == nil || d.ResourceBlobs == nil {
			resourceUnavailable(c)
			return
		}
		owner, id := currentUser(c).ID, c.Param("id")
		if _, err := d.Resources.GetProject(c.Request.Context(), owner, id); err != nil {
			resourceError(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 31<<20)
		file, header, err := c.Request.FormFile("file")
		if err != nil {
			resourceError(c, resource.ErrInvalid)
			return
		}
		defer file.Close()
		bytes, err := io.ReadAll(io.LimitReader(file, (30<<20)+1))
		if err != nil || len(bytes) == 0 || len(bytes) > 30<<20 {
			resourceError(c, resource.ErrInvalid)
			return
		}
		kind, contentType := classifyResourceFile(header.Filename, bytes)
		if kind == "" {
			resourceError(c, resource.ErrInvalid)
			return
		}
		key, url, err := d.ResourceBlobs.Upload(c.Request.Context(), owner, id, bytes, contentType)
		if err != nil {
			resourceUnavailable(c)
			return
		}
		asset, err := d.Resources.CreateAsset(c.Request.Context(), owner, resource.AssetInput{ProjectID: id, Kind: kind, ObjectKey: key, URL: url, OriginalName: header.Filename, ContentType: contentType, SizeBytes: int64(len(bytes))})
		if err != nil {
			cleanup, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			_ = d.ResourceBlobs.Delete(cleanup, key)
			cancel()
			resourceError(c, err)
			return
		}
		c.JSON(201, asset)
	})
	v1.GET("/assets/:id", func(c *gin.Context) {
		if d.Resources == nil {
			resourceUnavailable(c)
			return
		}
		asset, err := d.Resources.GetAsset(c.Request.Context(), currentUser(c).ID, c.Param("id"))
		if err != nil {
			resourceError(c, err)
			return
		}
		c.JSON(200, asset)
	})
	f := v1.Group("/folders")
	f.POST("", func(c *gin.Context) {
		if d.Resources == nil {
			resourceUnavailable(c)
			return
		}
		var body struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if decodeJSON(c, &body) != nil {
			resourceError(c, resource.ErrInvalid)
			return
		}
		folder, err := d.Resources.CreateFolder(c.Request.Context(), currentUser(c).ID, body.ID, body.Name)
		if err != nil {
			resourceError(c, err)
			return
		}
		c.JSON(201, folder)
	})
	f.PATCH("/:id", func(c *gin.Context) {
		if d.Resources == nil {
			resourceUnavailable(c)
			return
		}
		var body struct {
			Name string `json:"name"`
		}
		if decodeJSON(c, &body) != nil {
			resourceError(c, resource.ErrInvalid)
			return
		}
		folder, err := d.Resources.RenameFolder(c.Request.Context(), currentUser(c).ID, c.Param("id"), body.Name)
		if err != nil {
			resourceError(c, err)
			return
		}
		c.JSON(200, folder)
	})
	f.DELETE("/:id", func(c *gin.Context) {
		if d.Resources == nil {
			resourceUnavailable(c)
			return
		}
		if err := d.Resources.DeleteFolder(c.Request.Context(), currentUser(c).ID, c.Param("id")); err != nil {
			resourceError(c, err)
			return
		}
		c.Status(204)
	})
}

func classifyResourceFile(filename string, body []byte) (kind, contentType string) {
	ext := strings.ToLower(filename)
	detected := http.DetectContentType(body)
	switch {
	case (strings.HasSuffix(ext, ".jpg") || strings.HasSuffix(ext, ".jpeg")) && detected == "image/jpeg":
		return "image", "image/jpeg"
	case strings.HasSuffix(ext, ".png") && detected == "image/png":
		return "image", "image/png"
	case strings.HasSuffix(ext, ".webp") && detected == "image/webp":
		return "image", "image/webp"
	case strings.HasSuffix(ext, ".mp4") && len(body) > 12 && string(body[4:8]) == "ftyp":
		return "video", "video/mp4"
	case strings.HasSuffix(ext, ".mp3") && (strings.HasPrefix(string(body), "ID3") || body[0] == 0xff):
		return "audio", "audio/mpeg"
	case strings.HasSuffix(ext, ".wav") && len(body) > 12 && string(body[:4]) == "RIFF" && string(body[8:12]) == "WAVE":
		return "audio", "audio/wav"
	}
	return "", ""
}
func resourceUnavailable(c *gin.Context) { c.JSON(503, errorBody(c, "service_unavailable")) }
func resourceError(c *gin.Context, err error) {
	status, code := 500, "internal_error"
	switch {
	case errors.Is(err, resource.ErrInvalid):
		status, code = 400, "invalid_request"
	case errors.Is(err, resource.ErrNotFound):
		status, code = 404, "not_found"
	case errors.Is(err, resource.ErrDeleted):
		status, code = 410, "project_deleted"
	case errors.Is(err, resource.ErrRequestConflict):
		status, code = 409, "request_conflict"
	case errors.Is(err, resource.ErrConflict):
		status, code = 409, "version_conflict"
	case errors.Is(err, resource.ErrDuplicate):
		status, code = 409, "duplicate_id"
	}
	c.JSON(status, errorBody(c, code))
}
