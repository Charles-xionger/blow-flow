import { NodeType } from "../../types";

type ValueType = "text" | "image" | "video" | "character";
interface NodeDefinition {
  input: boolean;
  accepts: readonly ValueType[];
  outputs: readonly ValueType[];
  height: number;
}

// Port capabilities describe the data consumed by the current business components.
export const nodeDefinitions: Record<NodeType, NodeDefinition> = {
  [NodeType.TEXT]: { input: true, accepts: ["text"], outputs: ["text"], height: 240 },
  [NodeType.TEXT_TO_IMAGE]: { input: true, accepts: ["text", "character"], outputs: ["image"], height: 240 },
  [NodeType.TEXT_TO_VIDEO]: { input: true, accepts: ["text"], outputs: ["video"], height: 240 },
  [NodeType.IMAGE_TO_IMAGE]: { input: true, accepts: ["image", "character"], outputs: ["image"], height: 240 },
  [NodeType.IMAGE_TO_VIDEO]: { input: true, accepts: ["image", "character"], outputs: ["video"], height: 240 },
  [NodeType.START_END_TO_VIDEO]: { input: true, accepts: ["image", "character"], outputs: ["video"], height: 240 },
  [NodeType.SCRIPT]: { input: true, accepts: ["text", "image"], outputs: [], height: 320 },
  [NodeType.CREATIVE_DESC]: { input: false, accepts: [], outputs: ["text"], height: 200 },
  [NodeType.STORYBOARD]: { input: false, accepts: [], outputs: ["text"], height: 200 },
  [NodeType.ORIGINAL_IMAGE]: { input: false, accepts: [], outputs: ["image"], height: 240 },
  [NodeType.CHARACTER]: { input: true, accepts: ["character"], outputs: ["character", "image"], height: 240 },
  [NodeType.GROUP]: { input: false, accepts: [], outputs: [], height: 240 },
};
