package localauth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
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
	TOTPSecret   string
	SigningKey   []byte
}

type Authenticator struct {
	email        string
	passwordHash string
	totpSecret   []byte
	signingKey   []byte
	now          func() time.Time
	mu           sync.Mutex
	lastTOTP     int64
}

func New(config Config, now func() time.Time) (*Authenticator, error) {
	if now == nil {
		now = time.Now
	}
	secret, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(strings.TrimSpace(config.TOTPSecret)))
	if err != nil || len(secret) < 20 || len(config.SigningKey) < 32 || !validHash(config.PasswordHash) || strings.TrimSpace(config.Email) == "" {
		return nil, errors.New("local admin authentication requires email, Argon2id hash, TOTP secret, and a 32-byte signing key")
	}
	return &Authenticator{
		email:        strings.ToLower(strings.TrimSpace(config.Email)),
		passwordHash: config.PasswordHash,
		totpSecret:   secret,
		signingKey:   append([]byte(nil), config.SigningKey...),
		now:          now,
		lastTOTP:     -1,
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

func NewTOTPSecret() (string, error) {
	secret := make([]byte, 20)
	if _, err := rand.Read(secret); err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(secret), nil
}

func CurrentTOTPCode(secret string, now time.Time) (string, error) {
	decoded, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil || len(decoded) < 20 {
		return "", errors.New("invalid TOTP secret")
	}
	return totpCode(decoded, now.Unix()/30), nil
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

func (a *Authenticator) passwordMatches(password string) bool {
	parts := strings.Split(strings.TrimPrefix(a.passwordHash, passwordPrefix), "$")
	salt, _ := base64.RawStdEncoding.DecodeString(parts[0])
	want, _ := base64.RawStdEncoding.DecodeString(parts[1])
	got := argon2.IDKey([]byte(password), salt, 2, 19456, 1, 32)
	return subtle.ConstantTimeCompare(got, want) == 1
}

func (a *Authenticator) Authenticate(email, password, otp string) (account.Identity, error) {
	passwordOK := a.passwordMatches(password)
	if !passwordOK || !strings.EqualFold(strings.TrimSpace(email), a.email) {
		return account.Identity{}, ErrInvalidCredentials
	}
	if len(otp) != 6 {
		return account.Identity{}, ErrInvalidCredentials
	}
	now := a.now().UTC()
	currentStep := now.Unix() / 30
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, step := range []int64{currentStep, currentStep - 1, currentStep + 1} {
		if step <= a.lastTOTP {
			continue
		}
		code := totpCode(a.totpSecret, step)
		if subtle.ConstantTimeCompare([]byte(code), []byte(otp)) == 1 {
			a.lastTOTP = step
			return account.Identity{Issuer: Issuer, Subject: Subject, Email: a.email, EmailVerified: true, MFA: true, AuthenticatedAt: now}, nil
		}
	}
	return account.Identity{}, ErrInvalidCredentials
}

func totpCode(secret []byte, step int64) string {
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(step))
	mac := hmac.New(sha1.New, secret)
	_, _ = mac.Write(counter[:])
	digest := mac.Sum(nil)
	offset := digest[len(digest)-1] & 0x0f
	value := binary.BigEndian.Uint32(digest[offset:offset+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", value%1000000)
}

type claims struct {
	Issuer    string `json:"iss"`
	Audience  string `json:"aud"`
	Subject   string `json:"sub"`
	Email     string `json:"email"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
	AuthTime  int64  `json:"auth_time"`
	MFA       bool   `json:"mfa"`
	JWTID     string `json:"jti"`
}

func (a *Authenticator) Issue(identity account.Identity) (string, error) {
	if identity.Issuer != Issuer || identity.Subject != Subject || identity.Email != a.email || !identity.MFA {
		return "", ErrInvalidCredentials
	}
	now := a.now().UTC()
	jti := make([]byte, 16)
	if _, err := rand.Read(jti); err != nil {
		return "", err
	}
	claim := claims{Issuer: Issuer, Audience: Audience, Subject: Subject, Email: a.email, IssuedAt: now.Unix(), ExpiresAt: now.Add(15 * time.Minute).Unix(), AuthTime: identity.AuthenticatedAt.Unix(), MFA: true, JWTID: base64.RawURLEncoding.EncodeToString(jti)}
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
	if claim.Issuer != Issuer || claim.Audience != Audience || claim.Subject != Subject || claim.Email != a.email || !claim.MFA || claim.JWTID == "" || claim.IssuedAt > now || claim.ExpiresAt <= now || claim.ExpiresAt-claim.IssuedAt > 900 || claim.AuthTime > now || claim.AuthTime < claim.IssuedAt-30 {
		return account.Identity{}, ErrInvalidCredentials
	}
	return account.Identity{Issuer: Issuer, Subject: Subject, Email: claim.Email, EmailVerified: true, MFA: true, AuthenticatedAt: time.Unix(claim.AuthTime, 0).UTC()}, nil
}
