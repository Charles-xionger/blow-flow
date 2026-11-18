package session

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"blow-flow/api/internal/account"
	"gorm.io/gorm"
)

var ErrInvalid = errors.New("invalid refresh session")

const Lifetime = 7 * 24 * time.Hour

type Store struct {
	DB  *gorm.DB
	Now func() time.Time
}

type row struct {
	ID              string
	UserID          string
	Issuer          string
	Subject         string
	Email           string
	AuthenticatedAt time.Time
	SecretHash      []byte
	ExpiresAt       time.Time
	RevokedAt       *time.Time
	CurrentEmail    string
	UserStatus      string
}

func newSecret() (string, [32]byte, error) {
	var bytes [32]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", [32]byte{}, err
	}
	return base64.RawURLEncoding.EncodeToString(bytes[:]), sha256.Sum256(bytes[:]), nil
}

func newID() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	value := hex.EncodeToString(bytes[:])
	return value[:8] + "-" + value[8:12] + "-" + value[12:16] + "-" + value[16:20] + "-" + value[20:], nil
}

func (s Store) Issue(ctx context.Context, user account.User, identity account.Identity) (string, error) {
	if s.DB == nil || user.ID == "" || identity.Issuer == "" || identity.Subject == "" || identity.Email == "" {
		return "", ErrInvalid
	}
	id, err := newID()
	if err != nil {
		return "", err
	}
	secret, hash, err := newSecret()
	if err != nil {
		return "", err
	}
	now := s.Now().UTC()
	err = s.DB.WithContext(ctx).Exec(`INSERT INTO auth_sessions(id,user_id,issuer,subject,email,authenticated_at,secret_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, id, user.ID, identity.Issuer, identity.Subject, identity.Email, identity.AuthenticatedAt, hash[:], now.Add(Lifetime), now).Error
	return id + "." + secret, err
}

func (s Store) Rotate(ctx context.Context, raw, issuer string) (account.Identity, string, error) {
	id, secret, ok := parse(raw)
	if !ok || issuer == "" {
		return account.Identity{}, "", ErrInvalid
	}
	var identity account.Identity
	var replacement string
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var old row
		res := tx.Raw(`SELECT s.id,s.user_id,s.issuer,s.subject,s.email,s.authenticated_at,s.secret_hash,s.expires_at,s.revoked_at,u.email AS current_email,u.status AS user_status FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? FOR UPDATE OF s`, id).Scan(&old)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 || old.Issuer != issuer || old.RevokedAt != nil || old.UserStatus != "active" || !old.ExpiresAt.After(s.Now()) {
			return ErrInvalid
		}
		want := sha256.Sum256(secret)
		if subtle.ConstantTimeCompare(want[:], old.SecretHash) != 1 {
			return ErrInvalid
		}
		now := s.Now().UTC()
		if err := tx.Exec(`UPDATE auth_sessions SET revoked_at=?,rotated_at=? WHERE id=?`, now, now, id).Error; err != nil {
			return err
		}
		newID, err := newID()
		if err != nil {
			return err
		}
		newValue, newHash, err := newSecret()
		if err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO auth_sessions(id,user_id,issuer,subject,email,authenticated_at,secret_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, newID, old.UserID, old.Issuer, old.Subject, old.CurrentEmail, old.AuthenticatedAt, newHash[:], now.Add(Lifetime), now).Error; err != nil {
			return err
		}
		identity = account.Identity{Issuer: old.Issuer, Subject: old.Subject, Email: old.CurrentEmail, EmailVerified: true, AuthenticatedAt: old.AuthenticatedAt}
		replacement = newID + "." + newValue
		return nil
	})
	return identity, replacement, err
}

func (s Store) Revoke(ctx context.Context, raw, issuer string) error {
	id, secret, ok := parse(raw)
	if !ok {
		return nil
	}
	var old row
	res := s.DB.WithContext(ctx).Raw(`SELECT id,issuer,secret_hash FROM auth_sessions WHERE id=?`, id).Scan(&old)
	if res.Error != nil {
		return res.Error
	}
	want := sha256.Sum256(secret)
	if res.RowsAffected != 1 || old.Issuer != issuer || subtle.ConstantTimeCompare(want[:], old.SecretHash) != 1 {
		return nil
	}
	return s.DB.WithContext(ctx).Exec(`UPDATE auth_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL`, s.Now().UTC(), id).Error
}

func parse(raw string) (string, []byte, bool) {
	if len(raw) > 150 {
		return "", nil, false
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 2 || len(parts[0]) != 36 {
		return "", nil, false
	}
	secret, err := base64.RawURLEncoding.DecodeString(parts[1])
	return parts[0], secret, err == nil && len(secret) == 32
}
