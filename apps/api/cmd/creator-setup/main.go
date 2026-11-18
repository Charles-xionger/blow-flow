package main

import (
	"blow-flow/api/internal/database"
	"blow-flow/api/internal/identity/creatorauth"
	"blow-flow/api/internal/identity/localauth"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"gorm.io/gorm"
)

func main() {
	email := flag.String("email", "", "creator email")
	flag.Parse()
	password := os.Getenv("CREATOR_SETUP_PASSWORD")
	if strings.TrimSpace(*email) == "" || password == "" || os.Getenv("DATABASE_URL") == "" {
		fmt.Fprintln(os.Stderr, "-email, CREATOR_SETUP_PASSWORD and DATABASE_URL required")
		os.Exit(2)
	}
	db, pool, err := database.Open(os.Getenv("DATABASE_URL"))
	if err != nil {
		fatal(err)
	}
	defer pool.Close()
	id, err := create(db, strings.ToLower(strings.TrimSpace(*email)), password)
	if err != nil {
		fatal(err)
	}
	fmt.Println("creator user ID:", id)
}
func create(db *gorm.DB, email, password string) (string, error) {
	if len(email) > 320 || !strings.Contains(email, "@") {
		return "", errors.New("invalid email")
	}
	hash, err := localauth.PasswordHash(password)
	if err != nil {
		return "", err
	}
	var random [16]byte
	if _, err = rand.Read(random[:]); err != nil {
		return "", err
	}
	random[6] = (random[6] & 0x0f) | 0x40
	random[8] = (random[8] & 0x3f) | 0x80
	id := fmt.Sprintf("%x-%x-%x-%x-%x", random[:4], random[4:6], random[6:8], random[8:10], random[10:])
	now := time.Now().UTC()
	err = db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec(`SELECT pg_advisory_xact_lock(hashtext(?))`, email).Error; err != nil {
			return err
		}
		var count int64
		if err := tx.Raw(`SELECT count(*) FROM users WHERE lower(email)=?`, email).Scan(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return errors.New("email already belongs to a user")
		}
		if err := tx.Exec(`INSERT INTO users(id,email,status,created_at,updated_at) VALUES(?,?,'active',?,?)`, id, email, now, now).Error; err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO user_identities(issuer,subject,user_id,created_at,last_seen_at) VALUES(?,?,?,?,?)`, creatorauth.Issuer, id, id, now, now).Error; err != nil {
			return err
		}
		if err := tx.Exec(`INSERT INTO user_roles(user_id,role,created_at) VALUES(?,'user',?)`, id, now).Error; err != nil {
			return err
		}
		return tx.Exec(`INSERT INTO creator_credentials(user_id,password_hash,created_at,updated_at) VALUES(?,?,?,?)`, id, hash, now, now).Error
	})
	return id, err
}
func fatal(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
