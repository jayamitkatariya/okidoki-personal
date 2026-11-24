export const ASTER_PROVIDER = 'aster';
export const ASTER_BASE_URL = 'https://api.asterlab.ai/v1';
export const ASTER_API_KEY_PREFIX = 'sk_aster_';
export const ASTER_MODELS: string[] = [
  'kimi-k3',
  'glm-5.2',
  'gpt-oss-120b-fast',
  'gpt-oss-120b',
];
export const DEFAULT_ASTER_MODEL = ASTER_MODELS[0];

export const ASTER_MODEL_LABELS: Record<string, string> = {
  'kimi-k3': 'Kimi K3',
  'glm-5.2': 'GLM 5.2',
  'gpt-oss-120b-fast': 'GPT-OSS 120B Fast',
  'gpt-oss-120b': 'GPT-OSS 120B',
};
