package postgres

import (
	"blow-flow/api/internal/resource"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"gorm.io/gorm"
)

// ScriptCanvas owns the internal canvas mutations that accompany script tasks.
// Callers pass their existing transaction so task and canvas changes commit together.
type ScriptCanvas struct{}
type ScriptReference struct{ NodeID, Label, Type, Content string }
type ScriptOutput struct {
	Preset, Mode, SourceID, TaskID string
	Storyboard                     any
}
type scriptGraph struct {
	raw   map[string]any
	nodes []map[string]any
	edges []map[string]any
}

func parseScriptGraph(raw []byte) (scriptGraph, error) {
	var doc map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&doc) != nil || doc == nil {
		return scriptGraph{}, resource.ErrConflict
	}
	ns, ok := doc["nodes"].([]any)
	if !ok {
		return scriptGraph{}, resource.ErrConflict
	}
	es, ok := doc["edges"].([]any)
	if !ok || doc["viewport"] == nil {
		return scriptGraph{}, resource.ErrConflict
	}
	g := scriptGraph{raw: doc, nodes: make([]map[string]any, 0, len(ns)), edges: make([]map[string]any, 0, len(es))}
	for _, item := range ns {
		n, ok := item.(map[string]any)
		if !ok {
			return scriptGraph{}, resource.ErrConflict
		}
		g.nodes = append(g.nodes, n)
	}
	for _, item := range es {
		e, ok := item.(map[string]any)
		if !ok {
			return scriptGraph{}, resource.ErrConflict
		}
		g.edges = append(g.edges, e)
	}
	return g, nil
}
func scriptNumber(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case json.Number:
		f, _ := n.Float64()
		return f
	}
	return 0
}
func (g scriptGraph) bytes() ([]byte, error) {
	g.raw["nodes"] = g.nodes
	g.raw["edges"] = g.edges
	return json.Marshal(g.raw)
}
func (g scriptGraph) node(id string) map[string]any {
	for _, n := range g.nodes {
		if n["id"] == id {
			return n
		}
	}
	return nil
}
func scriptData(n map[string]any) map[string]any { d, _ := n["data"].(map[string]any); return d }
func scriptTitle(d map[string]any) string {
	if v, _ := d["customTitle"].(string); v != "" {
		return v
	}
	if d["type"] == "text" {
		return "文本描述"
	}
	v, _ := d["label"].(string)
	return v
}
func scriptImages(d map[string]any) []string {
	if character, ok := d["characterData"].(map[string]any); ok {
		if refs, ok := character["referenceImages"].([]any); ok && len(refs) > 0 {
			images := []string{}
			for _, r := range refs {
				if v, ok := r.(string); ok {
					images = append(images, v)
				}
			}
			return images
		}
	}
	if image, ok := d["imageSrc"].(string); ok && image != "" {
		return []string{image}
	}
	return nil
}
func (g scriptGraph) sources(id string) []map[string]any {
	out := []map[string]any{}
	for _, e := range g.edges {
		if e["target"] == id {
			if n := g.node(fmt.Sprint(e["source"])); n != nil {
				out = append(out, n)
			}
		}
	}
	return out
}
func (g scriptGraph) expand(id string, ancestors []string) string {
	path := append(append([]string{}, ancestors...), id)
	n := g.node(id)
	if n == nil {
		return ""
	}
	prompt := scriptData(n)["prompt"]
	segments := []any{}
	if s, ok := prompt.(string); ok {
		segments = append(segments, map[string]any{"text": s})
	} else if list, ok := prompt.([]any); ok {
		segments = list
	}
	var out strings.Builder
	for _, raw := range segments {
		segment, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if text, ok := segment["text"].(string); ok {
			out.WriteString(text)
			continue
		}
		ref, _ := segment["ref"].(string)
		var source map[string]any
		images := 0
		for _, candidate := range g.sources(id) {
			d := scriptData(candidate)
			if d["type"] != "text" {
				images += len(scriptImages(d))
			}
			if candidate["id"] == ref {
				source = candidate
				break
			}
		}
		if source == nil {
			continue
		}
		d := scriptData(source)
		if d["type"] != "text" {
			if len(scriptImages(d)) > 0 {
				out.WriteString(fmt.Sprintf("图片%d", images-len(scriptImages(d))+1))
			} else {
				out.WriteString(scriptTitle(d))
			}
			continue
		}
		seen := false
		for _, prior := range path {
			if prior == ref {
				seen = true
				break
			}
		}
		if seen {
			out.WriteString(scriptTitle(d))
		} else {
			out.WriteString(g.expand(ref, path))
		}
	}
	return out.String()
}
func (ScriptCanvas) ValidateSource(snapshot []byte, sourceID, requirements string, refs []ScriptReference) error {
	g, err := parseScriptGraph(snapshot)
	if err != nil {
		return err
	}
	source := g.node(sourceID)
	if source == nil || source["type"] != "script" || g.expand(sourceID, nil) != requirements {
		return resource.ErrConflict
	}
	expected := []ScriptReference{}
	seen := map[string]bool{}
	for _, n := range g.sources(sourceID) {
		id, _ := n["id"].(string)
		if seen[id] {
			continue
		}
		seen[id] = true
		d := scriptData(n)
		label := scriptTitle(d)
		if d["type"] == "text" {
			expected = append(expected, ScriptReference{NodeID: id, Label: label, Type: "text", Content: g.expand(id, nil)})
		} else {
			if d["type"] == "script" {
				return resource.ErrConflict
			}
			for _, img := range scriptImages(d) {
				expected = append(expected, ScriptReference{NodeID: id, Label: label, Type: "image", Content: img})
			}
		}
	}
	if len(expected) != len(refs) {
		return resource.ErrConflict
	}
	for i := range refs {
		if refs[i] != expected[i] {
			return resource.ErrConflict
		}
	}
	return nil
}
func lockScriptProject(tx *gorm.DB, owner, project string) (scriptGraph, int64, bool, error) {
	var p struct {
		Snapshot            []byte
		Version             int64
		DeletedAt, PurgedAt *time.Time
	}
	q := tx.Raw(`SELECT snapshot,version,deleted_at,purged_at FROM projects WHERE id=? AND owner_id=? FOR UPDATE`, project, owner).Scan(&p)
	if q.Error != nil {
		return scriptGraph{}, 0, false, q.Error
	}
	if q.RowsAffected == 0 {
		return scriptGraph{}, 0, false, resource.ErrNotFound
	}
	if p.DeletedAt != nil || p.PurgedAt != nil {
		return scriptGraph{}, 0, false, nil
	}
	g, err := parseScriptGraph(p.Snapshot)
	return g, p.Version, true, err
}
func newScriptID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}
func scriptOutputNode(source map[string]any, nodes []map[string]any, id string, meta ScriptOutput) map[string]any {
	position, _ := source["position"].(map[string]any)
	x, y := 0.0, 0.0
	if position != nil {
		x = scriptNumber(position["x"])
		y = scriptNumber(position["y"])
	}
	width := 320.0
	if size, ok := scriptData(source)["displaySize"].(map[string]any); ok {
		if v := scriptNumber(size["width"]); v > 0 {
			width = v
		}
	}
	targetX := x + width + 100
	for {
		moved := false
		for _, other := range nodes {
			if other["parentId"] != source["parentId"] {
				continue
			}
			p, ok := other["position"].(map[string]any)
			if !ok {
				continue
			}
			ox := scriptNumber(p["x"])
			oy := scriptNumber(p["y"])
			ow, oh := 320.0, 240.0
			if size, ok := scriptData(other)["displaySize"].(map[string]any); ok {
				if v := scriptNumber(size["width"]); v > 0 {
					ow = v
				}
				if v := scriptNumber(size["height"]); v > 0 {
					oh = v
				}
			}
			if ox < targetX+360 && ox+ow+40 > targetX && oy < y+300 && oy+oh+60 > y {
				y = oy + oh + 60
				moved = true
			}
		}
		if !moved {
			break
		}
	}
	title := map[string]string{"free": "创意文本", "screenplay": "剧本", "storyboard": "分镜文稿", "extract": "角色／场景／道具"}[meta.Preset]
	if title == "" {
		title = "生成文本"
	}
	if meta.Mode == "board" {
		title = "分镜"
	}
	purpose := map[string]string{"free": "idea", "screenplay": "script", "storyboard": "storyboard", "extract": "material"}[meta.Preset]
	if purpose == "" {
		purpose = "idea"
	}
	d := map[string]any{"type": "text", "label": "文本", "customTitle": title, "prompt": []any{}, "textPurpose": purpose, "scriptOutputTaskId": meta.TaskID, "scriptOutputSource": source["id"]}
	if meta.Mode == "board" && meta.Storyboard != nil {
		d["storyboard"] = meta.Storyboard
	}
	out := map[string]any{"id": id, "type": "text", "position": map[string]any{"x": targetX, "y": y}, "data": d}
	if parent, ok := source["parentId"]; ok {
		out["parentId"] = parent
	}
	return out
}
func (ScriptCanvas) InsertOutput(tx *gorm.DB, owner, project string, meta ScriptOutput) (string, error) {
	g, version, active, err := lockScriptProject(tx, owner, project)
	if err != nil {
		return "", err
	}
	if !active {
		return "", resource.ErrDeleted
	}
	source := g.node(meta.SourceID)
	if source == nil || source["type"] != "script" {
		return "", resource.ErrConflict
	}
	id, err := newScriptID()
	if err != nil {
		return "", err
	}
	g.nodes = append(g.nodes, scriptOutputNode(source, g.nodes, id, meta))
	g.edges = append(g.edges, map[string]any{"id": "script-output-edge:" + meta.TaskID, "source": meta.SourceID, "target": id})
	updated, err := g.bytes()
	if err != nil {
		return "", err
	}
	if err := tx.Exec(`UPDATE projects SET snapshot=?::jsonb,version=version+1,node_count=?,updated_at=now() WHERE id=?`, string(updated), len(g.nodes), project).Error; err != nil {
		return "", err
	}
	digest := sha256.Sum256(updated)
	if err := tx.Exec(`INSERT INTO project_save_receipts(project_id,request_id,digest,version) VALUES(?,?,?,?)`, project, "script-output:"+meta.TaskID, hex.EncodeToString(digest[:]), version+1).Error; err != nil {
		return "", err
	}
	return id, nil
}
func (ScriptCanvas) SaveOutput(tx *gorm.DB, owner, project, outputID, taskID, text string) error {
	if text == "" {
		return nil
	}
	g, version, active, err := lockScriptProject(tx, owner, project)
	if err != nil {
		return err
	}
	if !active {
		return nil
	}
	var prior int64
	if err := tx.Raw(`SELECT count(*) FROM project_save_receipts WHERE project_id=? AND request_id=?`, project, "script-output-finish:"+taskID).Scan(&prior).Error; err != nil {
		return err
	}
	if prior > 0 {
		return nil
	}
	target := g.node(outputID)
	if target == nil {
		return nil
	}
	d := scriptData(target)
	if d["scriptOutputTaskId"] != taskID {
		return nil
	}
	prompt, ok := d["prompt"].([]any)
	if !ok || len(prompt) > 0 {
		return nil
	}
	d["prompt"] = []any{map[string]string{"text": text}}
	updated, err := g.bytes()
	if err != nil {
		return err
	}
	if err := tx.Exec(`UPDATE projects SET snapshot=?::jsonb,version=version+1,updated_at=now() WHERE id=?`, string(updated), project).Error; err != nil {
		return err
	}
	digest := sha256.Sum256([]byte(text))
	return tx.Exec(`INSERT INTO project_save_receipts(project_id,request_id,digest,version) VALUES(?,?,?,?)`, project, "script-output-finish:"+taskID, hex.EncodeToString(digest[:]), version+1).Error
}
