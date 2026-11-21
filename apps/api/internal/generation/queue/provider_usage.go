package queue

import (
	"blow-flow/api/internal/generation"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

func usageFields(raw json.RawMessage, keys ...string) map[string]json.RawMessage {
	var payload map[string]json.RawMessage
	if json.Unmarshal(raw, &payload) != nil {
		return nil
	}
	fields := make(map[string]json.RawMessage)
	for _, key := range keys {
		value := payload[key]
		if len(value) != 0 && len(value) <= 64 && (value[0] == '"' || value[0] >= '0' && value[0] <= '9' || string(value) == "null") {
			fields[key] = value
		}
	}
	return fields
}

func runningHubUsage(raw json.RawMessage) *generation.ProviderUsage {
	fields := usageFields(raw, "consumeCoins", "consumeMoney", "thirdPartyConsumeMoney", "settleMode", "chargedPoint", "taskCostTime")
	if len(fields) == 0 {
		return nil
	}
	return &generation.ProviderUsage{Fields: fields, Source: "runninghub_outputs", CollectedAt: time.Now().UTC()}
}

func seedreamUsage(model string, raw json.RawMessage, outputSize string, outputs int, noInputs bool) *generation.ProviderUsage {
	fields := usageFields(raw, "input_images", "generated_images", "output_tokens", "total_tokens")
	if len(fields) == 0 {
		return nil
	}
	usage := &generation.ProviderUsage{Fields: fields, Source: "ark_image_generation", CollectedAt: time.Now().UTC()}
	inputs, hasInputs := imageCount(fields["input_images"], 10)
	generated, hasGenerated := imageCount(fields["generated_images"], 1)
	if !hasGenerated || generated != outputs || (!hasInputs && !noInputs) {
		return usage
	}
	var pixels int
	if generated == 1 {
		width, height, ok := strings.Cut(outputSize, "x")
		w, wErr := strconv.Atoi(width)
		h, hErr := strconv.Atoi(height)
		if !ok || wErr != nil || hErr != nil || w <= 0 || h <= 0 || w > 8192 || h > 8192 {
			return usage
		}
		pixels = w * h
		usage.Fields["output_size"], _ = json.Marshal(outputSize)
	}

	// Ark's published pay-as-you-go tariff for single-image generation.
	// Money is calculated in fen, then persisted as decimal CNY.
	var inputFen, outputFen int
	switch model {
	case generation.Seedream55Model:
		inputFen, outputFen = inputs*5, 13
		if pixels > 4630000 {
			return usage
		}
		if pixels > 2610000 {
			outputFen = 23
		}
	case generation.Seedream50Model:
		inputFen, outputFen = max(inputs-1, 0)*2, 30
		if pixels > 2610000 {
			outputFen = 60
		}
	default:
		return usage
	}
	fen := inputFen + generated*outputFen
	usage.Amount = fmt.Sprintf("%d.%02d", fen/100, fen%100)
	usage.Currency = "CNY"
	usage.PriceSource = "https://docs.volcengine.com/docs/ark/model-pricing?lang=zh"
	return usage
}

func imageCount(value json.RawMessage, maxCount int) (int, bool) {
	count, err := strconv.Atoi(string(value))
	return count, err == nil && count >= 0 && count <= maxCount
}
