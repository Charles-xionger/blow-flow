package generation

import (
	"errors"
	"fmt"
	"time"
)

type SubmissionFailureClass string

const (
	SubmissionNonCounting SubmissionFailureClass = "non_counting"
	SubmissionConnection  SubmissionFailureClass = "connection"
	SubmissionTimeout     SubmissionFailureClass = "timeout"
	SubmissionRateLimited SubmissionFailureClass = "rate_limited"
	SubmissionProvider5xx SubmissionFailureClass = "provider_5xx"
)

type SubmissionFailure struct {
	Class                 SubmissionFailureClass
	DefinitelyNotAccepted bool
	RetryAfter            time.Duration
	Cause                 error
}

func (e *SubmissionFailure) Error() string { return fmt.Sprintf("submission %s: %v", e.Class, e.Cause) }
func (e *SubmissionFailure) Unwrap() error {
	if e.DefinitelyNotAccepted {
		return errors.Join(ErrSubmissionRejected, e.Cause)
	}
	return e.Cause
}
func NewSubmissionFailure(class SubmissionFailureClass, definitelyNotAccepted bool, retryAfter time.Duration, cause error) error {
	return &SubmissionFailure{Class: class, DefinitelyNotAccepted: definitelyNotAccepted, RetryAfter: retryAfter, Cause: cause}
}
func SubmissionFailureDetails(err error) (SubmissionFailureClass, bool, time.Duration) {
	var failure *SubmissionFailure
	if errors.As(err, &failure) {
		return failure.Class, failure.DefinitelyNotAccepted, failure.RetryAfter
	}
	if err == nil || errors.Is(err, ErrInvalid) || errors.Is(err, ErrSubmissionRejected) {
		return SubmissionNonCounting, true, 0
	}
	return SubmissionConnection, false, 0
}
