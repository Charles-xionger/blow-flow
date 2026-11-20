package skill

import "testing"

func TestSkillNamesAndPathsRejectReservedOrEscapingValues(t *testing.T) {
	for _, name := range []string{"", "UPPER", "two--hyphens", "dot.name"} {
		if ValidName(name) {
			t.Fatalf("accepted name %q", name)
		}
	}
	for _, path := range []string{"", "../secret", "nested/../../secret", "/absolute", "nested\\evil", "nested//evil"} {
		if ValidResourcePath(path) {
			t.Fatalf("accepted path %q", path)
		}
	}
	if !ValidName("my-skill") || !ValidResourcePath("assets/icon.png") {
		t.Fatal("valid upload rejected")
	}
	if ValidImport("screenplay", "description", "body") {
		t.Fatal("built-in collision accepted")
	}
}
