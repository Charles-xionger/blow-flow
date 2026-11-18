package postgres

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"blow-flow/api/internal/account"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Repository struct {
	db  *gorm.DB
	now func() time.Time
}

func New(db *gorm.DB, now func() time.Time) *Repository {
	if now == nil {
		now = time.Now
	}
	return &Repository{db: db, now: now}
}

type userRow struct {
	ID        string
	Email     string
	Status    string
	Role      string
	CreatedAt time.Time
	UpdatedAt time.Time
}

func (r *Repository) ResolveIdentity(ctx context.Context, identity account.Identity, provisioning account.IdentityProvisioning) (account.User, error) {
	var resolved account.User
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		lockKey, err := json.Marshal([]string{identity.Issuer, identity.Subject})
		if err != nil {
			return err
		}
		if err := tx.Exec("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", string(lockKey)).Error; err != nil {
			return err
		}
		row, err := findByIdentity(tx, identity.Issuer, identity.Subject)
		if err == nil {
			resolved = row.toDomain()
			now := r.now().UTC()
			if err := tx.Model(&identityModel{}).Where("issuer = ? AND subject = ?", identity.Issuer, identity.Subject).Update("last_seen_at", now).Error; err != nil {
				return err
			}
			if !strings.EqualFold(row.Email, identity.Email) {
				if err := tx.Model(&userModel{}).Where("id = ?", row.ID).Updates(map[string]any{"email": strings.ToLower(identity.Email), "updated_at": now}).Error; err != nil {
					return err
				}
				resolved.Email = strings.ToLower(identity.Email)
				resolved.UpdatedAt = now
			}
			return nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}

		now := r.now().UTC()
		role := account.RoleUser
		if provisioning.MayBecomeInitialAdministrator {
			if err := tx.Exec("SELECT pg_advisory_xact_lock(hashtextextended('blow-flow:initial-administrator', 0))").Error; err != nil {
				return err
			}
			var administratorCount int64
			if err := tx.Model(&roleModel{}).Where("role = ?", account.RoleAdmin).Count(&administratorCount).Error; err != nil {
				return err
			}
			if administratorCount == 0 {
				role = account.RoleAdmin
			} else if provisioning.LinkExistingAdministratorByEmail {
				var matches []userRow
				if err := tx.Table("users u").Select("u.id, u.email, u.status, ur.role, u.created_at, u.updated_at").
					Joins("JOIN user_roles ur ON ur.user_id = u.id").
					Where("ur.role = ? AND lower(u.email) = ?", account.RoleAdmin, strings.ToLower(identity.Email)).Limit(2).Scan(&matches).Error; err != nil {
					return err
				}
				if len(matches) != 1 || matches[0].Status != string(account.StatusActive) {
					return account.ErrForbidden
				}
				if err := tx.Create(&identityModel{Issuer: identity.Issuer, Subject: identity.Subject, UserID: matches[0].ID, CreatedAt: now, LastSeenAt: now}).Error; err != nil {
					return err
				}
				resolved = matches[0].toDomain()
				return nil
			}
		}
		userID, err := newUUID()
		if err != nil {
			return err
		}
		user := userModel{ID: userID, Email: strings.ToLower(identity.Email), Status: string(account.StatusActive), CreatedAt: now, UpdatedAt: now}
		if err := tx.Create(&user).Error; err != nil {
			return err
		}
		if err := tx.Create(&identityModel{Issuer: identity.Issuer, Subject: identity.Subject, UserID: userID, CreatedAt: now, LastSeenAt: now}).Error; err != nil {
			return err
		}
		if err := tx.Create(&roleModel{UserID: userID, Role: string(role), CreatedAt: now}).Error; err != nil {
			return err
		}
		resolved = account.User{ID: userID, Email: user.Email, Status: account.StatusActive, Role: role, CreatedAt: now, UpdatedAt: now}
		return nil
	})
	return resolved, err
}

func (r *Repository) ListUsers(ctx context.Context, query account.ListUsersQuery) (account.UserPage, error) {
	db := r.db.WithContext(ctx).Table("users u").
		Select("u.id, u.email, u.status, ur.role, u.created_at, u.updated_at").
		Joins("JOIN user_roles ur ON ur.user_id = u.id").
		Order("u.created_at DESC, u.id DESC")
	if query.Status != "" {
		db = db.Where("u.status = ?", query.Status)
	}
	if query.Cursor != "" {
		cursor, err := decodeCursor(query.Cursor)
		if err != nil {
			return account.UserPage{}, account.ErrInvalidArgument
		}
		db = db.Where("(u.created_at, u.id) < (?, ?)", cursor.CreatedAt, cursor.ID)
	}
	var rows []userRow
	if err := db.Limit(query.Limit + 1).Scan(&rows).Error; err != nil {
		return account.UserPage{}, err
	}
	page := account.UserPage{Users: make([]account.User, 0, min(len(rows), query.Limit))}
	for i, row := range rows {
		if i == query.Limit {
			last := rows[i-1]
			page.NextCursor = encodeCursor(cursorValue{CreatedAt: last.CreatedAt, ID: last.ID})
			break
		}
		page.Users = append(page.Users, row.toDomain())
	}
	return page, nil
}

func (r *Repository) DisableUser(ctx context.Context, change account.DisableUser) (account.User, error) {
	var changed account.User
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var user userModel
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&user, "id = ?", change.TargetID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return account.ErrNotFound
			}
			return err
		}
		if err := tx.Model(&user).Updates(map[string]any{"status": account.StatusDisabled, "updated_at": change.At}).Error; err != nil {
			return err
		}
		metadata, err := json.Marshal(map[string]any{"previousStatus": user.Status, "status": account.StatusDisabled, "reason": change.Reason})
		if err != nil {
			return err
		}
		eventID, err := newUUID()
		if err != nil {
			return err
		}
		event := auditModel{ID: eventID, ActorID: change.ActorID, Action: "user.status_changed", TargetType: "user", TargetID: change.TargetID, Metadata: metadata, OccurredAt: change.At}
		if err := tx.Create(&event).Error; err != nil {
			return err
		}
		row, err := findUser(tx, change.TargetID)
		if err != nil {
			return err
		}
		changed = row.toDomain()
		return nil
	})
	return changed, err
}

func (r *Repository) ListAuditEvents(ctx context.Context, query account.ListAuditQuery) (account.AuditPage, error) {
	db := r.db.WithContext(ctx).Model(&auditModel{}).Order("occurred_at DESC, id DESC")
	if query.Cursor != "" {
		cursor, err := decodeCursor(query.Cursor)
		if err != nil {
			return account.AuditPage{}, account.ErrInvalidArgument
		}
		db = db.Where("(occurred_at, id) < (?, ?)", cursor.CreatedAt, cursor.ID)
	}
	var rows []auditModel
	if err := db.Limit(query.Limit + 1).Find(&rows).Error; err != nil {
		return account.AuditPage{}, err
	}
	page := account.AuditPage{Events: make([]account.AuditEvent, 0, min(len(rows), query.Limit))}
	for i, row := range rows {
		if i == query.Limit {
			last := rows[i-1]
			page.NextCursor = encodeCursor(cursorValue{CreatedAt: last.OccurredAt, ID: last.ID})
			break
		}
		metadata := map[string]any{}
		if err := json.Unmarshal(row.Metadata, &metadata); err != nil {
			return account.AuditPage{}, err
		}
		page.Events = append(page.Events, account.AuditEvent{ID: row.ID, ActorID: row.ActorID, Action: row.Action, TargetType: row.TargetType, TargetID: row.TargetID, Metadata: metadata, OccurredAt: row.OccurredAt})
	}
	return page, nil
}

func (r *Repository) AppendAdminLogin(ctx context.Context, userID string, at time.Time) error {
	id, err := newUUID()
	if err != nil {
		return err
	}
	return r.db.WithContext(ctx).Create(&auditModel{ID: id, ActorID: userID, Action: "admin.logged_in", TargetType: "user", TargetID: userID, Metadata: []byte(`{}`), OccurredAt: at}).Error
}

type userModel struct {
	ID        string `gorm:"type:uuid;primaryKey"`
	Email     string
	Status    string
	CreatedAt time.Time
	UpdatedAt time.Time
}

func (userModel) TableName() string { return "users" }

type identityModel struct {
	Issuer     string `gorm:"primaryKey"`
	Subject    string `gorm:"primaryKey"`
	UserID     string `gorm:"type:uuid"`
	CreatedAt  time.Time
	LastSeenAt time.Time
}

func (identityModel) TableName() string { return "user_identities" }

type roleModel struct {
	UserID    string `gorm:"type:uuid;primaryKey"`
	Role      string
	CreatedAt time.Time
}

func (roleModel) TableName() string { return "user_roles" }

type auditModel struct {
	ID         string `gorm:"type:uuid;primaryKey"`
	ActorID    string `gorm:"type:uuid"`
	Action     string
	TargetType string
	TargetID   string
	Metadata   []byte `gorm:"type:jsonb"`
	OccurredAt time.Time
}

func (auditModel) TableName() string { return "audit_events" }

func findByIdentity(tx *gorm.DB, issuer, subject string) (userRow, error) {
	var row userRow
	err := tx.Table("users u").Select("u.id, u.email, u.status, ur.role, u.created_at, u.updated_at").
		Joins("JOIN user_identities ui ON ui.user_id = u.id").
		Joins("JOIN user_roles ur ON ur.user_id = u.id").
		Where("ui.issuer = ? AND ui.subject = ?", issuer, subject).Take(&row).Error
	return row, err
}

func findUser(tx *gorm.DB, id string) (userRow, error) {
	var row userRow
	err := tx.Table("users u").Select("u.id, u.email, u.status, ur.role, u.created_at, u.updated_at").
		Joins("JOIN user_roles ur ON ur.user_id = u.id").Where("u.id = ?", id).Take(&row).Error
	return row, err
}

func (r userRow) toDomain() account.User {
	return account.User{ID: r.ID, Email: r.Email, Status: account.Status(r.Status), Role: account.Role(r.Role), CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt}
}

type cursorValue struct {
	CreatedAt time.Time `json:"t"`
	ID        string    `json:"id"`
}

func encodeCursor(cursor cursorValue) string {
	value, _ := json.Marshal(cursor)
	return base64.RawURLEncoding.EncodeToString(value)
}

func decodeCursor(value string) (cursorValue, error) {
	var cursor cursorValue
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return cursor, err
	}
	if err := json.Unmarshal(raw, &cursor); err != nil || cursor.CreatedAt.IsZero() || cursor.ID == "" {
		return cursor, account.ErrInvalidArgument
	}
	return cursor, nil
}

func newUUID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	hexValue := hex.EncodeToString(value[:])
	return hexValue[0:8] + "-" + hexValue[8:12] + "-" + hexValue[12:16] + "-" + hexValue[16:20] + "-" + hexValue[20:32], nil
}
