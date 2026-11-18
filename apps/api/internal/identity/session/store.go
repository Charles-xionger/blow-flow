package session

import (
	"context"
	"crypto/hmac"
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

// Prune removes expired refresh credentials; audit events live in the account domain.
func (s Store) Prune(ctx context.Context) error {
	return s.DB.WithContext(ctx).Exec(`DELETE FROM auth_sessions WHERE expires_at < ?`, s.Now().UTC()).Error
}

type Store struct {
	DB  *gorm.DB
	Now func() time.Time
	Key []byte
}

type row struct {
	ID              string
	FamilyID        string
	UserID          string
	Issuer          string
	Subject         string
	Email           string
	AuthenticatedAt time.Time
	SecretHash      []byte
	ExpiresAt       time.Time
	RevokedAt       *time.Time
	RotatedAt       *time.Time
	RotatedTo       *string
	CurrentEmail    string
	UserStatus      string
}

func lockFamily(tx *gorm.DB, id string) error {
	var parent row
	res := tx.Raw(`SELECT family_id FROM auth_sessions WHERE id=?`, id).Scan(&parent)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected != 1 {
		return ErrInvalid
	}
	return tx.Exec(`SELECT pg_advisory_xact_lock(hashtextextended(?,0))`, "auth-session:"+parent.FamilyID).Error
}

func (s Store) successor(oldID string, oldSecret []byte) (string, [32]byte) {
	mac := hmac.New(sha256.New, s.Key)
	mac.Write([]byte("blow-flow-refresh-successor:" + oldID + ":"))
	mac.Write(oldSecret)
	value := mac.Sum(nil)
	return base64.RawURLEncoding.EncodeToString(value), sha256.Sum256(value)
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
	if s.DB == nil || len(s.Key) < 32 || user.ID == "" || identity.Issuer == "" || identity.Subject == "" || identity.Email == "" {
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
	err = s.DB.WithContext(ctx).Exec(`INSERT INTO auth_sessions(id,family_id,user_id,issuer,subject,email,authenticated_at,secret_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, id, id, user.ID, identity.Issuer, identity.Subject, identity.Email, identity.AuthenticatedAt, hash[:], now.Add(Lifetime), now).Error
	return id + "." + secret, err
}

func (s Store) Rotate(ctx context.Context, raw, issuer string) (account.Identity, string, error) {
	id, secret, ok := parse(raw)
	if !ok || issuer == "" || len(s.Key) < 32 {
		return account.Identity{}, "", ErrInvalid
	}
	var identity account.Identity
	var replacement string
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := lockFamily(tx, id); err != nil {
			return err
		}
		var old row
		res := tx.Raw(`SELECT s.id,s.family_id,s.user_id,s.issuer,s.subject,s.email,s.authenticated_at,s.secret_hash,s.expires_at,s.revoked_at,s.rotated_at,s.rotated_to,u.email AS current_email,u.status AS user_status FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? FOR UPDATE OF s`, id).Scan(&old)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected != 1 || old.Issuer != issuer || old.UserStatus != "active" || !old.ExpiresAt.After(s.Now()) {
			return ErrInvalid
		}
		want := sha256.Sum256(secret)
		if subtle.ConstantTimeCompare(want[:], old.SecretHash) != 1 {
			return ErrInvalid
		}
		if old.RevokedAt != nil {
			if old.RotatedAt == nil || old.RotatedTo == nil || s.Now().Sub(*old.RotatedAt) > 30*time.Second {
				return ErrInvalid
			}
			var successor row
			res := tx.Raw(`SELECT id,secret_hash,revoked_at,expires_at FROM auth_sessions WHERE id=?`, *old.RotatedTo).Scan(&successor)
			if res.Error != nil {
				return res.Error
			}
			if res.RowsAffected != 1 || successor.RevokedAt != nil || !successor.ExpiresAt.After(s.Now()) {
				return ErrInvalid
			}
			value, hash := s.successor(id, secret)
			if subtle.ConstantTimeCompare(hash[:], successor.SecretHash) != 1 {
				return ErrInvalid
			}
			identity = account.Identity{Issuer: old.Issuer, Subject: old.Subject, Email: old.CurrentEmail, EmailVerified: true, AuthenticatedAt: old.AuthenticatedAt}
			replacement = *old.RotatedTo + "." + value
			return nil
		}
		now := s.Now().UTC()
		newID, err := newID()
		if err != nil {
			return err
		}
		newValue, newHash := s.successor(id, secret)
		if err := tx.Exec(`INSERT INTO auth_sessions(id,family_id,user_id,issuer,subject,email,authenticated_at,secret_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, newID, old.FamilyID, old.UserID, old.Issuer, old.Subject, old.CurrentEmail, old.AuthenticatedAt, newHash[:], now.Add(Lifetime), now).Error; err != nil {
			return err
		}
		if err := tx.Exec(`UPDATE auth_sessions SET revoked_at=?,rotated_at=?,rotated_to=? WHERE id=?`, now, now, newID, id).Error; err != nil {
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
	return s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := lockFamily(tx, id); err != nil {
			if errors.Is(err, ErrInvalid) {
				return nil
			}
			return err
		}
		var old row
		res := tx.Raw(`SELECT id,family_id,issuer,secret_hash FROM auth_sessions WHERE id=? FOR UPDATE`, id).Scan(&old)
		if res.Error != nil {
			return res.Error
		}
		want := sha256.Sum256(secret)
		if res.RowsAffected != 1 || old.Issuer != issuer || subtle.ConstantTimeCompare(want[:], old.SecretHash) != 1 {
			return nil
		}
		return tx.Exec(`UPDATE auth_sessions SET revoked_at=? WHERE family_id=? AND revoked_at IS NULL`, s.Now().UTC(), old.FamilyID).Error
	})
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
