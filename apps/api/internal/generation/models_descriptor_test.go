package generation

import "testing"

func TestBuiltInModelCapabilitiesStayConsistentAcrossPublicLookups(t *testing.T) {
	for _, row := range []struct{ model, category, connection string }{
		{Krea2Model, "IMAGE", "runninghub-international"},
		{H3Model, "VIDEO", "runninghub-international"},
		{Seedream55Model, "IMAGE", "volcengine-ark"},
		{Seedream50Model, "IMAGE", "volcengine-ark"},
		{GeminiImageModel, "IMAGE", "gemini-images"},
	} {
		if got := ModelCategory(row.model); got != row.category {
			t.Errorf("%s category=%s", row.model, got)
		}
		if got := ConnectionForModel(row.model); got != row.connection {
			t.Errorf("%s connection=%s", row.model, got)
		}
	}
	if got := CategoryForInput(Input{Model: H3Model}); got != "VIDEO" {
		t.Fatalf("H3 frozen category=%s", got)
	}
	if got := CategoryForInput(Input{Model: "custom/video", Workflow: &WorkflowSnapshot{Category: "VIDEO"}}); got != "VIDEO" {
		t.Fatalf("workflow frozen category=%s", got)
	}
}
