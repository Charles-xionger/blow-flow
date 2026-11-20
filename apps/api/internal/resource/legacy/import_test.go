package legacy

import (
	"strings"
	"testing"
)

func TestProjectOSSLinksOnlyIndexesTrustedMedia(t *testing.T) {
	link := "https://bucket.oss-cn-hangzhou.aliyuncs.com/images/a.png?token=temporary"
	links := projectOSSLinks(map[string]any{"nodes": []any{map[string]any{"url": link, "preview": link}, map[string]any{"url": "https://other.example/a.png"}, map[string]any{"url": "https://bucket.oss-cn-hangzhou.aliyuncs.com/readme.txt"}}}, "bucket.oss-cn-hangzhou.aliyuncs.com")
	if len(links) != 1 || links[0].Kind != "image" || links[0].ObjectKey != "images/a.png" || strings.Contains(links[0].URL, "token=") {
		t.Fatalf("links=%+v", links)
	}
}

func TestPersonalSkillImportPreflightRejectsOwnerAndResourceCorruption(t *testing.T) {
	skill := UserSkill{OwnerID: "local-user-v1", Name: "draft-helper", Description: "Drafts scenes", Instructions: "Do the work", CreatedAt: 1000}
	valid := Export{SchemaVersion: 1, UserSkills: []UserSkill{skill}, UserSkillResources: []UserSkillResource{{OwnerID: "local-user-v1", SkillName: "draft-helper", Path: "assets/icon.bin", ContentBase64: "AP8="}}}
	if err := valid.Validate(); err != nil {
		t.Fatal(err)
	}
	cases := []Export{
		{SchemaVersion: 1, UserSkills: []UserSkill{{OwnerID: "another-user", Name: "draft-helper", Description: "Drafts", Instructions: "Body", CreatedAt: 1000}}},
		{SchemaVersion: 1, UserSkills: []UserSkill{skill, skill}},
		{SchemaVersion: 1, UserSkills: []UserSkill{skill}, UserSkillResources: []UserSkillResource{{SkillName: "missing", Path: "a", ContentBase64: "AA=="}}},
		{SchemaVersion: 1, UserSkills: []UserSkill{skill}, UserSkillResources: []UserSkillResource{{SkillName: "draft-helper", Path: "../escape", ContentBase64: "AA=="}}},
		{SchemaVersion: 1, UserSkills: []UserSkill{skill}, UserSkillResources: []UserSkillResource{{SkillName: "draft-helper", Path: "a", ContentBase64: "invalid"}}},
	}
	for i, input := range cases {
		if err := input.Validate(); err == nil {
			t.Fatalf("case %d accepted", i)
		}
	}
}
