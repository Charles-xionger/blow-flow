package httpserver

import (
	"net/http"
	"strings"
	"sync"
	"time"

	"blow-flow/api/internal/account"
	"github.com/gin-gonic/gin"
)

type loginAttempt struct {
	count   int
	resetAt time.Time
}

type loginLimiter struct {
	mu      sync.Mutex
	attempt loginAttempt
}

func (l *loginLimiter) fail() time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	entry := l.attempt
	if now.After(entry.resetAt) {
		entry = loginAttempt{resetAt: now.Add(15 * time.Minute)}
	}
	entry.count++
	l.attempt = entry
	if entry.count <= 3 {
		return 0
	}
	if entry.count >= 13 {
		return 2 * time.Second
	}
	return time.Duration(entry.count-3) * 200 * time.Millisecond
}

func (l *loginLimiter) clear() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.attempt = loginAttempt{}
}

func adminLogin(dependencies Dependencies) gin.HandlerFunc {
	limiter := &loginLimiter{}
	return func(c *gin.Context) {
		if dependencies.LocalAdmin == nil || dependencies.Accounts == nil {
			c.JSON(http.StatusServiceUnavailable, errorBody(c, "service_unavailable"))
			return
		}
		var body struct {
			Email    string `json:"email"`
			Password string `json:"password"`
			OTP      string `json:"otp"`
		}
		if decodeJSON(c, &body) != nil || len(body.Email) > 320 || len(body.Password) > 1024 || len(body.OTP) != 6 {
			c.JSON(http.StatusBadRequest, errorBody(c, "invalid_request"))
			return
		}
		identity, err := dependencies.LocalAdmin.Authenticate(strings.TrimSpace(body.Email), body.Password, body.OTP)
		if err != nil {
			throttleLogin(c, limiter.fail())
			c.JSON(http.StatusUnauthorized, errorBody(c, "invalid_credentials"))
			return
		}
		user, err := dependencies.Accounts.Resolve(c.Request.Context(), identity)
		if err != nil || user.Role != account.RoleAdmin || user.Status != account.StatusActive {
			throttleLogin(c, limiter.fail())
			c.JSON(http.StatusUnauthorized, errorBody(c, "invalid_credentials"))
			return
		}
		if err := dependencies.Accounts.RecordAdminLogin(c.Request.Context(), user); err != nil {
			c.JSON(http.StatusInternalServerError, errorBody(c, "internal_error"))
			return
		}
		token, err := dependencies.LocalAdmin.Issue(identity)
		if err != nil {
			c.JSON(http.StatusInternalServerError, errorBody(c, "internal_error"))
			return
		}
		limiter.clear()
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, gin.H{"accessToken": token, "expiresIn": 900, "user": user})
	}
}

func throttleLogin(c *gin.Context, delay time.Duration) {
	if delay <= 0 {
		return
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-c.Request.Context().Done():
	}
}
