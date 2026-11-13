import type { Node, NodeProps } from '@xyflow/react';
import type { NodeData } from '@/types';
import { canvasExperimentDisabled } from './performance-experiment';

/** xyflow moves the outer node wrapper. Our content uses selection/drag state,
 * but never absolute position; preserve every other prop's normal memo semantics. */
export function nodeContentEqual(before: NodeProps<Node<NodeData>>, after: NodeProps<Node<NodeData>>) {
  const ignorePosition = !canvasExperimentDisabled('subscriptions');
  const keys = Object.keys(after) as (keyof typeof after)[];
  return Object.keys(before).length === keys.length && keys.every(key =>
    (ignorePosition && (key === 'positionAbsoluteX' || key === 'positionAbsoluteY'))
    || Object.is(before[key], after[key]));
}
