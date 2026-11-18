package queue

import (
	"context"
	"errors"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

const Name = "script.tasks.v1"

type Rabbit struct{ Connection *amqp.Connection }

func Dial(url string) (*Rabbit, error) {
	c, e := amqp.Dial(url)
	if e != nil {
		return nil, e
	}
	return &Rabbit{c}, nil
}
func (r *Rabbit) Close() error { return r.Connection.Close() }
func declare(ch *amqp.Channel) error {
	_, e := ch.QueueDeclare(Name, true, false, false, false, amqp.Table{"x-queue-type": "quorum"})
	return e
}
func (r *Rabbit) Publish(ctx context.Context, id string) error {
	ch, e := r.Connection.Channel()
	if e != nil {
		return e
	}
	defer ch.Close()
	if e = declare(ch); e != nil {
		return e
	}
	if e = ch.Confirm(false); e != nil {
		return e
	}
	confirms := ch.NotifyPublish(make(chan amqp.Confirmation, 1))
	if e = ch.PublishWithContext(ctx, "", Name, false, false, amqp.Publishing{DeliveryMode: amqp.Persistent, ContentType: "text/plain", Body: []byte(id), Timestamp: time.Now()}); e != nil {
		return e
	}
	select {
	case result := <-confirms:
		if !result.Ack {
			return errors.New("script publish not confirmed")
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (r *Rabbit) Consume(ctx context.Context, process func(context.Context, string) error) error {
	ch, e := r.Connection.Channel()
	if e != nil {
		return e
	}
	defer ch.Close()
	if e = declare(ch); e != nil {
		return e
	}
	if e = ch.Qos(1, 0, false); e != nil {
		return e
	}
	messages, e := ch.Consume(Name, "", false, false, false, false, nil)
	if e != nil {
		return e
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case msg, ok := <-messages:
			if !ok {
				return errors.New("script deliveries closed")
			}
			if e := process(ctx, string(msg.Body)); e != nil {
				_ = msg.Nack(false, true)
				return e
			}
			if e := msg.Ack(false); e != nil {
				return e
			}
		}
	}
}
