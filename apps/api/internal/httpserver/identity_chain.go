package httpserver

import (
	"blow-flow/api/internal/account"
	"context"
	"errors"
)

// IdentityChain accepts separately scoped local administrator and creator JWTs.
// Each verifier checks issuer, signature, expiry, and its own account binding.
type IdentityChain []IdentityVerifier

func (chain IdentityChain) Verify(ctx context.Context, raw string) (account.Identity, error) {
	for _, v := range chain {
		if v == nil {
			continue
		}
		identity, err := v.Verify(ctx, raw)
		if err == nil {
			return identity, nil
		}
	}
	return account.Identity{}, errors.New("invalid bearer token")
}
