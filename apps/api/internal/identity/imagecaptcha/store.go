package imagecaptcha

import (
	"sync"
	"time"
)

type challengeEntry struct {
	digits  []byte
	expires time.Time
}

type challengeStore struct {
	mu      sync.Mutex
	entries map[string]challengeEntry
	now     func() time.Time
	max     int
}

func newChallengeStore(now func() time.Time, max int) *challengeStore {
	return &challengeStore{entries: make(map[string]challengeEntry), now: now, max: max}
}

func (s *challengeStore) Set(id string, digits []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if len(s.entries) >= s.max {
		for key, entry := range s.entries {
			if !now.Before(entry.expires) {
				delete(s.entries, key)
			}
		}
	}
	if len(s.entries) >= s.max {
		var oldestID string
		var oldestExpiry time.Time
		for key, entry := range s.entries {
			if oldestID == "" || entry.expires.Before(oldestExpiry) {
				oldestID, oldestExpiry = key, entry.expires
			}
		}
		delete(s.entries, oldestID)
	}
	s.entries[id] = challengeEntry{digits: append([]byte(nil), digits...), expires: now.Add(challengeLifetime)}
}

func (s *challengeStore) Get(id string, clear bool) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.entries[id]
	if !ok {
		return nil
	}
	expired := !s.now().Before(entry.expires)
	if clear || expired {
		delete(s.entries, id)
	}
	if expired {
		return nil
	}
	return append([]byte(nil), entry.digits...)
}
