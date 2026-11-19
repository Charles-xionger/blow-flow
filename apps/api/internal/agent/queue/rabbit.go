package queue

import (
	"context"
	"errors"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

const Name = "agent.tasks.v1"

type Rabbit struct{ Connection *amqp.Connection }

func Dial(url string) (*Rabbit, error) {
	c, err := amqp.Dial(url)
	if err != nil {
		return nil, err
	}
	return &Rabbit{Connection: c}, nil
}
func (r *Rabbit) Close() error { return r.Connection.Close() }

func (r *Rabbit) Publish(ctx context.Context, id string) error {
	ch, err := r.Connection.Channel()
	if err != nil {
		return err
	}
	defer ch.Close()
	if _, err = ch.QueueDeclare(Name, true, false, false, false, amqp.Table{"x-queue-type": "quorum"}); err != nil {
		return err
	}
	if err = ch.Confirm(false); err != nil {
		return err
	}
	confirm := ch.NotifyPublish(make(chan amqp.Confirmation, 1))
	if err = ch.PublishWithContext(ctx, "", Name, false, false, amqp.Publishing{DeliveryMode: amqp.Persistent, ContentType: "text/plain", Body: []byte(id), Timestamp: time.Now()}); err != nil {
		return err
	}
	select {
	case ack := <-confirm:
		if !ack.Ack {
			return errors.New("agent publish not confirmed")
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
