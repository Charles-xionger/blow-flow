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
	jwtVerifier *coreoidc.IDTokenVerifier
	profile     Profile
}

type Profile struct {
	MFAAuthenticationMethod string
	MFAAssuranceContext     string
}

func New(ctx context.Context, issuer, audience string, profile Profile) (*Verifier, error) {
	issuer = strings.TrimSpace(issuer)
	audience = strings.TrimSpace(audience)
	if issuer == "" || audience == "" {
		return nil, errors.New("OIDC issuer and audience are required")
	}
	if profile.MFAAuthenticationMethod == "" && profile.MFAAssuranceContext == "" {
		return nil, errors.New("OIDC JWT profile must define an MFA amr or acr value")
	}
	provider, err := coreoidc.NewProvider(ctx, issuer)
	if err != nil {
		return nil, err
	}
	// The selected provider profile requires JWT access tokens. The OIDC verifier
	// validates issuer, audience, signature and time claims against discovery keys.
	return &Verifier{jwtVerifier: provider.Verifier(&coreoidc.Config{ClientID: audience}), profile: profile}, nil
}

func (v *Verifier) Verify(ctx context.Context, rawToken string) (account.Identity, error) {
	token, err := v.jwtVerifier.Verify(ctx, rawToken)
	if err != nil {
		return account.Identity{}, err
	}
	var claims struct {
		Email         string   `json:"email"`
		EmailVerified bool     `json:"email_verified"`
		AMR           []string `json:"amr"`
		ACR           string   `json:"acr"`
		AuthTime      int64    `json:"auth_time"`
	}
	if err := token.Claims(&claims); err != nil {
		return account.Identity{}, err
	}
	identity := account.Identity{
		Issuer: token.Issuer, Subject: token.Subject, Email: strings.ToLower(strings.TrimSpace(claims.Email)), EmailVerified: claims.EmailVerified,
	}
	identity.MFA = v.profile.provesMFA(claims.AMR, claims.ACR)
	if claims.AuthTime > 0 {
		identity.AuthenticatedAt = time.Unix(claims.AuthTime, 0).UTC()
	}
	return identity, nil
}

func (p Profile) provesMFA(methods []string, assuranceContext string) bool {
	for _, method := range methods {
		if p.MFAAuthenticationMethod != "" && method == p.MFAAuthenticationMethod {
			return true
		}
	}
	return p.MFAAssuranceContext != "" && assuranceContext == p.MFAAssuranceContext
}
