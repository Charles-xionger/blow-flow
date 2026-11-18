package script

import (
	"regexp"
	"strconv"
	"strings"
)

var boardHeading = regexp.MustCompile(`(?m)^## 镜头 [0-9]+[^\r\n]*$`)
var boardDuration = regexp.MustCompile(`(?m)^时长[：:]\s*([0-9]+(?:\.[0-9]+)?)\s*(?:秒|s)?\s*$`)

func ValidateBoard(text string, limits Limits) error {
	indices := boardHeading.FindAllStringIndex(text, -1)
	if len(indices) == 0 || len(indices) > limits.MaxShots {
		return ErrWorkflow
	}
	total := 0.0
	for i, span := range indices {
		end := len(text)
		if i+1 < len(indices) {
			end = indices[i+1][0]
		}
		block := text[span[1]:end]
		match := boardDuration.FindStringSubmatch(strings.TrimSpace(block))
		if len(match) != 2 {
			return ErrWorkflow
		}
		duration, err := strconv.ParseFloat(match[1], 64)
		if err != nil || duration <= 0 || duration > 15 {
			return ErrWorkflow
		}
		total += duration
	}
	if total < float64(limits.Duration)-0.1 || total > float64(limits.Duration)+0.1 {
		return ErrWorkflow
	}
	return nil
}
