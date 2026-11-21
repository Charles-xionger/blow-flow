package generation

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

// ProviderUsage is private to the generation operations interface.
type ProviderUsage struct {
	Fields      map[string]json.RawMessage `json:"fields"`
	Source      string                     `json:"source"`
	Amount      string                     `json:"amount,omitempty"`
	Currency    string                     `json:"currency,omitempty"`
	PriceSource string                     `json:"priceSource,omitempty"`
	CollectedAt time.Time                  `json:"collectedAt"`
}

type AdminTaskDetail struct {
	ID           string         `json:"id"`
	Model        string         `json:"model"`
	ConnectionID string         `json:"connectionId"`
	Status       Status         `json:"status"`
	Stage        string         `json:"stage"`
	FailureCode  string         `json:"failureCode,omitempty"`
	Usage        *ProviderUsage `json:"usage,omitempty"`
}

func (s Service) AdminTaskDetail(ctx context.Context, actor Actor, id string) (AdminTaskDetail, error) {
	if !actor.Admin || actor.ID == "" {
		return AdminTaskDetail{}, ErrForbidden
	}
	if id == "" || len(id) > 128 || strings.TrimSpace(id) != id {
		return AdminTaskDetail{}, ErrInvalid
	}
	store, ok := s.Store.(interface {
		AdminTaskDetail(context.Context, string, string) (AdminTaskDetail, error)
	})
	if !ok {
		return AdminTaskDetail{}, ErrNotFound
	}
	return store.AdminTaskDetail(ctx, actor.ID, id)
}
