/** Shared public catalog; credentials stay in the server environment. */
export const ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
export const ARK_TEXT_MODELS = [
  { id: 'deepseek-v4-pro-ga-260813', name: 'DeepSeek V4 Pro', vision: false, webSearch: true },
  { id: 'doubao-seed-2-1-pro-260915', name: 'Doubao Seed 2.1 Pro', vision: true, webSearch: false },
] as const;

export function arkTextModel(id: string) {
  return ARK_TEXT_MODELS.find(model => model.id === id || model.name === id);
}
