package postgres

import (
	"bytes"
	"encoding/json"
	"io"
	"reflect"

	"blow-flow/api/internal/agent"
)

type graph struct {
	raw   map[string]any
	nodes []map[string]any
	edges []map[string]any
}

func parseGraph(raw []byte) (graph, error) {
	var doc map[string]any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if d.Decode(&doc) != nil || doc == nil || d.Decode(new(any)) != io.EOF {
		return graph{}, agent.ErrInvalid
	}
	ns, ok := doc["nodes"].([]any)
	if !ok {
		return graph{}, agent.ErrInvalid
	}
	es, ok := doc["edges"].([]any)
	if !ok || doc["viewport"] == nil {
		return graph{}, agent.ErrInvalid
	}
	g := graph{raw: doc, nodes: make([]map[string]any, 0, len(ns)), edges: make([]map[string]any, 0, len(es))}
	for _, item := range ns {
		n, ok := item.(map[string]any)
		if !ok {
			return graph{}, agent.ErrInvalid
		}
		g.nodes = append(g.nodes, n)
	}
	for _, item := range es {
		e, ok := item.(map[string]any)
		if !ok {
			return graph{}, agent.ErrInvalid
		}
		g.edges = append(g.edges, e)
	}
	return g, nil
}
func keyed(items []map[string]any) (map[string]map[string]any, []string, error) {
	byID := make(map[string]map[string]any, len(items))
	order := make([]string, 0, len(items))
	for _, item := range items {
		id, ok := item["id"].(string)
		if !ok || id == "" || byID[id] != nil {
			return nil, nil, agent.ErrInvalid
		}
		byID[id] = item
		order = append(order, id)
	}
	return byID, order, nil
}
func stringsSet(items []string) map[string]bool {
	out := map[string]bool{}
	for _, item := range items {
		out[item] = true
	}
	return out
}
func changedKeys(before, after map[string]any) map[string]bool {
	out := map[string]bool{}
	for key, value := range before {
		if !reflect.DeepEqual(value, after[key]) {
			out[key] = true
		}
	}
	for key, value := range after {
		if !reflect.DeepEqual(value, before[key]) {
			out[key] = true
		}
	}
	return out
}
func data(node map[string]any) map[string]any {
	value, _ := node["data"].(map[string]any)
	return value
}
func idOf(value any) string { m, _ := value.(map[string]any); id, _ := m["id"].(string); return id }

// validateCanvasEdit checks the submitted diff against authorized operation IDs.
// TypeScript remains responsible for graph semantics, prompt expansion, and undo patches.
func validateCanvasEdit(beforeRaw, afterRaw, operationsRaw []byte, editableIDs, deleteGrants []string) ([]string, []string, error) {
	before, err := parseGraph(beforeRaw)
	if err != nil {
		return nil, nil, err
	}
	after, err := parseGraph(afterRaw)
	if err != nil {
		return nil, nil, err
	}
	if before.raw["name"] != after.raw["name"] || !reflect.DeepEqual(before.raw["viewport"], after.raw["viewport"]) {
		return nil, nil, agent.ErrForbidden
	}
	for key, value := range before.raw {
		if key != "nodes" && key != "edges" && key != "history" && !reflect.DeepEqual(value, after.raw[key]) {
			return nil, nil, agent.ErrForbidden
		}
	}
	for key, value := range after.raw {
		if key != "nodes" && key != "edges" && key != "history" && !reflect.DeepEqual(value, before.raw[key]) {
			return nil, nil, agent.ErrForbidden
		}
	}
	history, hasHistory := after.raw["history"].(map[string]any)
	if (before.raw["history"] != nil && !hasHistory) || (hasHistory && history["schema"] != json.Number("1")) {
		return nil, nil, agent.ErrInvalid
	}
	var operations []map[string]any
	d := json.NewDecoder(bytes.NewReader(operationsRaw))
	d.UseNumber()
	if d.Decode(&operations) != nil || len(operations) > 100 || d.Decode(new(any)) != io.EOF {
		return nil, nil, agent.ErrInvalid
	}
	creates, moves, deletes, updates, connects, disconnects := map[string]map[string]any{}, map[string]any{}, map[string]bool{}, map[string]map[string]any{}, map[string]map[string]any{}, map[string]bool{}
	for _, op := range operations {
		kind, _ := op["kind"].(string)
		id, _ := op["id"].(string)
		switch kind {
		case "create":
			node, ok := op["node"].(map[string]any)
			if !ok {
				return nil, nil, agent.ErrInvalid
			}
			id = idOf(node)
			if id == "" {
				return nil, nil, agent.ErrInvalid
			}
			if creates[id] != nil {
				return nil, nil, agent.ErrInvalid
			}
			creates[id] = node
		case "move":
			if id == "" {
				return nil, nil, agent.ErrInvalid
			}
			if op["position"] == nil {
				return nil, nil, agent.ErrInvalid
			}
			moves[id] = op["position"]
		case "update":
			if id == "" {
				return nil, nil, agent.ErrInvalid
			}
			fields, ok := op["data"].(map[string]any)
			if !ok {
				return nil, nil, agent.ErrInvalid
			}
			if updates[id] == nil {
				updates[id] = map[string]any{}
			}
			for field, value := range fields {
				updates[id][field] = value
			}
		case "delete":
			if id == "" {
				return nil, nil, agent.ErrInvalid
			}
			deletes[id] = true
		case "connect":
			edge, ok := op["edge"].(map[string]any)
			if !ok || idOf(edge) == "" {
				return nil, nil, agent.ErrInvalid
			}
			connects[idOf(edge)] = edge
		case "disconnect":
			if id == "" {
				return nil, nil, agent.ErrInvalid
			}
			disconnects[id] = true
		default:
			return nil, nil, agent.ErrInvalid
		}
	}
	oldNodes, oldOrder, err := keyed(before.nodes)
	if err != nil {
		return nil, nil, err
	}
	newNodes, newOrder, err := keyed(after.nodes)
	if err != nil {
		return nil, nil, err
	}
	allowedDelete := map[string]bool{}
	granted := stringsSet(deleteGrants)
	editable := stringsSet(editableIDs)
	consumed := []string{}
	for root := range deletes {
		if oldNodes[root] == nil {
			if granted[root] {
				consumed = append(consumed, root)
			}
			continue
		}
		if !granted[root] && !editable[root] {
			return nil, nil, agent.ErrForbidden
		}
		if granted[root] {
			consumed = append(consumed, root)
		}
		allowedDelete[root] = true
	}
	for changed := true; changed; {
		changed = false
		for id, node := range oldNodes {
			parent, _ := node["parentId"].(string)
			if allowedDelete[parent] && !allowedDelete[id] {
				allowedDelete[id] = true
				changed = true
			}
		}
	}
	created := []string{}
	for id := range newNodes {
		if oldNodes[id] == nil {
			if creates[id] == nil {
				return nil, nil, agent.ErrForbidden
			}
			// The TS planner may normalize data, but identity, placement and node type
			// must still come from the submitted create operation.
			proposed := creates[id]
			if !reflect.DeepEqual(proposed["type"], newNodes[id]["type"]) || !reflect.DeepEqual(proposed["position"], newNodes[id]["position"]) || !reflect.DeepEqual(proposed["parentId"], newNodes[id]["parentId"]) {
				return nil, nil, agent.ErrForbidden
			}
			proposedData, ok := proposed["data"].(map[string]any)
			if !ok {
				return nil, nil, agent.ErrInvalid
			}
			for field, value := range proposedData {
				if !reflect.DeepEqual(value, data(newNodes[id])[field]) {
					return nil, nil, agent.ErrForbidden
				}
			}
			created = append(created, id)
		}
	}
	for id := range creates {
		if oldNodes[id] != nil || newNodes[id] == nil {
			return nil, nil, agent.ErrForbidden
		}
	}
	for id := range oldNodes {
		if newNodes[id] == nil && !allowedDelete[id] {
			return nil, nil, agent.ErrForbidden
		}
	}
	for id := range deletes {
		if oldNodes[id] != nil && newNodes[id] != nil {
			return nil, nil, agent.ErrForbidden
		}
	}
	oldKept, newKept := []string{}, []string{}
	for _, id := range oldOrder {
		if newNodes[id] != nil {
			oldKept = append(oldKept, id)
		}
	}
	for _, id := range newOrder {
		if oldNodes[id] != nil {
			newKept = append(newKept, id)
		}
	}
	if !reflect.DeepEqual(oldKept, newKept) {
		return nil, nil, agent.ErrForbidden
	}
	for id, old := range oldNodes {
		next := newNodes[id]
		if next == nil {
			continue
		}
		changes := changedKeys(old, next)
		for field := range changes {
			switch field {
			case "position":
				if moves[id] == nil || !reflect.DeepEqual(moves[id], next["position"]) {
					return nil, nil, agent.ErrForbidden
				}
			case "data":
				oldData, newData := data(old), data(next)
				if oldData == nil || newData == nil {
					return nil, nil, agent.ErrInvalid
				}
				for name := range changedKeys(oldData, newData) {
					if name == "generationContentVersion" && editable[id] {
						continue
					}
					declared, present := updates[id][name]
					if !editable[id] || !present || !reflect.DeepEqual(declared, newData[name]) {
						return nil, nil, agent.ErrForbidden
					}
				}
			case "type":
				declared, present := updates[id]["type"]
				if !editable[id] || !present || !reflect.DeepEqual(declared, next["type"]) {
					return nil, nil, agent.ErrForbidden
				}
			default:
				return nil, nil, agent.ErrForbidden
			}
		}
	}
	oldEdges, _, err := keyed(before.edges)
	if err != nil {
		return nil, nil, err
	}
	newEdges, _, err := keyed(after.edges)
	if err != nil {
		return nil, nil, err
	}
	for id, edge := range newEdges {
		if oldEdges[id] == nil {
			if !reflect.DeepEqual(edge, connects[id]) {
				return nil, nil, agent.ErrForbidden
			}
		} else if !reflect.DeepEqual(edge, oldEdges[id]) {
			return nil, nil, agent.ErrForbidden
		}
	}
	for id, edge := range oldEdges {
		if newEdges[id] == nil && !disconnects[id] && !allowedDelete[idOfSource(edge)] && !allowedDelete[idOfTarget(edge)] && updates[idOfSource(edge)] == nil && updates[idOfTarget(edge)] == nil {
			return nil, nil, agent.ErrForbidden
		}
	}
	return created, consumed, nil
}
func idOfSource(edge map[string]any) string { id, _ := edge["source"].(string); return id }
func idOfTarget(edge map[string]any) string { id, _ := edge["target"].(string); return id }
