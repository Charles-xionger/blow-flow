package postgres

import (
	"strings"
	"testing"
)

func TestScriptInputMatchesSavedCanvasReferencesAndOrder(t *testing.T) {
	snapshot := []byte(`{"name":"Project","nodes":[{"id":"text","type":"text","data":{"type":"text","customTitle":"背景","prompt":[{"text":"夜晚"}]}},{"id":"image","type":"image","data":{"type":"image","label":"参考图","imageSrc":"https://example.com/owned.png"}},{"id":"script","type":"script","data":{"type":"script","prompt":[{"text":"写场景："},{"ref":"text"}]}}],"edges":[{"source":"text","target":"script"},{"source":"image","target":"script"}],"viewport":{"x":0,"y":0,"zoom":1}}`)
	refs := []ScriptReference{{NodeID: "text", Label: "背景", Type: "text", Content: "夜晚"}, {NodeID: "image", Label: "参考图", Type: "image", Content: "https://example.com/owned.png"}}
	canvas := ScriptCanvas{}
	if err := canvas.ValidateSource(snapshot, "script", "写场景：夜晚", refs); err != nil {
		t.Fatal(err)
	}
	wrong := append([]ScriptReference(nil), refs...)
	wrong[0].Content = "unsaved"
	if canvas.ValidateSource(snapshot, "script", "写场景：夜晚", wrong) == nil {
		t.Fatal("unsaved reference accepted")
	}
	wrong = append([]ScriptReference(nil), refs...)
	wrong[0], wrong[1] = wrong[1], wrong[0]
	if canvas.ValidateSource(snapshot, "script", "写场景：夜晚", wrong) == nil {
		t.Fatal("reordered references accepted")
	}
	if canvas.ValidateSource(snapshot, "script", "unsaved requirements", refs) == nil {
		t.Fatal("unsaved prompt accepted")
	}
}
func TestScriptCanvasPreservesLargeNumericNodeFields(t *testing.T) {
	g, err := parseScriptGraph([]byte(`{"name":"P","nodes":[{"id":"n","data":{"seed":9007199254740993}}],"edges":[],"viewport":{"x":0,"y":0,"zoom":1}}`))
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := g.bytes()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), "9007199254740993") {
		t.Fatalf("large seed changed: %s", encoded)
	}
}
