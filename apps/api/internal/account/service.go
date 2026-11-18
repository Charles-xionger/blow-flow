package account

import (
	"context"
	"strings"
	"time"
)

const recentAuthenticationWindow = 10 * time.Minute

type Repository interface {
	ResolveIdentity(context.Context, Identity, IdentityProvisioning) (User, error)
	ListUsers(context.Context, ListUsersQuery) (UserPage, error)
	DisableUser(context.Context, DisableUser) (User, error)
	ListAuditEvents(context.Context, ListAuditQuery) (AuditPage, error)
	AppendAdminLogin(context.Context, string, time.Time) error
}

type Service struct {
	repository           Repository
	initialAdministrator InitialAdministrator
	now                  func() time.Time
}

func NewService(repository Repository, initialAdministrator InitialAdministrator, now func() time.Time) *Service {
	if now == nil {
		now = time.Now
	}
	return &Service{repository: repository, initialAdministrator: initialAdministrator, now: now}
}

func (s *Service) Resolve(ctx context.Context, identity Identity) (User, error) {
	if strings.TrimSpace(identity.Issuer) == "" || strings.TrimSpace(identity.Subject) == "" || strings.TrimSpace(identity.Email) == "" {
		return User{}, ErrInvalidArgument
	}
	if !identity.EmailVerified {
		return User{}, ErrEmailUnverified
	}
	provisioning := IdentityProvisioning{MayBecomeInitialAdministrator: s.initialAdministrator.Issuer != "" &&
		identity.Issuer == s.initialAdministrator.Issuer && identity.Subject == s.initialAdministrator.Subject,
		LinkExistingAdministratorByEmail: s.initialAdministrator.LinkExistingByEmail && identity.Issuer == s.initialAdministrator.Issuer && identity.Subject == s.initialAdministrator.Subject}
	user, err := s.repository.ResolveIdentity(ctx, identity, provisioning)
	if err != nil {
		return User{}, err
	}
	if user.Status == StatusDisabled {
		return User{}, ErrAccountDisabled
	}
	return user, nil
}

func (s *Service) ListUsers(ctx context.Context, actor User, query ListUsersQuery) (UserPage, error) {
	if err := requireAdministrator(actor); err != nil {
		return UserPage{}, err
	}
	if query.Status != "" && query.Status != StatusActive && query.Status != StatusDisabled {
		return UserPage{}, ErrInvalidArgument
	}
	query.Limit = normalizedLimit(query.Limit)
	return s.repository.ListUsers(ctx, query)
}

func (s *Service) DisableUser(ctx context.Context, actor User, proof AuthProof, targetID string, reason string) (User, error) {
	if err := requireAdministrator(actor); err != nil {
		return User{}, err
	}
	now := s.now().UTC()
	if proof.AuthenticatedAt.IsZero() || proof.AuthenticatedAt.After(now) || now.Sub(proof.AuthenticatedAt) > recentAuthenticationWindow {
		return User{}, ErrRecentAuthenticationRequired
	}
	if strings.TrimSpace(targetID) == "" || strings.TrimSpace(reason) == "" {
		return User{}, ErrInvalidArgument
	}
	if targetID == actor.ID {
		return User{}, ErrCannotDisableSelf
	}
	return s.repository.DisableUser(ctx, DisableUser{
		ActorID: actor.ID, TargetID: targetID, Reason: strings.TrimSpace(reason), At: now,
	})
}

func (s *Service) ListAuditEvents(ctx context.Context, actor User, query ListAuditQuery) (AuditPage, error) {
	if err := requireAdministrator(actor); err != nil {
		return AuditPage{}, err
	}
	query.Limit = normalizedLimit(query.Limit)
	return s.repository.ListAuditEvents(ctx, query)
}

func (s *Service) RecordAdminLogin(ctx context.Context, user User) error {
	if user.Role != RoleAdmin || user.Status != StatusActive {
		return ErrForbidden
	}
	return s.repository.AppendAdminLogin(ctx, user.ID, s.now().UTC())
}

func requireAdministrator(actor User) error {
	if actor.Status != StatusActive || actor.Role != RoleAdmin {
		return ErrForbidden
	}
	return nil
}

func normalizedLimit(limit int) int {
	if limit <= 0 {
		return 50
	}
	if limit > 100 {
		return 100
	}
	return limit
}
