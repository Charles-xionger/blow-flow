package queue

import (
	"blow-flow/api/internal/generation"
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func submissionTransportError(err error) error {
	class := generation.SubmissionConnection
	var netErr net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()) {
		class = generation.SubmissionTimeout
	}
	return generation.NewSubmissionFailure(class, false, 0, errors.Join(ErrSubmissionUncertain, err))
}

func submissionHTTPError(response *http.Response) error {
	status := response.StatusCode
	cause := fmt.Errorf("HTTP %d", status)
	if status == http.StatusTooManyRequests {
		return generation.NewSubmissionFailure(generation.SubmissionRateLimited, true, parseRetryAfter(response.Header.Get("Retry-After"), time.Now()), cause)
	}
	if status >= 500 && status <= 599 {
		return generation.NewSubmissionFailure(generation.SubmissionProvider5xx, true, 0, cause)
	}
	return generation.NewSubmissionFailure(generation.SubmissionNonCounting, true, 0, cause)
}

func parseRetryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if seconds, err := strconv.Atoi(value); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	if at, err := http.ParseTime(value); err == nil && at.After(now) {
		return at.Sub(now)
	}
	return 0
}
