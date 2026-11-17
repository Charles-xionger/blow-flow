package account

import (
	"errors"
	"time"
)

type Role string

const (
	RoleUser  Role = "user"
	RoleAdmin Role = "admin"
)

type Status string

const (
	StatusActive   Status = "active"
	StatusDisabled Status = "disabled"
)

var (
	ErrEmailUnverified   = errors.New("email is not verified")
	ErrAccountDisabled   = errors.New("account is disabled")
	ErrForbidden         = errors.New("operation is forbidden")
	ErrRecentMFARequired = errors.New("recent multi-factor authentication is required")
	ErrInvalidArgument   = errors.New("invalid argument")
	ErrNotFound          = errors.New("resource not found")
)

type Identity struct {
	Issuer          string
	Subject         string
	Email           string
	EmailVerified   bool
	MFA             bool
	AuthenticatedAt time.Time
}

type AuthProof struct {
	MFA             bool
	AuthenticatedAt time.Time
}

type User struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Role      Role      `json:"role"`
	Status    Status    `json:"status"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type ListUsersQuery struct {
	Limit  int
	Cursor string
	Status Status
}

type UserPage struct {
	Users      []User `json:"users"`
	NextCursor string `json:"nextCursor,omitempty"`
}

type StatusChange struct {
	ActorID  string
	TargetID string
	Status   Status
	Reason   string
	At       time.Time
}

type AuditEvent struct {
	ID         string         `json:"id"`
	ActorID    string         `json:"actorId"`
	Action     string         `json:"action"`
	TargetType string         `json:"targetType"`
	TargetID   string         `json:"targetId"`
	Metadata   map[string]any `json:"metadata"`
	OccurredAt time.Time      `json:"occurredAt"`
}

type ListAuditQuery struct {
	Limit  int
	Cursor string
}

type AuditPage struct {
	Events     []AuditEvent `json:"events"`
	NextCursor string       `json:"nextCursor,omitempty"`
}
