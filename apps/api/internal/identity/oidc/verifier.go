package oidc

import (
	"context"
	"errors"
	"strings"
	"time"

	"blow-flow/api/internal/account"
	coreoidc "github.com/coreos/go-oidc/v3/oidc"
)

type Verifier struct {
	verifier *coreoidc.IDTokenVerifier
}

func New(ctx context.Context, issuer, audience string) (*Verifier, error) {
	issuer = strings.TrimSpace(issuer)
	audience = strings.TrimSpace(audience)
	if issuer == "" || audience == "" {
		return nil, errors.New("OIDC issuer and audience are required")
	}
	provider, err := coreoidc.NewProvider(ctx, issuer)
	if err != nil {
		return nil, err
	}
	return &Verifier{verifier: provider.Verifier(&coreoidc.Config{ClientID: audience})}, nil
}

func (v *Verifier) Verify(ctx context.Context, rawToken string) (account.Identity, error) {
	token, err := v.verifier.Verify(ctx, rawToken)
	if err != nil {
		return account.Identity{}, err
	}
	var claims struct {
		Email         string   `json:"email"`
		EmailVerified bool     `json:"email_verified"`
		AMR           []string `json:"amr"`
		AuthTime      int64    `json:"auth_time"`
	}
	if err := token.Claims(&claims); err != nil {
		return account.Identity{}, err
	}
	identity := account.Identity{
		Issuer: token.Issuer, Subject: token.Subject, Email: strings.ToLower(strings.TrimSpace(claims.Email)), EmailVerified: claims.EmailVerified,
	}
	for _, method := range claims.AMR {
		if method == "mfa" {
			identity.MFA = true
			break
		}
	}
	if claims.AuthTime > 0 {
		identity.AuthenticatedAt = time.Unix(claims.AuthTime, 0).UTC()
	}
	return identity, nil
}
