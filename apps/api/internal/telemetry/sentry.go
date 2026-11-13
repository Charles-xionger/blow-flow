package telemetry

import (
	"github.com/getsentry/sentry-go"
)

// Export only error classification and stack frames. Request bodies, prompts,
// cookies, query strings and arbitrary error text are not telemetry.
func Scrub(event *sentry.Event, _ *sentry.EventHint) *sentry.Event {
	event.Request = nil
	event.User = sentry.User{}
	event.Breadcrumbs = nil
	event.Extra = nil
	event.Contexts = nil
	event.Message = ""
	for i := range event.Exception {
		event.Exception[i].Value = "[redacted]"
	}
	tags := map[string]string{}
	for _, key := range []string{"request_id", "service"} {
		if value, ok := event.Tags[key]; ok {
			tags[key] = value
		}
	}
	event.Tags = tags
	return event
}

func Init(dsn, environment, release string) error {
	return sentry.Init(sentry.ClientOptions{
		Dsn: dsn, Environment: environment, Release: release, SendDefaultPII: false,
		EnableTracing: false, BeforeSend: Scrub,
	})
}
