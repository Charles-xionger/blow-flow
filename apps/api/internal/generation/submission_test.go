package generation

import (
	"errors"
	"testing"
	"time"
)

func TestSubmissionFailureMetadataPreservesBreakerClassAndRetryAfter(t *testing.T) {
	want := 7 * time.Minute
	err := NewSubmissionFailure(SubmissionRateLimited, true, want, errors.New("HTTP 429"))
	class, definitelyNotAccepted, retryAfter := SubmissionFailureDetails(err)
	if class != SubmissionRateLimited || !definitelyNotAccepted || retryAfter != want {
		t.Fatalf("details = %q %v %v", class, definitelyNotAccepted, retryAfter)
	}
	if !errors.Is(err, ErrSubmissionRejected) {
		t.Fatal("explicit rate limit must remain a safe rejection")
	}
}

func TestSubmissionFailureNamesTheNoProviderAcceptanceInvariant(t *testing.T) {
	failure := &SubmissionFailure{DefinitelyNotAccepted: true}
	if !failure.DefinitelyNotAccepted {
		t.Fatal("failure must state that the provider definitely did not accept the submission")
	}
}
