//go:build integration

package database

import (
	"context"
	"fmt"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"blow-flow/api/internal/httpserver"
	"github.com/pressly/goose/v3"
	"gorm.io/gorm"
)

func TestPostgresMigrationsTransactionsAndReadiness(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Fatal("TEST_DATABASE_URL is required; integration tests must not silently skip")
	}
	_, admin, err := Open(dsn)
	if err != nil {
		t.Fatal("test database configuration invalid")
	}
	defer admin.Close()
	schema := fmt.Sprintf("test_%d", time.Now().UnixNano())
	if _, err = admin.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatal("cannot create isolated test schema")
	}
	defer admin.Exec("DROP SCHEMA " + schema + " CASCADE")
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatal("TEST_DATABASE_URL must be a postgres URL")
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	db, pool, err := Open(parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	dir := t.TempDir()
	sql := "-- +goose Up\nCREATE TABLE test_receipts (id text PRIMARY KEY, body jsonb NOT NULL);\n-- +goose Down\nDROP TABLE test_receipts;\n"
	if err = os.WriteFile(filepath.Join(dir, "00001_receipts.sql"), []byte(sql), 0600); err != nil {
		t.Fatal(err)
	}
	if err = goose.SetDialect("postgres"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err = goose.Up(pool, dir); err != nil {
			t.Fatal(err)
		}
	}
	version, err := goose.GetDBVersion(pool)
	if err != nil || version != 1 {
		t.Fatalf("migration version: %d (%v)", version, err)
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("INSERT INTO test_receipts VALUES (?, ?::jsonb)", "request-1", `{"status":"queued"}`).Error; err != nil {
			return err
		}
		return fmt.Errorf("rollback fixture")
	})
	if err == nil {
		t.Fatal("expected rollback")
	}
	var count int64
	if err = db.Table("test_receipts").Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("transaction rollback lost")
	}
	if err = db.Exec("INSERT INTO test_receipts VALUES (?, ?::jsonb)", "request-1", `{"status":"queued"}`).Error; err != nil {
		t.Fatal(err)
	}
	if err = db.Exec("INSERT INTO test_receipts VALUES (?, ?::jsonb)", "request-1", `{}`).Error; err == nil {
		t.Fatal("duplicate identity accepted")
	}
	router := httpserver.New(func(ctx context.Context) error { return Check(ctx, pool) })
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/health/ready", nil))
	if w.Code != 200 {
		t.Fatalf("ready returned %d", w.Code)
	}
	pool.Close()
	w = httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/health/ready", nil))
	if w.Code != 503 {
		t.Fatal("closed database reported ready")
	}
}
