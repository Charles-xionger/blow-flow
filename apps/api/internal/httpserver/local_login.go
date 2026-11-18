package httpserver

import (
	"errors"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"blow-flow/api/internal/account"
	"blow-flow/api/internal/identity/session"
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
		if dependencies.LocalAdmin == nil || dependencies.Accounts == nil || dependencies.Captcha == nil || dependencies.RefreshSessions == nil {
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
		refresh, err := dependencies.RefreshSessions.Issue(c.Request.Context(), user, identity)
		if err != nil {
			c.JSON(http.StatusInternalServerError, errorBody(c, "internal_error"))
			return
		}
		limiter.clear()
		setRefreshCookie(c, account.RoleAdmin, refresh)
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, gin.H{"accessToken": token, "expiresIn": 900, "user": user})
	}
}

func creatorLogin(dependencies Dependencies) gin.HandlerFunc {
	limiter := &loginLimiter{}
	return func(c *gin.Context) {
		if dependencies.CreatorAuth == nil || dependencies.Accounts == nil || dependencies.Captcha == nil || dependencies.RefreshSessions == nil {
			c.JSON(http.StatusServiceUnavailable, errorBody(c, "service_unavailable"))
			return
		}
		var body struct {
			Email         string `json:"email"`
			Password      string `json:"password"`
			CaptchaID     string `json:"captchaId"`
			CaptchaAnswer string `json:"captchaAnswer"`
		}
		if decodeJSON(c, &body) != nil || len(body.CaptchaID) > 128 || len(body.Email) > 320 || len(body.Password) > 1024 {
			c.JSON(http.StatusBadRequest, errorBody(c, "invalid_request"))
			return
		}
		if !dependencies.Captcha.Verify(body.CaptchaID, body.CaptchaAnswer) {
			throttleLogin(c, limiter.fail())
			c.JSON(http.StatusUnauthorized, errorBody(c, "invalid_captcha"))
			return
		}
		identity, err := dependencies.CreatorAuth.Authenticate(c.Request.Context(), body.Email, body.Password)
		if err != nil {
			throttleLogin(c, limiter.fail())
			c.JSON(http.StatusUnauthorized, errorBody(c, "invalid_credentials"))
			return
		}
		user, err := dependencies.Accounts.Resolve(c.Request.Context(), identity)
		if err != nil || user.Role != account.RoleUser || user.Status != account.StatusActive {
			throttleLogin(c, limiter.fail())
			c.JSON(http.StatusUnauthorized, errorBody(c, "invalid_credentials"))
			return
		}
		token, err := dependencies.CreatorAuth.Issue(identity)
		if err != nil {
			c.JSON(http.StatusInternalServerError, errorBody(c, "internal_error"))
			return
		}
		refresh, err := dependencies.RefreshSessions.Issue(c.Request.Context(), user, identity)
		if err != nil {
			c.JSON(http.StatusInternalServerError, errorBody(c, "internal_error"))
			return
		}
		limiter.clear()
		setRefreshCookie(c, account.RoleUser, refresh)
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, gin.H{"accessToken": token, "expiresIn": 900, "user": user})
	}
}

func refreshCookie(role account.Role) (name, path, issuer string) {
	if role == account.RoleAdmin {
		return "blow_flow_admin_refresh", "/v1/auth/admin", "blow-flow-local"
	}
	return "blow_flow_user_refresh", "/v1/auth/user", "blow-flow-creator"
}

func setRefreshCookie(c *gin.Context, role account.Role, value string) {
	name, path, _ := refreshCookie(role)
	maxAge := 7 * 24 * 60 * 60
	if value == "" {
		maxAge = -1
	}
	http.SetCookie(c.Writer, &http.Cookie{Name: name, Value: value, Path: path, HttpOnly: true, Secure: c.Request.TLS != nil || os.Getenv("APP_ENV") == "production", SameSite: http.SameSiteStrictMode, MaxAge: maxAge})
}

func sameOrigin(c *gin.Context) bool {
	if site := c.GetHeader("Sec-Fetch-Site"); site != "" {
		if site == "same-origin" {
			return true
		}
		if site != "none" {
			return false
		}
	}
	if origin := c.GetHeader("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		return err == nil && parsed.Host == c.Request.Host && (parsed.Scheme == "https" || parsed.Scheme == "http")
	}
	return false
}

func refreshLogin(dependencies Dependencies, role account.Role) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		if !sameOrigin(c) {
			c.JSON(http.StatusForbidden, errorBody(c, "forbidden"))
			return
		}
		if dependencies.RefreshSessions == nil || dependencies.Accounts == nil {
			c.JSON(http.StatusServiceUnavailable, errorBody(c, "service_unavailable"))
			return
		}
		name, _, issuer := refreshCookie(role)
		cookie, err := c.Request.Cookie(name)
		if err != nil {
			c.JSON(http.StatusUnauthorized, errorBody(c, "invalid_refresh"))
			return
		}
		identity, next, err := dependencies.RefreshSessions.Rotate(c.Request.Context(), cookie.Value, issuer)
		if err != nil {
			if !errors.Is(err, session.ErrInvalid) {
				c.JSON(http.StatusServiceUnavailable, errorBody(c, "service_unavailable"))
				return
			}
			c.JSON(http.StatusUnauthorized, errorBody(c, "invalid_refresh"))
			return
		}
		user, err := dependencies.Accounts.Resolve(c.Request.Context(), identity)
		if err != nil && !errors.Is(err, account.ErrAccountDisabled) && !errors.Is(err, account.ErrForbidden) && !errors.Is(err, account.ErrNotFound) {
			setRefreshCookie(c, role, next)
			c.JSON(http.StatusServiceUnavailable, errorBody(c, "service_unavailable"))
			return
		}
		if err != nil || user.Role != role || user.Status != account.StatusActive {
			_ = dependencies.RefreshSessions.Revoke(c.Request.Context(), next, issuer)
			setRefreshCookie(c, role, "")
			c.JSON(http.StatusUnauthorized, errorBody(c, "invalid_refresh"))
			return
		}
		var token string
		if role == account.RoleAdmin && dependencies.LocalAdmin != nil {
			token, err = dependencies.LocalAdmin.Issue(identity)
		} else if role == account.RoleUser && dependencies.CreatorAuth != nil {
			token, err = dependencies.CreatorAuth.Issue(identity)
		} else {
			err = account.ErrForbidden
		}
		if err != nil {
			setRefreshCookie(c, role, next)
			c.JSON(http.StatusServiceUnavailable, errorBody(c, "service_unavailable"))
			return
		}
		setRefreshCookie(c, role, next)
		c.JSON(http.StatusOK, gin.H{"accessToken": token, "expiresIn": 900, "user": user})
	}
}

func logout(dependencies Dependencies, role account.Role) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		if !sameOrigin(c) {
			c.JSON(http.StatusForbidden, errorBody(c, "forbidden"))
			return
		}
		name, _, issuer := refreshCookie(role)
		if cookie, err := c.Request.Cookie(name); err == nil {
			if dependencies.RefreshSessions == nil {
				c.JSON(http.StatusServiceUnavailable, errorBody(c, "service_unavailable"))
				return
			}
			if err := dependencies.RefreshSessions.Revoke(c.Request.Context(), cookie.Value, issuer); err != nil {
				c.JSON(http.StatusServiceUnavailable, errorBody(c, "service_unavailable"))
				return
			}
		}
		setRefreshCookie(c, role, "")
		c.Status(http.StatusNoContent)
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
