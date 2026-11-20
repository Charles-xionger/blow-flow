package skill

import (
	"context"
	"encoding/base64"
	"errors"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgconn"
	"gorm.io/gorm"
)

var ErrInvalid = errors.New("invalid skill")
var ErrNotFound = errors.New("skill not found")
var ErrConflict = errors.New("skill already exists")
var ErrReadOnly = errors.New("built-in skill is read-only")
var namePattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
var builtins = map[string]bool{"screenplay": true, "storyboard": true}

type Summary struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Source      string   `json:"source"`
	ReadOnly    bool     `json:"readOnly"`
	Resources   []string `json:"resources"`
}
type Detail struct {
	Summary
	Instructions string `json:"instructions"`
}
type Upload struct {
	Name         string            `json:"name"`
	Description  string            `json:"description"`
	Instructions string            `json:"instructions"`
	Resources    map[string]string `json:"resources"`
}
type Service struct{ DB *gorm.DB }

func New(db *gorm.DB) *Service { return &Service{DB: db} }
func ValidName(name string) bool {
	return len(name) > 0 && len(name) <= 64 && namePattern.MatchString(name)
}
func validPath(path string) bool {
	if path == "" || len(path) > 512 || strings.HasPrefix(path, "/") || strings.Contains(path, "\\") {
		return false
	}
	for _, p := range strings.Split(path, "/") {
		if p == "" || p == "." || p == ".." {
			return false
		}
	}
	return true
}
func (s *Service) List(ctx context.Context, owner string) ([]Summary, error) {
	var rows []struct{ Name, Description string }
	if err := s.DB.WithContext(ctx).Raw(`SELECT name,description FROM user_skills WHERE owner_id=? ORDER BY created_at,name`, owner).Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]Summary, 0, len(rows))
	for _, row := range rows {
		var resourceRows []struct{ Path string }
		if err := s.DB.WithContext(ctx).Raw(`SELECT path FROM user_skill_resources WHERE owner_id=? AND skill_name=? ORDER BY path`, owner, row.Name).Scan(&resourceRows).Error; err != nil {
			return nil, err
		}
		paths := make([]string, 0, len(resourceRows))
		for _, r := range resourceRows {
			paths = append(paths, r.Path)
		}
		out = append(out, Summary{ID: row.Name, Name: row.Name, Description: row.Description, Source: "用户上传", Resources: paths})
	}
	return out, nil
}
func (s *Service) Get(ctx context.Context, owner, id string) (Detail, error) {
	var row struct{ Name, Description, Instructions string }
	q := s.DB.WithContext(ctx).Raw(`SELECT name,description,instructions FROM user_skills WHERE owner_id=? AND name=?`, owner, id).Scan(&row)
	if q.Error != nil {
		return Detail{}, q.Error
	}
	if q.RowsAffected == 0 {
		return Detail{}, ErrNotFound
	}
	var resourceRows []struct{ Path string }
	if err := s.DB.WithContext(ctx).Raw(`SELECT path FROM user_skill_resources WHERE owner_id=? AND skill_name=? ORDER BY path`, owner, id).Scan(&resourceRows).Error; err != nil {
		return Detail{}, err
	}
	paths := make([]string, 0, len(resourceRows))
	for _, r := range resourceRows {
		paths = append(paths, r.Path)
	}
	return Detail{Summary: Summary{ID: id, Name: id, Description: row.Description, Source: "用户上传", Resources: paths}, Instructions: row.Instructions}, nil
}
func (s *Service) Read(ctx context.Context, owner, id, path string) (string, error) {
	if path == "" {
		detail, err := s.Get(ctx, owner, id)
		return detail.Instructions, err
	}
	var row struct{ Content []byte }
	q := s.DB.WithContext(ctx).Raw(`SELECT content FROM user_skill_resources WHERE owner_id=? AND skill_name=? AND path=?`, owner, id, path).Scan(&row)
	if q.Error != nil {
		return "", q.Error
	}
	if q.RowsAffected == 0 {
		return "", ErrNotFound
	}
	return string(row.Content), nil
}
func (s *Service) Upload(ctx context.Context, owner string, input Upload) (Summary, error) {
	if !ValidName(input.Name) || builtins[input.Name] || input.Description != strings.TrimSpace(input.Description) || input.Description == "" || len(input.Description) > 1024 || strings.TrimSpace(input.Instructions) == "" || len(input.Instructions) > 20<<20 || len(input.Resources) > 1000 {
		if builtins[input.Name] {
			return Summary{}, ErrConflict
		}
		return Summary{}, ErrInvalid
	}
	total := len(input.Instructions)
	resources := map[string][]byte{}
	paths := make([]string, 0, len(input.Resources))
	for path, encoded := range input.Resources {
		if !validPath(path) {
			return Summary{}, ErrInvalid
		}
		bytes, err := base64.StdEncoding.Strict().DecodeString(encoded)
		if err != nil || len(bytes) > 20<<20 {
			return Summary{}, ErrInvalid
		}
		total += len(bytes)
		resources[path] = bytes
		paths = append(paths, path)
	}
	if total > 200<<20 {
		return Summary{}, ErrInvalid
	}
	sort.Strings(paths)
	err := s.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		now := time.Now().UTC()
		if err := tx.Exec(`INSERT INTO user_skills(owner_id,name,description,instructions,created_at) VALUES(?,?,?,?,?)`, owner, input.Name, input.Description, input.Instructions, now).Error; err != nil {
			return err
		}
		for _, path := range paths {
			if err := tx.Exec(`INSERT INTO user_skill_resources(owner_id,skill_name,path,content) VALUES(?,?,?,?)`, owner, input.Name, path, resources[path]).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		var pg *pgconn.PgError
		if errors.As(err, &pg) && pg.Code == "23505" {
			return Summary{}, ErrConflict
		}
		return Summary{}, err
	}
	return Summary{ID: input.Name, Name: input.Name, Description: input.Description, Source: "用户上传", Resources: paths}, nil
}
func (s *Service) Delete(ctx context.Context, owner, id string) error {
	if builtins[id] {
		return ErrReadOnly
	}
	if !ValidName(id) {
		return ErrInvalid
	}
	q := s.DB.WithContext(ctx).Exec(`DELETE FROM user_skills WHERE owner_id=? AND name=?`, owner, id)
	if q.Error != nil {
		return q.Error
	}
	if q.RowsAffected == 0 {
		return ErrNotFound
	}
	return nil
}
func ValidImport(name, description, instructions string) bool {
	return ValidName(name) && !builtins[name] && description != "" && len(description) <= 1024 && utf8.ValidString(description) && strings.TrimSpace(instructions) != "" && utf8.ValidString(instructions)
}
func ValidResourcePath(path string) bool { return validPath(path) }
