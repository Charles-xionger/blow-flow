package postgres

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestRequestedDeletionRequiresExactCommand(t *testing.T) {
	if got := requestedDeletion("请删除节点 alpha、beta"); !reflect.DeepEqual(got, []string{"alpha", "beta"}) {
		t.Fatalf("Chinese command: %v", got)
	}
	if got := requestedDeletion("delete nodes alpha, beta"); !reflect.DeepEqual(got, []string{"alpha", "beta"}) {
		t.Fatalf("English command: %v", got)
	}
	if got := requestedDeletion("I might delete nodes alpha later"); got != nil {
		t.Fatalf("incidental mention granted deletion: %v", got)
	}
}

func TestCanvasValidationSkipsAlreadyDeletedTarget(t *testing.T) {
	canvas := json.RawMessage(`{"name":"Canvas","nodes":[],"edges":[],"viewport":{"x":0,"y":0,"zoom":1},"history":{"schema":1}}`)
	created, consumed, err := validateCanvasEdit(canvas, canvas, json.RawMessage(`[{"kind":"delete","id":"missing"}]`), nil, nil)
	if err != nil || len(created) != 0 || len(consumed) != 0 {
		t.Fatalf("deleted target should be a no-op: %v %v %v", created, consumed, err)
	}
}
