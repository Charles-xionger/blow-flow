import type { TaskSnapshot } from './service';
import type { GenerationInput, GenerationReference, WorkflowNode } from './types';
import { videoFrameCount } from './video';

export interface UploadedReference extends GenerationReference { fileName: string; duration?: number }

export function connectVideoReferences(graph: Record<string, WorkflowNode>, snapshot: TaskSnapshot,
  input: GenerationInput, uploaded: UploadedReference[]) {
  if (snapshot.model.adapter !== 'runninghub-workflow') throw new Error('Invalid workflow adapter');
  const mapping = snapshot.model.references!;
  const target = graph[mapping.nodeId];
  for (const key of Object.keys(target.inputs)) if (/^ref_(images|videos|video_audios|audios)\./.test(key)) delete target.inputs[key];
  let nextId = Math.max(...Object.keys(graph).map(Number).filter(Number.isFinite)) + 1;
  const counts = { image: 0, video: 0, audio: 0 };
  for (const ref of uploaded) {
    const id = String(nextId++);
    const index = counts[ref.kind]++;
    const source = graph[mapping[`${ref.kind}Loader`]];
    const loader = structuredClone(source);
    if (ref.kind === 'image') {
      loader.inputs.image = ref.fileName;
      target.inputs[`ref_images.ref_image_${index}`] = [id, 0];
    } else if (ref.kind === 'audio') {
      loader.inputs.audio = ref.fileName;
      target.inputs[`ref_audios.ref_audio_${index}`] = [id, 0];
    } else {
      loader.inputs.video = ref.fileName;
      loader.inputs.force_rate = 24;
      const outputFrames = videoFrameCount(input.duration!);
      const availableFrames = ref.duration === undefined ? outputFrames : Math.max(5, Math.floor(ref.duration * 24));
      // Align both the frame loader and its paired audio trim to H3's reference grid.
      loader.inputs.frame_load_cap = Math.min(outputFrames, 5 + 17 * Math.floor((availableFrames - 5) / 17));
      loader.inputs.skip_first_frames = 0;
      loader.inputs.select_every_nth = 1;
      target.inputs[`ref_videos.ref_video_${index}`] = [id, 0];
      if (ref.useAudio) target.inputs[`ref_video_audios.ref_video_audio_${index}`] = [id, 2];
    }
    graph[id] = loader;
  }
  // Keep exactly the output's dependencies: no sample images or empty upload placeholders execute.
  const keep = new Set<string>();
  const visit = (id: string) => {
    if (keep.has(id) || !graph[id]) return;
    keep.add(id);
    for (const value of Object.values(graph[id].inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1])) visit(value[0]);
    }
  };
  visit(snapshot.model.outputNode);
  for (const id of Object.keys(graph)) if (!keep.has(id)) delete graph[id];
}
