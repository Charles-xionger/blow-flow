package queue

import (
	"blow-flow/api/internal/generation"
	"net/http"
	"testing"
	"time"
)

func TestHTTPSubmissionFailureClassifies429AndRetryAfter(t *testing.T) {
	response := &http.Response{StatusCode: http.StatusTooManyRequests, Header: http.Header{"Retry-After": []string{"420"}}}
	err := submissionHTTPError(response)
	class, certain, retryAfter := generation.SubmissionFailureDetails(err)
	if class != generation.SubmissionRateLimited || !certain || retryAfter != 7*time.Minute {
		t.Fatalf("details = %q %v %v", class, certain, retryAfter)
	}
}

func TestHTTPSubmissionFailureClassifiesProvider5xxAsSafeToRetry(t *testing.T) {
	err := submissionHTTPError(&http.Response{StatusCode: 503, Header: make(http.Header)})
	class, certain, _ := generation.SubmissionFailureDetails(err)
	if class != generation.SubmissionProvider5xx || !certain {
		t.Fatalf("details = %q %v", class, certain)
	}
}
