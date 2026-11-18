package signedtoken

import (
	"strings"
	"testing"
	"time"
)

func TestRefreshedAccessTokenPreservesOriginalAuthenticationTime(t *testing.T) {
	key := []byte(strings.Repeat("k", 32))
	now := time.Now().UTC().Truncate(time.Second)
	authenticated := now.Add(-time.Hour)
	token, err := Issue(key, "issuer", "audience", "subject", "user@example.com", authenticated, now)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := Verify(key, "issuer", "audience", token, now)
	if err != nil || claims.AuthTime != authenticated.Unix() {
		t.Fatalf("refreshed access token: %+v %v", claims, err)
	}
}
