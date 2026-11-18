package creatorauth

import (
	"blow-flow/api/internal/account"
	"blow-flow/api/internal/identity/localauth"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
)

const Issuer = "blow-flow-creator"

var ErrInvalidCredentials = errors.New("invalid creator credentials")

type Authenticator struct {
	DB         *gorm.DB
	SigningKey []byte
	Now        func() time.Time
	dummyHash  string
}

func New(db *gorm.DB, key []byte, now func() time.Time) (*Authenticator, error) {
	if db == nil || len(key) < 32 {
		return nil, errors.New("creator auth requires database and 32-byte signing key")
	}
	if now == nil {
		now = time.Now
	}
	dummy, _ := localauth.PasswordHash("unusable-dummy-credential")
	return &Authenticator{DB: db, SigningKey: append([]byte(nil), key...), Now: now, dummyHash: dummy}, nil
}

type credential struct {
	UserID       string
	Email        string
	PasswordHash string
	Status       string
}

func (a *Authenticator) Authenticate(ctx context.Context, email, password string) (account.Identity, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	var row credential
	res := a.DB.WithContext(ctx).Raw(`SELECT u.id AS user_id,u.email,c.password_hash,u.status FROM users u JOIN creator_credentials c ON c.user_id=u.id JOIN user_roles r ON r.user_id=u.id AND r.role='user' WHERE lower(u.email)=?`, email).Scan(&row)
	if res.Error != nil {
		return account.Identity{}, res.Error
	}
	hash := row.PasswordHash
	if hash == "" {
		hash = a.dummyHash
	}
	match := localauth.VerifyPassword(hash, password)
	if !match || row.UserID == "" || row.Status != "active" || len(email) > 320 {
		return account.Identity{}, ErrInvalidCredentials
	}
	return account.Identity{Issuer: Issuer, Subject: row.UserID, Email: row.Email, EmailVerified: true, AuthenticatedAt: a.Now().UTC()}, nil
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
	if identity.Issuer != Issuer || identity.Subject == "" || identity.Email == "" || !identity.EmailVerified {
		return "", ErrInvalidCredentials
	}
	now := a.Now().UTC()
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	claim := claims{Issuer: Issuer, Audience: localauth.Audience, Subject: identity.Subject, Email: identity.Email, IssuedAt: now.Unix(), ExpiresAt: now.Add(15 * time.Minute).Unix(), AuthTime: identity.AuthenticatedAt.Unix(), JWTID: base64.RawURLEncoding.EncodeToString(id[:])}
	payload, err := json.Marshal(claim)
	if err != nil {
		return "", err
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	message := header + "." + base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, a.SigningKey)
	mac.Write([]byte(message))
	return message + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}
func (a *Authenticator) Verify(ctx context.Context, raw string) (account.Identity, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 3 || len(raw) > 4096 {
		return account.Identity{}, ErrInvalidCredentials
	}
	header, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || string(header) != `{"alg":"HS256","typ":"JWT"}` {
		return account.Identity{}, ErrInvalidCredentials
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return account.Identity{}, ErrInvalidCredentials
	}
	mac := hmac.New(sha256.New, a.SigningKey)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(sig, mac.Sum(nil)) {
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
	now := a.Now().UTC().Unix()
	if claim.Issuer != Issuer || claim.Audience != localauth.Audience || claim.Subject == "" || claim.Email == "" || claim.JWTID == "" || claim.IssuedAt > now || claim.ExpiresAt <= now || claim.ExpiresAt-claim.IssuedAt > 900 || claim.AuthTime > now || claim.AuthTime < claim.IssuedAt-30 {
		return account.Identity{}, ErrInvalidCredentials
	}
	var row credential
	res := a.DB.WithContext(ctx).Raw(`SELECT u.id AS user_id,u.email,u.status FROM users u JOIN creator_credentials c ON c.user_id=u.id WHERE u.id=?`, claim.Subject).Scan(&row)
	if res.Error != nil {
		return account.Identity{}, res.Error
	}
	if res.RowsAffected != 1 || row.Status != "active" || !strings.EqualFold(row.Email, claim.Email) {
		return account.Identity{}, ErrInvalidCredentials
	}
	return account.Identity{Issuer: Issuer, Subject: row.UserID, Email: row.Email, EmailVerified: true, AuthenticatedAt: time.Unix(claim.AuthTime, 0).UTC()}, nil
}
