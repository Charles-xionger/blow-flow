package httpserver

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"time"

	"blow-flow/api/internal/account"
	sentrygin "github.com/getsentry/sentry-go/gin"
	"github.com/gin-gonic/gin"
)

type Ping func(context.Context) error

type IdentityVerifier interface {
	Verify(context.Context, string) (account.Identity, error)
}

type LocalAdminAuthenticator interface {
	Authenticate(email, password string) (account.Identity, error)
	Issue(account.Identity) (string, error)
}

type ImageCaptcha interface {
	Generate() (id, image string, err error)
	Verify(id, answer string) bool
}

type AccountService interface {
	Resolve(context.Context, account.Identity) (account.User, error)
	ListUsers(context.Context, account.User, account.ListUsersQuery) (account.UserPage, error)
	DisableUser(context.Context, account.User, account.AuthProof, string, string) (account.User, error)
	ListAuditEvents(context.Context, account.User, account.ListAuditQuery) (account.AuditPage, error)
	RecordAdminLogin(context.Context, account.User) error
}

type Dependencies struct {
	Ping             Ping
	IdentityVerifier IdentityVerifier
	LocalAdmin       LocalAdminAuthenticator
	Captcha          ImageCaptcha
	Accounts         AccountService
	Generation       GenerationService
}

func New(ping Ping) *gin.Engine {
	return NewWithDependencies(Dependencies{Ping: ping})
}

func NewWithDependencies(dependencies Dependencies) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	_ = r.SetTrustedProxies(nil)
	r.Use(func(c *gin.Context) {
		var id [16]byte
		if _, err := rand.Read(id[:]); err != nil {
			c.AbortWithStatus(http.StatusInternalServerError)
			return
		}
		requestID := hex.EncodeToString(id[:])
		c.Set("request_id", requestID)
		c.Header("X-Request-ID", requestID)
		c.Next()
	})
	// Recovery does not print request headers or panic values to stderr.
	r.Use(gin.CustomRecoveryWithWriter(nil, func(c *gin.Context, _ any) {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "internal_error", "requestId": c.GetString("request_id")})
	}))
	r.Use(sentrygin.New(sentrygin.Options{Repanic: true}))
	r.Use(func(c *gin.Context) {
		if hub := sentrygin.GetHubFromContext(c); hub != nil {
			hub.Scope().SetTag("request_id", c.GetString("request_id"))
		}
		c.Next()
	})
	r.GET("/health/live", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })
	r.GET("/health/ready", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		defer cancel()
		if dependencies.Ping == nil || dependencies.Ping(ctx) != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"status": "not_ready"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"status": "ready"})
	})
	registerAccountRoutes(r, dependencies)
	return r
}
