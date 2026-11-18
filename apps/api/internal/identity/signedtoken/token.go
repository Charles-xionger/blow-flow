package signedtoken

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

var ErrInvalid = errors.New("invalid signed token")

const headerJSON = `{"alg":"HS256","typ":"JWT"}`

type Claims struct {
	Issuer    string `json:"iss"`
	Audience  string `json:"aud"`
	Subject   string `json:"sub"`
	Email     string `json:"email"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
	AuthTime  int64  `json:"auth_time"`
	JWTID     string `json:"jti"`
}

func Issue(key []byte, issuer, audience, subject, email string, authenticatedAt, now time.Time) (string, error) {
	if len(key) < 32 || issuer == "" || audience == "" || subject == "" || email == "" || authenticatedAt.IsZero() {
		return "", ErrInvalid
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	now = now.UTC()
	claim := Claims{Issuer: issuer, Audience: audience, Subject: subject, Email: email, IssuedAt: now.Unix(), ExpiresAt: now.Add(15 * time.Minute).Unix(), AuthTime: authenticatedAt.Unix(), JWTID: base64.RawURLEncoding.EncodeToString(id[:])}
	payload, err := json.Marshal(claim)
	if err != nil {
		return "", err
	}
	message := base64.RawURLEncoding.EncodeToString([]byte(headerJSON)) + "." + base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(message))
	return message + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}
func Verify(key []byte, issuer, audience, raw string, now time.Time) (Claims, error) {
	parts := strings.Split(raw, ".")
	if len(key) < 32 || len(parts) != 3 || len(raw) > 4096 {
		return Claims{}, ErrInvalid
	}
	header, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || string(header) != headerJSON {
		return Claims{}, ErrInvalid
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return Claims{}, ErrInvalid
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return Claims{}, ErrInvalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Claims{}, ErrInvalid
	}
	var claim Claims
	if json.Unmarshal(payload, &claim) != nil {
		return Claims{}, ErrInvalid
	}
	seconds := now.UTC().Unix()
	if claim.Issuer != issuer || claim.Audience != audience || claim.Subject == "" || claim.Email == "" || claim.JWTID == "" || claim.IssuedAt > seconds || claim.ExpiresAt <= seconds || claim.ExpiresAt-claim.IssuedAt > 900 || claim.AuthTime <= 0 || claim.AuthTime > claim.IssuedAt+30 || claim.AuthTime > seconds {
		return Claims{}, ErrInvalid
	}
	return claim, nil
}
