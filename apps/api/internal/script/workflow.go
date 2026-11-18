package script

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

var ErrWorkflow = errors.New("invalid storyboard checkpoint")

type PlannedShot struct {
	ID         string   `json:"id"`
	Title      string   `json:"title"`
	Duration   int      `json:"duration"`
	Action     string   `json:"action"`
	Characters []string `json:"characters"`
	Scene      string   `json:"scene"`
	Props      []string `json:"props"`
}
type ShotPlan struct {
	Summary string        `json:"summary"`
	Shots   []PlannedShot `json:"shots"`
}
type WorkflowAsset struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	Description string `json:"description"`
}
type ShotDetail struct {
	ID       string `json:"id"`
	Visual   string `json:"visual"`
	Size     string `json:"size"`
	Lighting string `json:"lighting"`
	Dialogue string `json:"dialogue"`
	Sound    string `json:"sound"`
	Camera   string `json:"camera"`
}
type WorkflowStep struct {
	Key        string   `json:"key"`
	Label      string   `json:"label"`
	Status     string   `json:"status"`
	Attempts   int      `json:"attempts"`
	ShotIDs    []string `json:"shotIds,omitempty"`
	Phase      string   `json:"phase,omitempty"`
	StartedAt  int64    `json:"startedAt,omitempty"`
	FinishedAt int64    `json:"finishedAt,omitempty"`
	Draft      string   `json:"draft,omitempty"`
	Error      string   `json:"error,omitempty"`
}
type Workflow struct {
	Version int                   `json:"version"`
	Steps   []WorkflowStep        `json:"steps"`
	Plan    *ShotPlan             `json:"plan,omitempty"`
	Assets  []WorkflowAsset       `json:"assets,omitempty"`
	Details map[string]ShotDetail `json:"details"`
	Prompts map[string]string     `json:"prompts"`
}

func NewWorkflow() Workflow {
	return Workflow{Version: 1, Steps: []WorkflowStep{{Key: "plan", Label: "规划镜头", Status: "pending"}, {Key: "assets", Label: "整理资产", Status: "pending"}, {Key: "prompts", Label: "组装提示词", Status: "pending"}}, Details: map[string]ShotDetail{}, Prompts: map[string]string{}}
}
func ResetWorkflow(raw json.RawMessage) (json.RawMessage, error) {
	var w Workflow
	if err := json.Unmarshal(raw, &w); err != nil || w.Version != 1 {
		return nil, ErrWorkflow
	}
	for i := range w.Steps {
		if w.Steps[i].Status != "completed" {
			w.Steps[i].Status = "pending"
			w.Steps[i].Error = ""
			w.Steps[i].Phase = ""
		}
	}
	return json.Marshal(w)
}
func (w *Workflow) Step(key string) *WorkflowStep {
	for i := range w.Steps {
		if w.Steps[i].Key == key {
			return &w.Steps[i]
		}
	}
	return nil
}
func (w Workflow) Progress(completed bool) int {
	done := func(key string) bool { s := w.Step(key); return s != nil && s.Status == "completed" }
	total := 1
	if w.Plan != nil && len(w.Plan.Shots) > 0 {
		total = len(w.Plan.Shots)
	}
	v := 0
	if done("plan") {
		v += 20
	}
	if done("assets") {
		v += 20
	}
	v += 50 * len(w.Details) / total
	if done("prompts") {
		v += 10
	}
	if completed && done("prompts") {
		return 100
	}
	return min(99, v)
}
func (w Workflow) Text() string {
	if w.Plan == nil {
		return ""
	}
	blocks := make([]string, 0, len(w.Plan.Shots))
	for i, shot := range w.Plan.Shots {
		detail := w.Details[shot.ID]
		visual := detail.Visual
		if visual == "" {
			visual = shot.Action
		}
		parts := []string{fmt.Sprintf("## 镜头 %03d｜%s", i+1, shot.Title), fmt.Sprintf("时长：%d秒", shot.Duration), "画面描述：" + visual, "景别：" + detail.Size, "光影氛围：" + detail.Lighting, "对白旁白：" + detail.Dialogue, "音效：" + detail.Sound, "运镜：" + detail.Camera, "角色：" + orNone(strings.Join(shot.Characters, "、")), "场景：" + shot.Scene, "道具：" + orNone(strings.Join(shot.Props, "、")), "视频提示词：" + w.Prompts[shot.ID]}
		blocks = append(blocks, strings.Join(parts, "\n"))
	}
	return strings.Join(blocks, "\n\n")
}
func orNone(s string) string {
	if s == "" {
		return "无"
	}
	return s
}
func ParseStep(raw string) (map[string]json.RawMessage, error) {
	clean := strings.TrimSpace(raw)
	clean = strings.TrimPrefix(clean, "```json")
	clean = strings.TrimPrefix(clean, "```")
	clean = strings.TrimSuffix(clean, "```")
	var v map[string]json.RawMessage
	if json.Unmarshal([]byte(strings.TrimSpace(clean)), &v) != nil || v == nil {
		return nil, ErrWorkflow
	}
	return v, nil
}
func requiredText(s string, maxLen int) bool {
	return strings.TrimSpace(s) != "" && len([]rune(s)) <= maxLen
}
func names(v []string) bool {
	if len(v) > 30 {
		return false
	}
	seen := map[string]bool{}
	for _, name := range v {
		if !requiredText(name, 100) || seen[name] {
			return false
		}
		seen[name] = true
	}
	return true
}
func ParsePlan(raw string, limits Limits) (ShotPlan, error) {
	v, e := ParseStep(raw)
	if e != nil {
		return ShotPlan{}, e
	}
	var incoming struct {
		Summary string        `json:"summary"`
		Shots   []PlannedShot `json:"shots"`
	}
	if json.Unmarshal(v["summary"], &incoming.Summary) != nil || json.Unmarshal(v["shots"], &incoming.Shots) != nil || !requiredText(incoming.Summary, 4000) || len(incoming.Shots) < 1 || len(incoming.Shots) > limits.MaxShots {
		return ShotPlan{}, ErrWorkflow
	}
	total := 0
	for i := range incoming.Shots {
		s := &incoming.Shots[i]
		if s.Duration < 1 || s.Duration > 15 || !requiredText(s.Title, 100) || !requiredText(s.Action, 1200) || !requiredText(s.Scene, 100) || s.Characters == nil || s.Props == nil || !names(s.Characters) || !names(s.Props) {
			return ShotPlan{}, ErrWorkflow
		}
		s.ID = fmt.Sprintf("shot-%03d", i+1)
		total += s.Duration
	}
	if total != limits.Duration {
		return ShotPlan{}, ErrWorkflow
	}
	return ShotPlan{Summary: incoming.Summary, Shots: incoming.Shots}, nil
}
func assetNames(plan ShotPlan) map[string][]string {
	result := map[string][]string{"characters": {}, "scene": {}, "props": {}}
	add := func(kind, name string) {
		if !slices.Contains(result[kind], name) {
			result[kind] = append(result[kind], name)
		}
	}
	for _, shot := range plan.Shots {
		for _, n := range shot.Characters {
			add("characters", n)
		}
		add("scene", shot.Scene)
		for _, n := range shot.Props {
			add("props", n)
		}
	}
	return result
}
func ParseAssets(raw string, plan ShotPlan) ([]WorkflowAsset, error) {
	v, e := ParseStep(raw)
	if e != nil {
		return nil, e
	}
	expected := assetNames(plan)
	result := []WorkflowAsset{}
	for _, kind := range []string{"characters", "scene", "props"} {
		var entries []WorkflowAsset
		if json.Unmarshal(v[kind], &entries) != nil || len(entries) != len(expected[kind]) {
			return nil, ErrWorkflow
		}
		byName := map[string]string{}
		for _, entry := range entries {
			if !requiredText(entry.Name, 100) || !requiredText(entry.Description, 4000) || byName[entry.Name] != "" {
				return nil, ErrWorkflow
			}
			byName[entry.Name] = entry.Description
		}
		for i, name := range expected[kind] {
			desc := byName[name]
			if desc == "" {
				return nil, ErrWorkflow
			}
			result = append(result, WorkflowAsset{ID: fmt.Sprintf("%s-%d", kind, i+1), Kind: kind, Name: name, Description: desc})
		}
	}
	return result, nil
}
func ParseDetails(raw string, shots []PlannedShot) ([]ShotDetail, error) {
	v, e := ParseStep(raw)
	if e != nil {
		return nil, e
	}
	var details []ShotDetail
	if json.Unmarshal(v["shots"], &details) != nil || len(details) != len(shots) {
		return nil, ErrWorkflow
	}
	byID := map[string]ShotDetail{}
	for _, d := range details {
		if !requiredText(d.ID, 100) || !requiredText(d.Visual, 4000) || !requiredText(d.Size, 500) || !requiredText(d.Lighting, 4000) || !requiredText(d.Dialogue, 4000) || !requiredText(d.Sound, 4000) || !requiredText(d.Camera, 4000) || byID[d.ID].ID != "" {
			return nil, ErrWorkflow
		}
		byID[d.ID] = d
	}
	ordered := make([]ShotDetail, 0, len(shots))
	for _, shot := range shots {
		d, ok := byID[shot.ID]
		if !ok {
			return nil, ErrWorkflow
		}
		ordered = append(ordered, d)
	}
	return ordered, nil
}
func AssemblePrompts(w Workflow) (map[string]string, error) {
	if w.Plan == nil {
		return nil, ErrWorkflow
	}
	result := map[string]string{}
	for _, shot := range w.Plan.Shots {
		d, ok := w.Details[shot.ID]
		if !ok {
			return nil, ErrWorkflow
		}
		parts := []string{fmt.Sprintf("时长：%d 秒。", shot.Duration), "故事与全局视觉风格：" + w.Plan.Summary}
		for _, a := range w.Assets {
			if a.Kind == "characters" && slices.Contains(shot.Characters, a.Name) || a.Kind == "scene" && a.Name == shot.Scene || a.Kind == "props" && slices.Contains(shot.Props, a.Name) {
				parts = append(parts, a.Name+"："+a.Description)
			}
		}
		parts = append(parts, "画面："+d.Visual, "景别："+d.Size, "光影："+d.Lighting, "运镜："+d.Camera, "对白旁白："+d.Dialogue, "音效："+d.Sound)
		result[shot.ID] = strings.Join(parts, "\n")
	}
	return result, nil
}
func startStep(step *WorkflowStep) {
	step.Status = "running"
	step.Attempts++
	step.StartedAt = time.Now().UnixMilli()
	step.FinishedAt = 0
	step.Error = ""
	step.Draft = ""
	step.Phase = "connecting"
}
func failStep(step *WorkflowStep, message string) {
	step.Status = "failed"
	step.Error = message
	step.FinishedAt = time.Now().UnixMilli()
}
func completeStep(step *WorkflowStep) {
	step.Status = "completed"
	step.Error = ""
	step.FinishedAt = time.Now().UnixMilli()
	step.Phase = "writing"
}
