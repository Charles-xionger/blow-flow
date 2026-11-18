package imagecaptcha

import (
	"bytes"
	"encoding/base64"
	"image/png"
	"strings"
	"testing"
	"time"
)

func TestGenerateReturnsImageWithoutExposingAnswer(t *testing.T) {
	service := New()
	id, image, err := service.Generate()
	if err != nil {
		t.Fatal(err)
	}
	const prefix = "data:image/png;base64,"
	if id == "" || !strings.HasPrefix(image, prefix) {
		t.Fatalf("invalid challenge: id=%q", id)
	}
	data, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(image, prefix))
	if err != nil {
		t.Fatal(err)
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width != 220 || config.Height != 72 {
		t.Fatalf("expected 220x72 PNG, got %+v, %v", config, err)
	}
	if service.Verify(id, "invalid") || service.Verify("", "1234") {
		t.Fatal("invalid answers must be rejected")
	}
}

func TestChallengeStoreEnforcesExpiryAndOneUse(t *testing.T) {
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	store := newChallengeStore(func() time.Time { return now }, 2)
	store.Set("first", []byte{1, 2, 3, 4})
	if got := store.Get("first", false); !bytes.Equal(got, []byte{1, 2, 3, 4}) {
		t.Fatalf("stored challenge = %v", got)
	}
	now = now.Add(challengeLifetime)
	if got := store.Get("first", true); got != nil {
		t.Fatalf("expired challenge accepted: %v", got)
	}
	store.Set("second", []byte{4, 3, 2, 1})
	if got := store.Get("second", true); !bytes.Equal(got, []byte{4, 3, 2, 1}) || store.Get("second", true) != nil {
		t.Fatal("challenge was not consumed once")
	}
}

func TestChallengeStoreBoundsOutstandingEntries(t *testing.T) {
	now := time.Now()
	store := newChallengeStore(func() time.Time { return now }, 2)
	store.Set("first", []byte{1})
	now = now.Add(time.Second)
	store.Set("second", []byte{2})
	now = now.Add(time.Second)
	store.Set("third", []byte{3})
	if store.Get("first", false) != nil || len(store.entries) != 2 {
		t.Fatal("oldest challenge was not evicted at capacity")
	}
}
