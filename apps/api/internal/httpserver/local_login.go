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

type captchaIssueLimiter struct {
	mu      sync.Mutex
	tokens  float64
	updated time.Time
}

func (l *captchaIssueLimiter) allow() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if l.updated.IsZero() {
		l.tokens = 10
	} else {
		l.tokens = min(10, l.tokens+now.Sub(l.updated).Seconds())
	}
	l.updated = now
	if l.tokens < 1 {
		return false
	}
	l.tokens--
	return true
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
		if dependencies.LocalAdmin == nil || dependencies.Accounts == nil || dependencies.Captcha == nil {
			c.JSON(http.StatusServiceUnavailable, errorBody(c, "service_unavailable"))
			return
		}
		var body struct {
			Email         string `json:"email"`
			Password      string `json:"password"`
			CaptchaID     string `json:"captchaId"`
			CaptchaAnswer string `json:"captchaAnswer"`
		}
		if decodeJSON(c, &body) != nil || len(body.CaptchaID) > 128 {
			c.JSON(http.StatusBadRequest, errorBody(c, "invalid_request"))
			return
		}
		if !dependencies.Captcha.Verify(body.CaptchaID, body.CaptchaAnswer) {
			throttleLogin(c, limiter.fail())
			c.JSON(http.StatusUnauthorized, errorBody(c, "invalid_captcha"))
			return
		}
		if len(body.Email) > 320 || len(body.Password) > 1024 {
			c.JSON(http.StatusBadRequest, errorBody(c, "invalid_request"))
			return
		}
		identity, err := dependencies.LocalAdmin.Authenticate(strings.TrimSpace(body.Email), body.Password)
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

func newImageCaptcha(dependencies Dependencies) gin.HandlerFunc {
	limiter := &captchaIssueLimiter{}
	return func(c *gin.Context) {
		if dependencies.Captcha == nil {
			c.JSON(http.StatusServiceUnavailable, errorBody(c, "service_unavailable"))
			return
		}
		if !limiter.allow() {
			c.Header("Retry-After", "1")
			c.JSON(http.StatusTooManyRequests, errorBody(c, "rate_limited"))
			return
		}
		id, image, err := dependencies.Captcha.Generate()
		if err != nil {
			c.JSON(http.StatusInternalServerError, errorBody(c, "internal_error"))
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, gin.H{"id": id, "image": image})
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
