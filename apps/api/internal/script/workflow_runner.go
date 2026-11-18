package script

import (
	"blow-flow/api/internal/textmodel"
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

func (w Worker) runWorkflow(ctx context.Context, claim *Claimed, images []string) error {
	var state Workflow
	if json.Unmarshal(claim.Task.Workflow, &state) != nil || state.Version != 1 {
		return ErrWorkflow
	}
	in := claim.Task.Input
	if in.Storyboard == nil {
		return ErrWorkflow
	}
	persist := func(allowStopping bool) error {
		ok, err := w.Store.UpdateWorkflow(ctx, claim.Task.ID, claim.Lease, state, allowStopping)
		if err != nil {
			return err
		}
		if !ok {
			return context.Canceled
		}
		return nil
	}
	step := func(key, prompt string, useImages bool, commit func(string) error) error {
		current := state.Step(key)
		if current == nil {
			return ErrWorkflow
		}
		if current.Status == "completed" {
			return nil
		}
		startStep(current)
		if err := persist(false); err != nil {
			return err
		}
		stepCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
		defer cancel()
		lastSaved := time.Now()
		var raw strings.Builder
		selected := []string{}
		if useImages {
			selected = images
		}
		err := w.Model.Stream(stepCtx, textmodel.Request{Model: in.Model, Prompt: prompt, Images: selected, JSON: true}, func(delta string) error {
			if raw.Len()+len(delta) > 200_000 {
				return ErrWorkflow
			}
			raw.WriteString(delta)
			current.Draft = raw.String()
			current.Phase = "writing"
			if time.Since(lastSaved) >= 500*time.Millisecond {
				if err := persist(false); err != nil {
					return err
				}
				lastSaved = time.Now()
			}
			return nil
		})
		if err == nil {
			err = commit(raw.String())
		}
		if err != nil {
			current.Draft = raw.String()
			if ctx.Err() != nil {
				current.Status = "pending"
			} else {
				failStep(current, "步骤失败，草稿与已完成阶段已保留，可继续")
			}
			if ctx.Err() != nil {
				saveCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				_, _ = w.Store.UpdateWorkflow(saveCtx, claim.Task.ID, claim.Lease, state, true)
				cancel()
			} else {
				_ = persist(true)
			}
			return err
		}
		current = state.Step(key)
		current.Draft = raw.String()
		completeStep(current)
		return persist(false)
	}
	if err := step("plan", planPrompt(in), true, func(raw string) error {
		plan, err := ParsePlan(raw, *in.Storyboard)
		if err != nil {
			return err
		}
		state.Plan = &plan
		if len(state.Steps) == 3 {
			batches := []WorkflowStep{}
			for offset := 0; offset < len(plan.Shots); offset += 2 {
				end := min(offset+2, len(plan.Shots))
				ids := []string{}
				for _, shot := range plan.Shots[offset:end] {
					ids = append(ids, shot.ID)
				}
				batches = append(batches, WorkflowStep{Key: fmt.Sprintf("details-%d", offset/2), Label: fmt.Sprintf("完善镜头 %d–%d", offset+1, end), Status: "pending", ShotIDs: ids})
			}
			next := make([]WorkflowStep, 0, 3+len(batches))
			next = append(next, state.Steps[:2]...)
			next = append(next, batches...)
			next = append(next, state.Steps[2:]...)
			state.Steps = next
		}
		return nil
	}); err != nil {
		return err
	}
	if state.Plan == nil {
		return ErrWorkflow
	}
	if err := step("assets", assetsPrompt(in, *state.Plan), true, func(raw string) error {
		assets, err := ParseAssets(raw, *state.Plan)
		if err != nil {
			return err
		}
		state.Assets = assets
		return nil
	}); err != nil {
		return err
	}
	for _, stage := range state.Steps {
		if !strings.HasPrefix(stage.Key, "details-") {
			continue
		}
		shots := []PlannedShot{}
		for _, shot := range state.Plan.Shots {
			for _, id := range stage.ShotIDs {
				if shot.ID == id {
					shots = append(shots, shot)
				}
			}
		}
		if len(shots) == 0 {
			return ErrWorkflow
		}
		err := step(stage.Key, detailsPrompt(in, *state.Plan, state.Assets, shots), false, func(raw string) error {
			details, err := ParseDetails(raw, shots)
			if err != nil {
				return err
			}
			for _, d := range details {
				state.Details[d.ID] = d
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	prompts, err := AssemblePrompts(state)
	if err != nil {
		return err
	}
	state.Prompts = prompts
	final := state.Step("prompts")
	if final == nil {
		return ErrWorkflow
	}
	startStep(final)
	completeStep(final)
	return persist(false)
}
func planPrompt(in Input) string {
	limits := *in.Storyboard
	refs := []string{}
	for _, r := range in.References {
		if r.Type == "text" {
			refs = append(refs, r.Label+"："+r.Content)
		} else {
			refs = append(refs, "图片参考："+r.Label)
		}
	}
	return fmt.Sprintf(`原始参考：%s
用户要求：%s
创作意图：%s
本次只做短片镜头骨架规划。总时长严格为 %d 秒，最多 %d 镜，每镜 1–15 秒整数，时长相加必须等于总时长。合并同场景连续动作，保留起承转合。summary 包含故事摘要与全局视觉风格，限 300 字；action 限 100 字。同一角色、场景或道具复用统一名称。
只返回合法 JSON 对象，不要 Markdown：{"summary":"摘要与视觉风格","shots":[{"title":"标题","duration":12,"action":"动作","characters":["人物"],"scene":"场景","props":["道具"]}]}`, strings.Join(refs, "\n"), in.Requirements, in.Instruction, limits.Duration, limits.MaxShots)
}
func assetsPrompt(in Input, plan ShotPlan) string {
	names, _ := json.Marshal(assetNames(plan))
	planned, _ := json.Marshal(plan)
	return fmt.Sprintf(`只为固定资产名称补充统一视觉设定，不修改故事或镜头。用户要求：%s
规划：%s
必须恰好覆盖这些名称，不得增删或重命名：%s。每个 description 限 150 字，人物写清身份外貌服装，场景写空间光线，道具写外观。只返回合法 JSON：{"characters":[{"name":"名称","description":"视觉设定"}],"scene":[],"props":[]}。无资产的类别使用空数组。`, in.Requirements, planned, names)
}
func detailsPrompt(in Input, plan ShotPlan, assets []WorkflowAsset, shots []PlannedShot) string {
	planned, _ := json.Marshal(plan)
	assetJSON, _ := json.Marshal(assets)
	batch, _ := json.Marshal(shots)
	return fmt.Sprintf(`本次只完善指定镜头，不增删镜头、不调整时长、不改变资产设定。用户要求：%s
规划：%s
资产：%s
本批镜头：%s
必须返回本批全部镜头，每镜恰好一次，id 与规划相同。每镜写画面与动作、景别、光影、对白、音效和运镜。无对白或音效填“无”。只返回合法 JSON：{"shots":[{"id":"shot-001","visual":"画面","size":"景别","lighting":"光影","dialogue":"对白","sound":"音效","camera":"运镜"}]}`, in.Requirements, planned, assetJSON, batch)
}
