package httpserver

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"blow-flow/api/internal/account"
	"blow-flow/api/internal/generation"
	"github.com/gin-gonic/gin"
)

const (
	accountUserKey     = "account_user"
	accountIdentityKey = "account_identity"
)

func registerAccountRoutes(router *gin.Engine, dependencies Dependencies) {
	v1 := router.Group("/v1")
	v1.GET("/auth/captcha", newImageCaptcha(dependencies))
	v1.POST("/auth/admin/login", adminLogin(dependencies))
	v1.Use(authenticate(dependencies.IdentityVerifier, dependencies.Accounts))
	registerGenerationRoutes(v1, dependencies)
	v1.GET("/me", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"user": currentUser(c)})
	})

	admin := v1.Group("/admin")
	admin.GET("/generation/operations", func(c *gin.Context) {
		service, ok := dependencies.Generation.(interface {
			Operations(context.Context, generation.Actor) (generation.Operations, error)
		})
		if !ok {
			c.JSON(503, errorBody(c, "service_unavailable"))
			return
		}
		result, err := service.Operations(c.Request.Context(), generationActor(c))
		if err != nil {
			generationError(c, err)
			return
		}
		c.JSON(200, result)
	})
	admin.GET("/users", func(c *gin.Context) {
		limit, err := parseLimit(c.Query("limit"))
		if err != nil {
			writeAccountError(c, account.ErrInvalidArgument)
			return
		}
		status := account.Status(c.Query("status"))
		if status != "" && status != account.StatusActive && status != account.StatusDisabled {
			writeAccountError(c, account.ErrInvalidArgument)
			return
		}
		page, err := dependencies.Accounts.ListUsers(c.Request.Context(), currentUser(c), account.ListUsersQuery{Limit: limit, Cursor: c.Query("cursor"), Status: status})
		if err != nil {
			writeAccountError(c, err)
			return
		}
		c.JSON(http.StatusOK, page)
	})
	admin.POST("/users/:id/disable", func(c *gin.Context) {
		var body struct {
			Reason string `json:"reason"`
		}
		if err := decodeJSON(c, &body); err != nil {
			writeAccountError(c, account.ErrInvalidArgument)
			return
		}
		user, err := dependencies.Accounts.DisableUser(c.Request.Context(), currentUser(c), currentProof(c), c.Param("id"), body.Reason)
		if err != nil {
			writeAccountError(c, err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"user": user})
	})
	admin.GET("/audit-events", func(c *gin.Context) {
		limit, err := parseLimit(c.Query("limit"))
		if err != nil {
			writeAccountError(c, account.ErrInvalidArgument)
			return
		}
		page, err := dependencies.Accounts.ListAuditEvents(c.Request.Context(), currentUser(c), account.ListAuditQuery{Limit: limit, Cursor: c.Query("cursor")})
		if err != nil {
			writeAccountError(c, err)
			return
		}
		c.JSON(http.StatusOK, page)
	})
}

func authenticate(verifier IdentityVerifier, accounts AccountService) gin.HandlerFunc {
	return func(c *gin.Context) {
		if verifier == nil || accounts == nil {
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, errorBody(c, "service_unavailable"))
			return
		}
		parts := strings.SplitN(c.GetHeader("Authorization"), " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || strings.TrimSpace(parts[1]) == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, errorBody(c, "unauthorized"))
			return
		}
		identity, err := verifier.Verify(c.Request.Context(), strings.TrimSpace(parts[1]))
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, errorBody(c, "unauthorized"))
			return
		}
		user, err := accounts.Resolve(c.Request.Context(), identity)
		if err != nil {
			writeAccountError(c, err)
			c.Abort()
			return
		}
		c.Set(accountUserKey, user)
		c.Set(accountIdentityKey, identity)
		c.Next()
	}
}

func currentUser(c *gin.Context) account.User {
	value, _ := c.Get(accountUserKey)
	user, _ := value.(account.User)
	return user
}

func currentProof(c *gin.Context) account.AuthProof {
	value, _ := c.Get(accountIdentityKey)
	identity, _ := value.(account.Identity)
	return account.AuthProof{AuthenticatedAt: identity.AuthenticatedAt}
}

func parseLimit(value string) (int, error) {
	if value == "" {
		return 50, nil
	}
	limit, err := strconv.Atoi(value)
	if err != nil || limit < 1 || limit > 100 {
		return 0, account.ErrInvalidArgument
	}
	return limit, nil
}

func decodeJSON(c *gin.Context, destination any) error {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16<<10)
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return account.ErrInvalidArgument
	}
	return nil
}

func writeAccountError(c *gin.Context, err error) {
	status, code := http.StatusInternalServerError, "internal_error"
	switch {
	case errors.Is(err, account.ErrEmailUnverified):
		status, code = http.StatusForbidden, "email_unverified"
	case errors.Is(err, account.ErrAccountDisabled):
		status, code = http.StatusForbidden, "account_disabled"
	case errors.Is(err, account.ErrForbidden):
		status, code = http.StatusForbidden, "forbidden"
	case errors.Is(err, account.ErrRecentAuthenticationRequired):
		status, code = http.StatusForbidden, "recent_auth_required"
	case errors.Is(err, account.ErrCannotDisableSelf):
		status, code = http.StatusConflict, "cannot_disable_self"
	case errors.Is(err, account.ErrInvalidArgument):
		status, code = http.StatusBadRequest, "invalid_request"
	case errors.Is(err, account.ErrNotFound):
		status, code = http.StatusNotFound, "not_found"
	}
	c.JSON(status, errorBody(c, code))
}

func errorBody(c *gin.Context, code string) gin.H {
	return gin.H{"error": code, "requestId": c.GetString("request_id")}
}
