package progress

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

type Redis struct{ Client *redis.Client }

func Dial(url string) (*Redis, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	return &Redis{redis.NewClient(opts)}, nil
}
func (r *Redis) Close() error { return r.Client.Close() }
func (r *Redis) Publish(_ context.Context, id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_ = r.Client.Publish(ctx, "script:task:"+id, id).Err()
}
func (r *Redis) Subscribe(ctx context.Context, id string) (<-chan string, func(), error) {
	sub := r.Client.Subscribe(ctx, "script:task:"+id)
	ready, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
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
