import { NodeType } from '../../types';

export const editCanvasOperationSchema = {
    oneOf: [
        { type: 'object', properties: { kind: { enum: ['create'] }, node: { type: 'object', properties: { id: { type: 'string' }, type: { enum: Object.values(NodeType) }, data: { type: 'object' }, parentId: { type: 'string' }, style: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, additionalProperties: false } }, required: ['id', 'type', 'data'], additionalProperties: false } }, required: ['kind', 'node'], additionalProperties: false },
        { type: 'object', properties: { kind: { enum: ['update'] }, id: { type: 'string' }, data: { type: 'object', description: 'Editable node fields: label, customTitle, type, prompt (text or [{text},{ref}]), model, generationWidth/Height/SizePreset, imageOptions (outputFormat, watermark, promptOptimization, background), aspectRatio, videoResolution/AspectRatio/Duration/InstanceType, scriptPreset, scriptInstruction. Discover model capabilities first.' } }, required: ['kind', 'id', 'data'], additionalProperties: false },
        { type: 'object', properties: { kind: { enum: ['move'] }, id: { type: 'string' }, position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false } }, required: ['kind', 'id', 'position'], additionalProperties: false },
        { type: 'object', properties: { kind: { enum: ['connect'] }, edge: { type: 'object', properties: { id: { type: 'string' }, source: { type: 'string' }, target: { type: 'string' } }, required: ['id', 'source', 'target'], additionalProperties: false } }, required: ['kind', 'edge'], additionalProperties: false },
        { type: 'object', properties: { kind: { enum: ['disconnect'] }, id: { type: 'string' } }, required: ['kind', 'id'], additionalProperties: false },
    ],
} as const;

