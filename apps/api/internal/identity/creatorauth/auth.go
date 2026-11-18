package creatorauth

import (
	"blow-flow/api/internal/account"
	"blow-flow/api/internal/identity/localauth"
	"blow-flow/api/internal/identity/signedtoken"
	"context"
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

func (a *Authenticator) Issue(identity account.Identity) (string, error) {
	if identity.Issuer != Issuer || identity.Subject == "" || identity.Email == "" || !identity.EmailVerified {
		return "", ErrInvalidCredentials
	}
	return signedtoken.Issue(a.SigningKey, Issuer, localauth.Audience, identity.Subject, identity.Email, identity.AuthenticatedAt, a.Now())
}
func (a *Authenticator) Verify(ctx context.Context, raw string) (account.Identity, error) {
	claim, err := signedtoken.Verify(a.SigningKey, Issuer, localauth.Audience, raw, a.Now())
	if err != nil {
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
