import { constructUrl, fetchThirdParty } from "../network";
import type { ModelConfig } from "@/types";

export async function generateFluxImage(
  config: ModelConfig,
  prompt: string,
  aspectRatio: string,
  resolution: string,
  inputImages: string[] = [],
): Promise<string> {
  const targetUrl = constructUrl(config.baseUrl, config.endpoint);

  const payload: any = {
    model: config.modelId,
    prompt,
    aspect_ratio: aspectRatio,
    size: resolution,
  };

  if (inputImages.length > 0) {
    payload.image = inputImages[0];
  }

  const res = await fetchThirdParty(targetUrl, "POST", payload, config.key);

  if (res.data?.[0]?.url) {
    return res.data[0].url;
  } else if (res.data?.[0]?.b64_json) {
    return `data:image/png;base64,${res.data[0].b64_json}`;
  }

  throw new Error("No image URL or data returned from API");
}
