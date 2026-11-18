package progress

import (
	"context"
	"github.com/redis/go-redis/v9"
	"time"
)

// Redis carries task identifiers only. PostgreSQL remains the source of task state.
type Redis struct{ Client *redis.Client }

func Dial(raw string) (*Redis, error) {
	opts, err := redis.ParseURL(raw)
	if err != nil {
		return nil, err
	}
	return &Redis{Client: redis.NewClient(opts)}, nil
}
func (r *Redis) Close() error { return r.Client.Close() }
func (r *Redis) Publish(ctx context.Context, id string) {
	if r == nil {
		return
	}
	bounded, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_ = r.Client.Publish(bounded, "generation:task:"+id, id).Err()
}
func (r *Redis) Subscribe(ctx context.Context, id string) (<-chan string, func(), error) {
	if r == nil {
		return nil, func() {}, nil
	}
	sub := r.Client.Subscribe(ctx, "generation:task:"+id)
	ready, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	if _, err := sub.Receive(ready); err != nil {
		_ = sub.Close()
		return nil, func() {}, err
	}
	messages := sub.Channel(redis.WithChannelSize(1))
	out := make(chan string, 1)
	done := make(chan struct{})
	go func() {
		defer close(out)
		for {
			select {
			case <-done:
				return
			case msg, ok := <-messages:
				if !ok {
					return
				}
				select {
				case out <- msg.Payload:
				default:
				}
			}
		}
	}()
	return out, func() { close(done); _ = sub.Close() }, nil
}
