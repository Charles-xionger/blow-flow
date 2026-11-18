package script

import "testing"

func TestInputValidationAndPrompt(t *testing.T) {
	in := Input{Model: "deepseek-v4-pro-ga-260813", Requirements: "写一个场景", Instruction: "直接输出", Preset: "free", References: []Reference{{NodeID: "n1", Label: "背景", Type: "text", Content: "夜晚"}}}
	if err := in.Validate(); err != nil {
		t.Fatal(err)
	}
	if got := Prompt(in); got != "直接输出\n\n参考 1「背景」:\n夜晚\n\n创作要求：\n写一个场景" {
		t.Fatalf("prompt=%q", got)
	}
	in.References = []Reference{{NodeID: "n2", Label: "img", Type: "image", Content: "https://example.com/x.png"}}
	if err := in.Validate(); err != nil {
		t.Fatal(err)
	}
	in.OutputMode = "workflow"
	in.Preset = "storyboard"
	in.Storyboard = &Limits{Duration: 60, MaxShots: 5}
	if err := in.Validate(); err != nil {
		t.Fatalf("workflow validation=%v", err)
	}
}
func TestBoardDurationValidation(t *testing.T) {
	limits := Limits{Duration: 20, MaxShots: 2}
	if err := ValidateBoard("## 镜头 001｜街口\n时长：10秒\n画面描述：走过\n\n## 镜头 002｜相遇\n时长：10秒\n", limits); err != nil {
		t.Fatal(err)
	}
	if ValidateBoard("## 镜头 001｜街口\n时长：16秒\n", limits) == nil {
		t.Fatal("overlong shot accepted")
	}
}
