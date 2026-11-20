package generation

import (
	"errors"
	"testing"
	"time"
)

func TestSubmissionFailureMetadataPreservesBreakerClassAndRetryAfter(t *testing.T) {
	want := 7 * time.Minute
	err := NewSubmissionFailure(SubmissionRateLimited, true, want, errors.New("HTTP 429"))
	class, certain, retryAfter := SubmissionFailureDetails(err)
	if class != SubmissionRateLimited || !certain || retryAfter != want {
		t.Fatalf("details = %q %v %v", class, certain, retryAfter)
	}
	if !errors.Is(err, ErrSubmissionRejected) {
		t.Fatal("explicit rate limit must remain a safe rejection")
	}
}
