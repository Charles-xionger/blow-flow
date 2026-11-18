package localauth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"blow-flow/api/internal/account"
	"golang.org/x/crypto/argon2"
)

const (
	Issuer         = "blow-flow-local"
	Subject        = "bootstrap-admin"
	Audience       = "blow-flow-api"
	passwordPrefix = "$argon2id$v=19$m=19456,t=2,p=1$"
)

var ErrInvalidCredentials = errors.New("invalid credentials")

type Config struct {
	Email        string
	PasswordHash string
	SigningKey   []byte
}

type Authenticator struct {
	email        string
	passwordHash string
	signingKey   []byte
	now          func() time.Time
}

func New(config Config, now func() time.Time) (*Authenticator, error) {
	if now == nil {
		now = time.Now
	}
	if len(config.SigningKey) < 32 || !validHash(config.PasswordHash) || strings.TrimSpace(config.Email) == "" {
		return nil, errors.New("local admin authentication requires email, Argon2id hash, and a 32-byte signing key")
	}
	return &Authenticator{
		email:        strings.ToLower(strings.TrimSpace(config.Email)),
		passwordHash: config.PasswordHash,
		signingKey:   append([]byte(nil), config.SigningKey...),
		now:          now,
	}, nil
}

func PasswordHash(password string) (string, error) {
	if len(password) < 16 {
		return "", errors.New("password must be at least 16 bytes")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	value := argon2.IDKey([]byte(password), salt, 2, 19456, 1, 32)
	return passwordPrefix + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(value), nil
}

func validHash(value string) bool {
	if !strings.HasPrefix(value, passwordPrefix) {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(value, passwordPrefix), "$")
	if len(parts) != 2 {
		return false
	}
	salt, err1 := base64.RawStdEncoding.DecodeString(parts[0])
	hash, err2 := base64.RawStdEncoding.DecodeString(parts[1])
	return err1 == nil && err2 == nil && len(salt) == 16 && len(hash) == 32
}

// VerifyPassword applies the same Argon2id parameters as the local bootstrap
// administrator without exposing the stored hash through an API response.
func VerifyPassword(hash, password string) bool {
	if !validHash(hash) {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(hash, passwordPrefix), "$")
	salt, _ := base64.RawStdEncoding.DecodeString(parts[0])
	want, _ := base64.RawStdEncoding.DecodeString(parts[1])
	got := argon2.IDKey([]byte(password), salt, 2, 19456, 1, 32)
	return subtle.ConstantTimeCompare(got, want) == 1
}

func (a *Authenticator) passwordMatches(password string) bool {
	return VerifyPassword(a.passwordHash, password)
}

func (a *Authenticator) Authenticate(email, password string) (account.Identity, error) {
	passwordOK := a.passwordMatches(password)
	if !passwordOK || !strings.EqualFold(strings.TrimSpace(email), a.email) {
		return account.Identity{}, ErrInvalidCredentials
	}
	now := a.now().UTC()
	return account.Identity{Issuer: Issuer, Subject: Subject, Email: a.email, EmailVerified: true, AuthenticatedAt: now}, nil
}

type claims struct {
	Issuer    string `json:"iss"`
	Audience  string `json:"aud"`
	Subject   string `json:"sub"`
	Email     string `json:"email"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
	AuthTime  int64  `json:"auth_time"`
	JWTID     string `json:"jti"`
}

func (a *Authenticator) Issue(identity account.Identity) (string, error) {
	if identity.Issuer != Issuer || identity.Subject != Subject || identity.Email != a.email {
		return "", ErrInvalidCredentials
	}
	now := a.now().UTC()
	jti := make([]byte, 16)
	if _, err := rand.Read(jti); err != nil {
		return "", err
	}
	claim := claims{Issuer: Issuer, Audience: Audience, Subject: Subject, Email: a.email, IssuedAt: now.Unix(), ExpiresAt: now.Add(15 * time.Minute).Unix(), AuthTime: identity.AuthenticatedAt.Unix(), JWTID: base64.RawURLEncoding.EncodeToString(jti)}
	payload, err := json.Marshal(claim)
	if err != nil {
		return "", err
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	message := header + "." + base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, a.signingKey)
	_, _ = mac.Write([]byte(message))
	return message + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func (a *Authenticator) Verify(_ context.Context, raw string) (account.Identity, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 3 || len(raw) > 4096 {
		return account.Identity{}, ErrInvalidCredentials
	}
	header, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || string(header) != `{"alg":"HS256","typ":"JWT"}` {
		return account.Identity{}, ErrInvalidCredentials
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return account.Identity{}, ErrInvalidCredentials
	}
	mac := hmac.New(sha256.New, a.signingKey)
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return account.Identity{}, ErrInvalidCredentials
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return account.Identity{}, ErrInvalidCredentials
	}
	var claim claims
	if json.Unmarshal(payload, &claim) != nil {
		return account.Identity{}, ErrInvalidCredentials
	}
	now := a.now().UTC().Unix()
	if claim.Issuer != Issuer || claim.Audience != Audience || claim.Subject != Subject || claim.Email != a.email || claim.JWTID == "" || claim.IssuedAt > now || claim.ExpiresAt <= now || claim.ExpiresAt-claim.IssuedAt > 900 || claim.AuthTime > now || claim.AuthTime < claim.IssuedAt-30 {
		return account.Identity{}, ErrInvalidCredentials
	}
	return account.Identity{Issuer: Issuer, Subject: Subject, Email: claim.Email, EmailVerified: true, AuthenticatedAt: time.Unix(claim.AuthTime, 0).UTC()}, nil
}
