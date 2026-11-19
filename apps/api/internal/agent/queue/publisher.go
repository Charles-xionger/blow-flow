package queue

import "context"

type Store interface {
	Unpublished(context.Context) ([]string, error)
	MarkPublished(context.Context, string) error
}
type Publisher interface {
	Publish(context.Context, string) error
}
type Outbox struct {
	Store Store
	Queue Publisher
}

func (o Outbox) PublishPending(ctx context.Context) error {
	ids, err := o.Store.Unpublished(ctx)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err := o.Queue.Publish(ctx, id); err != nil {
			return err
		}
		if err := o.Store.MarkPublished(ctx, id); err != nil {
			return err
		}
	}
	return nil
}
