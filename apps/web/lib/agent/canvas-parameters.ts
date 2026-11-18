import { scriptPresets } from '../script/inputs';
import { normalizeImageOptions } from '../generation/image-options';
import { NodeType, type NodeData } from '../../types';
import type { CanvasModel } from './canvas-models';
import { validGenerationDimensions } from '../generation/dimensions';
import { imageAspectRatios, imagePresetDimensions } from '../generation/image-dimensions';
import { videoDimensions, videoRatios, videoResolutions } from '../generation/video';
const strings = new Set(['label', 'customTitle', 'model', 'scriptInstruction', 'scriptPreset']);
const fields = new Set([...strings, 'type', 'prompt', 'storyboard', 'generationWidth', 'generationHeight', 'generationSizePreset', 'imageOptions', 'aspectRatio', 'videoResolution', 'videoAspectRatio', 'videoDuration', 'videoInstanceType', 'resolution', 'duration', 'count', 'promptOptimize']);
export function validateCanvasParameters(previous: NodeData, patch: Partial<NodeData>, models: CanvasModel[]): Partial<NodeData> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Node data must be an object');
    for (const [key, value] of Object.entries(patch)) {
        if (!fields.has(key)) throw new Error(`Unsupported editable field: ${key}`);
        if (strings.has(key) && (typeof value !== 'string' || value.length > 30000)) throw new Error(`Invalid ${key}`);
    }
    if (patch.type !== undefined && !Object.values(NodeType).includes(patch.type)) throw new Error('Invalid node type');
    if (patch.prompt !== undefined && typeof patch.prompt !== 'string' && (!Array.isArray(patch.prompt) || !patch.prompt.every(segment => segment && Object.keys(segment).length === 1 && ('text' in segment ? typeof segment.text === 'string' : 'ref' in segment && typeof segment.ref === 'string')))) throw new Error('Invalid prompt');
    const data = { ...previous, ...patch };
    if (patch.storyboard !== undefined) {
        const limits = patch.storyboard;
        if (data.type !== NodeType.SCRIPT || !limits || !Number.isInteger(limits.duration) || limits.duration < 5 || limits.duration > 600 || !Number.isInteger(limits.maxShots) || limits.maxShots < 1 || limits.maxShots > 40 || limits.duration > limits.maxShots * 15) throw new Error('Storyboard limits require a script node, 5–600 seconds, 1–40 shots and at most 15 seconds per shot');
    }
    if (patch.scriptPreset !== undefined && !scriptPresets.some(preset => preset.id === patch.scriptPreset)) throw new Error('Invalid script preset');
    if ((patch.scriptPreset !== undefined || patch.scriptInstruction !== undefined) && data.type !== NodeType.SCRIPT) throw new Error('Script parameters require a script node');
    const parameterKeys = ['model', 'generationWidth', 'generationHeight', 'generationSizePreset', 'imageOptions', 'aspectRatio', 'videoResolution', 'videoAspectRatio', 'videoDuration', 'videoInstanceType', 'resolution', 'duration', 'count', 'promptOptimize'];
    if (!parameterKeys.some(key => key in patch) && !(patch.type && data.model)) return patch;
    const model = models.find(model => model.id === data.model && model.configured);
    if (!model) throw new Error('Select a configured model');
    const imageTypes = [NodeType.TEXT_TO_IMAGE, NodeType.IMAGE_TO_IMAGE];
    const videoTypes = [NodeType.TEXT_TO_VIDEO, NodeType.IMAGE_TO_VIDEO, NodeType.START_END_TO_VIDEO];
    if (!(model.category === 'IMAGE' ? imageTypes : model.category === 'VIDEO' ? videoTypes : [NodeType.TEXT, NodeType.SCRIPT]).includes(data.type)) throw new Error('Model is incompatible with this node type');
    const result = { ...patch };
    if (model.legacy && model.category !== 'TEXT') {
        if (Object.keys(patch).some(key => key === 'imageOptions' || key.startsWith('generation') || key.startsWith('video'))) throw new Error('This existing model uses editor presets, not task-service pixel parameters');
        const image = model.category === 'IMAGE', fromImage = data.type === NodeType.IMAGE_TO_IMAGE;
        const ratios = image ? fromImage ? ['1:1', '16:9', '9:16'] : ['1:1', '16:9', '9:16', '4:3', '3:4'] : data.type === NodeType.TEXT_TO_VIDEO ? ['16:9', '9:16', '1:1'] : ['16:9', '9:16'];
        const resolutions = image ? fromImage ? ['1024x1024', '2048x2048', '4096x4096'] : ['1k', '2k', '4k'] : ['720P', '1080P', '4K'];
        const durations = data.type === NodeType.TEXT_TO_VIDEO ? ['5s', '10s', '15s', '20s'] : ['5', '8', '10'];
        if (patch.aspectRatio !== undefined && !ratios.includes(patch.aspectRatio) || patch.resolution !== undefined && !resolutions.includes(patch.resolution) || patch.duration !== undefined && (image || !durations.includes(patch.duration))) throw new Error('Unsupported editor preset');
        if (patch.count !== undefined && (!Number.isInteger(patch.count) || patch.count < 1 || patch.count > 4)) throw new Error('Unsupported count');
        if (patch.promptOptimize !== undefined && typeof patch.promptOptimize !== 'boolean') throw new Error('Invalid prompt optimization setting');
        return result;
    }
    if (model.category === 'TEXT') {
        if (Object.keys(patch).some(key => parameterKeys.includes(key) && key !== 'model')) throw new Error('Text model has no media parameters');
        return result;
    }
    if (['resolution', 'duration', 'count', 'promptOptimize'].some(key => key in patch)) throw new Error('Use task-service generation parameters');
    let width = data.generationWidth ?? model.capabilities.dimensions.defaultWidth;
    let height = data.generationHeight ?? model.capabilities.dimensions.defaultHeight;
    if (model.category === 'IMAGE') {
        if (Object.keys(patch).some(key => key.startsWith('video'))) throw new Error('Video parameters require a video model');
        const generationSizePreset = typeof data.generationSizePreset === 'string' ? data.generationSizePreset.toLowerCase() : data.generationSizePreset;
        if ('generationSizePreset' in patch) result.generationSizePreset = generationSizePreset as NodeData['generationSizePreset'];
        const presets = model.capabilities.image?.presets;
        if (patch.imageOptions !== undefined) {
            if (!model.capabilities.image?.options) throw new Error('This model does not support advanced image settings');
            result.imageOptions = normalizeImageOptions(patch.imageOptions);
        }
        if (presets) {
            if (generationSizePreset !== undefined && !model.capabilities.image!.sizes.some(size => size.toLowerCase() === generationSizePreset)) throw new Error('Invalid image size preset');
            if (data.aspectRatio !== undefined && !model.capabilities.image!.aspectRatios.includes(data.aspectRatio)) throw new Error('Invalid image aspect ratio');
            if ('generationSizePreset' in patch || 'aspectRatio' in patch) {
                const preset = presets.find(p => p.size.toLowerCase() === (generationSizePreset ?? '2k') && p.ratio === (data.aspectRatio ?? '1:1'));
                if (!preset) throw new Error('Unsupported image preset');
                width = preset.width; height = preset.height;
            }
            if (!presets.some(p => p.width === width && p.height === height)) throw new Error('Use supported image size and aspect ratio presets');
        } else {
            if (generationSizePreset !== undefined && !['1k', '2k', 'custom'].includes(generationSizePreset)) throw new Error('Invalid image size preset');
            if (data.aspectRatio !== undefined && !imageAspectRatios.includes(data.aspectRatio as typeof imageAspectRatios[number])) throw new Error('Invalid image aspect ratio');
            if (generationSizePreset && generationSizePreset !== 'custom' && ('generationSizePreset' in patch || 'aspectRatio' in patch)) {
                const size = imagePresetDimensions(generationSizePreset as Parameters<typeof imagePresetDimensions>[0], (data.aspectRatio ?? '1:1') as typeof imageAspectRatios[number], model.capabilities.dimensions);
                if (!size) throw new Error('Unsupported image preset');
                width = size.width; height = size.height;
            }
        }
    } else {
        if ('imageOptions' in patch) throw new Error('Image options require an image model');
        const video = model.capabilities.video;
        if (!video || !Number.isInteger(data.videoDuration ?? video.defaultDuration) || (data.videoDuration ?? video.defaultDuration) < video.minDuration || (data.videoDuration ?? video.defaultDuration) > video.maxDuration) throw new Error('Unsupported video duration');
        if (data.videoInstanceType !== undefined && data.videoInstanceType !== 'plus') throw new Error('Invalid video instance type');
        if (data.videoResolution !== undefined && !videoResolutions.includes(data.videoResolution)) throw new Error('Invalid video resolution');
        if (data.videoAspectRatio !== undefined && !videoRatios.includes(data.videoAspectRatio as typeof videoRatios[number])) throw new Error('Invalid video ratio');
        if ('videoResolution' in patch || 'videoAspectRatio' in patch) ({ width, height } = videoDimensions(data.videoResolution ?? '720p', data.videoAspectRatio ?? '16:9'));
    }
    if (!validGenerationDimensions(model.capabilities.dimensions, width, height)) throw new Error('Unsupported generation dimensions');
    return { ...result, generationWidth: width, generationHeight: height };
}
