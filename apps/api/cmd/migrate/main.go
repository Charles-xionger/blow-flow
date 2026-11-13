package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"ai-flow/api/internal/database"
	"github.com/pressly/goose/v3"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "migration failed (check connection and migration files)")
		os.Exit(1)
	}
}
func run() error {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return errors.New("DATABASE_URL required")
	}
	_, pool, err := database.Open(dsn)
	if err != nil {
		return err
	}
	defer pool.Close()
	files, err := filepath.Glob("migrations/*.sql")
	if err != nil {
		return err
	}
	if len(files) == 0 {
		fmt.Println("No domain migrations yet; legacy data has not been migrated.")
		return nil
	}
	if err = goose.SetDialect("postgres"); err != nil {
		return err
	}
	return goose.Up(pool, "migrations")
}
