/**
 * 服务商预设配置 — 共享类型定义
 * 渲染进程与主进程共同使用，持久化在 ~/.vela/provider-presets.json
 */

import type { VerifiedReasoningMapping } from './reasoning-types'

/** 单个模型的预设 — name + 该模型的输出 token 上限 */
export interface ModelPreset {
  name: string
  /** Model-specific capability metadata. `maxTokens` remains the legacy output limit. */
  capabilities?: ModelCapabilities
  /** Provider request mapping verified against the official model documentation. */
  reasoningMapping?: VerifiedReasoningMapping
  maxTokens: number
}

/** Optional capabilities supported by a model endpoint. */
export interface ModelCapabilities {
  /** `null` means the endpoint has not declared a context window. */
  contextWindowTokens: number | null
  maxOutputTokens: number
  reasoning: boolean
  structuredOutput: boolean
  usage: boolean
}

/** Persisted profile fields needed to resolve effective built-in capabilities. */
export interface ModelCapabilityProfile {
  provider?: unknown
  protocol?: unknown
  baseUrl?: unknown
  modelName?: unknown
  maxTokens?: unknown
  capabilities?: ModelCapabilities | null
}

/** 单个服务商的预设配置 */
export interface ProviderPreset {
  /** 服务商唯一标识（内置值如 openai/deepseek，用户可自定义如 my-proxy） */
  provider: string
  /** 界面显示名称，缺省时使用 provider ID */
  displayName?: string
  /** 英文界面显示名称；缺省时使用 displayName */
  displayNameEn?: string
  /** 默认 API 地址 */
  baseUrl: string
  /** 默认调用协议：openai 兼容 或 gemini 原生 */
  protocol: string
  /** 支持的生成模型列表（含各自的 maxTokens） */
  models: ModelPreset[]
  /** 支持的向量模型列表（embedding 模型不需要 maxTokens） */
  embeddingModels: string[]
  /** 向量模型的能力元数据，按模型 ID 索引以保持旧的 string[] 配置兼容。 */
  embeddingModelCapabilities?: Record<string, ModelCapabilities>
}

/**
 * 创建内置服务商目录。
 *
 * 每次调用均返回新的对象，方便调用方安全地派生 UI 状态而不污染全局预设。
 */
export function createProviderCatalog(): ProviderPreset[] {
  return [
  {
    provider: 'openai',
    displayName: 'OpenAI',
    displayNameEn: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    protocol: 'openai',
    models: [
      { name: 'gpt-4o', maxTokens: 16384 },
      { name: 'gpt-4o-mini', maxTokens: 16384 },
      { name: 'gpt-4-turbo', maxTokens: 4096 },
      { name: 'gpt-3.5-turbo', maxTokens: 4096 }
    ],
    embeddingModels: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'],
  },
  {
    provider: 'xai',
    displayName: 'xAI(Grok)',
    displayNameEn: 'xAI (Grok)',
    baseUrl: 'https://api.x.ai/v1',
    protocol: 'openai',
    models: [
      {
        name: 'grok-4.5',
        // Retain `maxTokens` for existing execution paths while exposing the
        // precise capability names used by new settings forms.
        maxTokens: 8192,
        capabilities: {
          contextWindowTokens: 500_000,
          maxOutputTokens: 8192,
          reasoning: true,
          structuredOutput: true,
          usage: true,
        },
        // https://docs.x.ai/developers/model-capabilities/text/reasoning
        reasoningMapping: {
          adapter: 'openai-reasoning-effort',
          supportedEfforts: ['low', 'medium', 'high'],
          providerValues: { low: 'low', medium: 'medium', high: 'high' },
        },
      },
    ],
    embeddingModels: [],
  },
  {
    provider: 'siliconflow',
    displayName: 'SiliconFlow',
    displayNameEn: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    protocol: 'openai',
    models: [],
    embeddingModels: ['BAAI/bge-m3'],
    embeddingModelCapabilities: {
      'BAAI/bge-m3': {
        contextWindowTokens: 8192,
        maxOutputTokens: 0,
        reasoning: false,
        structuredOutput: false,
        usage: true,
      },
    },
  },
  {
    provider: 'novelai',
    displayName: 'NovelAI',
    displayNameEn: 'NovelAI',
    baseUrl: 'https://text.novelai.net/oa',
    protocol: 'openai',
    models: [],
    embeddingModels: [],
  },
  {
    provider: 'deepseek',
    displayName: 'DeepSeek',
    displayNameEn: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    protocol: 'openai',
    models: [
      {
        name: 'deepseek-v4-flash',
        maxTokens: 384_000,
        capabilities: {
          contextWindowTokens: 1_000_000,
          maxOutputTokens: 384_000,
          reasoning: true,
          structuredOutput: true,
          usage: true,
        },
        // https://api-docs.deepseek.com/guides/thinking_mode/
        reasoningMapping: {
          adapter: 'deepseek-v4-thinking',
          supportedEfforts: ['off', 'low', 'high', 'max'],
          providerValues: { off: 'disabled', low: 'low', high: 'high', max: 'max' },
          requestAliases: { medium: 'high' },
        },
      },
      {
        name: 'deepseek-v4-pro',
        maxTokens: 384_000,
        capabilities: {
          contextWindowTokens: 1_000_000,
          maxOutputTokens: 384_000,
          reasoning: true,
          structuredOutput: true,
          usage: true,
        },
        // https://api-docs.deepseek.com/guides/thinking_mode/
        reasoningMapping: {
          adapter: 'deepseek-v4-thinking',
          supportedEfforts: ['off', 'low', 'high', 'max'],
          providerValues: { off: 'disabled', low: 'low', high: 'high', max: 'max' },
          requestAliases: { medium: 'high' },
        },
      },
    ],
    embeddingModels: [],
  },
  {
    /** 智谱 BigModel — OpenAI 兼容协议，API 路径为 /v4 */
    provider: 'bigmodel',
    displayName: 'BigModel（智谱）',
    displayNameEn: 'BigModel (Zhipu)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai',
    models: [
      { name: 'glm-4.5', maxTokens: 65536 },
      { name: 'glm-4.5-air', maxTokens: 65536 },
      { name: 'glm-4.6', maxTokens: 65536 },
      { name: 'glm-4.7', maxTokens: 65536 },
      { name: 'glm-4.7-flashx', maxTokens: 65536 },
      { name: 'glm-5-turbo', maxTokens: 65536 },
      { name: 'glm-5', maxTokens: 65536 },
    ],
    embeddingModels: ['embedding-3'],
  },
  {
    /** Moonshot AI（Kimi）— OpenAI 兼容协议；官方 K2.5+ 模型的采样参数由生成参数策略处理 */
    provider: 'moonshot',
    displayName: 'Moonshot（Kimi）',
    displayNameEn: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    protocol: 'openai',
    models: [
      { name: 'kimi-k3', maxTokens: 8192 },
      { name: 'kimi-k2.7', maxTokens: 8192 },
    ],
    embeddingModels: [],
  },
  {
    /** 阿里云通义千问 — DashScope OpenAI 兼容模式 */
    provider: 'qwen',
    displayName: 'Qwen（通义千问）',
    displayNameEn: 'Qwen (Tongyi)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'openai',
    models: [
      { name: 'qwen-max', maxTokens: 8192 },
      { name: 'qwen-plus', maxTokens: 8192 },
      { name: 'qwen-flash', maxTokens: 8192 },
    ],
    embeddingModels: ['text-embedding-v4'],
  },
  {
    /** 字节火山方舟（豆包）— OpenAI 兼容协议；模型 ID 与推理接入点绑定，走发现接口或手填 */
    provider: 'doubao',
    displayName: '豆包（火山方舟）',
    displayNameEn: 'Doubao (Volcengine Ark)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    protocol: 'openai',
    models: [],
    embeddingModels: [],
  },
  {
    provider: 'minimax',
    displayName: 'MiniMax',
    displayNameEn: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    protocol: 'openai',
    models: [],
    embeddingModels: [],
  },
  {
    provider: 'hunyuan',
    displayName: '混元（腾讯）',
    displayNameEn: 'Hunyuan (Tencent)',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    protocol: 'openai',
    models: [
      { name: 'hunyuan-turbos-latest', maxTokens: 8192 },
    ],
    embeddingModels: [],
  },
  {
    /** OpenRouter — 聚合网关，模型列表走发现接口 */
    provider: 'openrouter',
    displayName: 'OpenRouter',
    displayNameEn: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'openai',
    models: [],
    embeddingModels: [],
  },
  {
    provider: 'groq',
    displayName: 'Groq',
    displayNameEn: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    protocol: 'openai',
    models: [],
    embeddingModels: [],
  },
  {
    provider: 'mistral',
    displayName: 'Mistral',
    displayNameEn: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    protocol: 'openai',
    models: [
      { name: 'mistral-large-latest', maxTokens: 8192 },
    ],
    embeddingModels: ['mistral-embed'],
  },
  {
    provider: 'gemini',
    displayName: 'Google Gemini',
    displayNameEn: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    protocol: 'gemini',
    models: [
      {
        name: 'gemini-2.5-flash-lite',
        maxTokens: 65536,
        capabilities: {
          contextWindowTokens: 1_048_576,
          maxOutputTokens: 65_536,
          reasoning: true,
          structuredOutput: true,
          usage: true,
        },
        // https://ai.google.dev/gemini-api/docs/generate-content/thinking
        reasoningMapping: {
          adapter: 'gemini-thinking-budget',
          supportedEfforts: ['off', 'low', 'medium', 'high'],
          providerValues: { off: 0, low: 1_024, medium: 8_192, high: 24_576 },
        },
      },
      { name: 'gemini-3.1-pro-preview', maxTokens: 65536 },
      { name: 'gemini-3-flash-preview', maxTokens: 65536 },
    ],
    embeddingModels: ['text-embedding-004'],
  },
  {
    provider: 'ollama',
    displayName: 'Ollama（本地）',
    displayNameEn: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    protocol: 'openai',
    models: [
      { name: 'qwen3-14b-abliterated-novel-q4', maxTokens: 8192 },
      { name: 'llama3.3', maxTokens: 4096 },
      { name: 'llama3.2', maxTokens: 4096 },
      { name: 'qwen2.5', maxTokens: 8192 },
      { name: 'qwen2.5-coder', maxTokens: 8192 },
      { name: 'mistral', maxTokens: 4096 },
      { name: 'phi4', maxTokens: 4096 },
      { name: 'gemma3', maxTokens: 8192 },
    ],
    embeddingModels: ['nomic-embed-text', 'mxbai-embed-large', 'bge-m3'],
  },
  {
    /** LM Studio 本地服务 — OpenAI 兼容协议，默认端口 1234 */
    provider: 'lmstudio',
    displayName: 'LM Studio（本地）',
    displayNameEn: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1',
    protocol: 'openai',
    models: [],
    embeddingModels: [],
  },
  {
    provider: 'custom',
    displayName: '自定义',
    displayNameEn: 'Custom',
    baseUrl: '',
    protocol: 'openai',
    models: [],
    embeddingModels: [],
  },
  ]
}

/** 内置默认预设（首次启动时写入持久化文件） */
export const BUILTIN_PRESETS: ProviderPreset[] = createProviderCatalog()

/** 无需 API Key 的本地服务商；设置界面的连接测试与保存据此豁免密钥校验。 */
export const LOCAL_KEYLESS_PROVIDERS: ReadonlySet<string> = new Set(['ollama', 'lmstudio'])

export function isLocalKeylessProvider(provider: string): boolean {
  return LOCAL_KEYLESS_PROVIDERS.has(provider)
}

function normalizedOfficialBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const endpoint = new URL(value.trim())
    if (
      (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:')
      || endpoint.username
      || endpoint.password
      || endpoint.search
      || endpoint.hash
    ) return null
    endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '') || '/'
    return endpoint.toString().replace(/\/$/u, '')
  } catch {
    return null
  }
}

function validatedCapabilities(value: unknown): ModelCapabilities | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<ModelCapabilities>
  const validContext = candidate.contextWindowTokens === null
    || (Number.isSafeInteger(candidate.contextWindowTokens) && Number(candidate.contextWindowTokens) > 0)
  if (
    !validContext
    || !Number.isSafeInteger(candidate.maxOutputTokens)
    || Number(candidate.maxOutputTokens) <= 0
    || typeof candidate.reasoning !== 'boolean'
    || typeof candidate.structuredOutput !== 'boolean'
    || typeof candidate.usage !== 'boolean'
  ) return undefined
  return {
    contextWindowTokens: candidate.contextWindowTokens as number | null,
    maxOutputTokens: candidate.maxOutputTokens as number,
    reasoning: candidate.reasoning,
    structuredOutput: candidate.structuredOutput,
    usage: candidate.usage,
  }
}

/**
 * Resolve verified built-in provider facts without mutating persisted data.
 * User-stored capabilities and output limits are operational policy, not proof
 * of what a provider endpoint supports, so they never override this result.
 */
export function resolveModelProfileCapabilities(
  profile: ModelCapabilityProfile,
): ModelCapabilities | undefined {
  if (
    typeof profile.provider !== 'string'
    || typeof profile.protocol !== 'string'
    || typeof profile.modelName !== 'string'
  ) return undefined

  const provider = profile.provider
  const protocol = profile.protocol
  const modelName = profile.modelName.trim()
  const preset = BUILTIN_PRESETS.find(candidate => candidate.provider === provider)
  if (
    !preset
    || preset.protocol !== protocol
    || normalizedOfficialBaseUrl(profile.baseUrl) !== normalizedOfficialBaseUrl(preset.baseUrl)
  ) {
    return undefined
  }

  const model = preset.models.find(candidate => candidate.name === modelName)
  return validatedCapabilities(model?.capabilities)
}

/**
 * Resolve only provider request mappings whose endpoint and exact model slug
 * match an app-maintained built-in preset. User-entered capability flags are
 * operational hints and never become protocol evidence.
 */
export function resolveModelProfileReasoningMapping(
  profile: ModelCapabilityProfile,
): VerifiedReasoningMapping | undefined {
  if (
    typeof profile.provider !== 'string'
    || typeof profile.protocol !== 'string'
    || typeof profile.modelName !== 'string'
  ) return undefined

  const provider = profile.provider
  const protocol = profile.protocol
  const modelName = profile.modelName.trim()
  const preset = BUILTIN_PRESETS.find(candidate => candidate.provider === provider)
  if (
    !preset
    || preset.protocol !== protocol
    || normalizedOfficialBaseUrl(profile.baseUrl) !== normalizedOfficialBaseUrl(preset.baseUrl)
  ) return undefined

  const mapping = preset.models.find(candidate => candidate.name === modelName)
    ?.reasoningMapping
  if (!mapping) return undefined
  return {
    adapter: mapping.adapter,
    supportedEfforts: [...mapping.supportedEfforts],
    providerValues: { ...mapping.providerValues },
    ...(mapping.requestAliases ? { requestAliases: { ...mapping.requestAliases } } : {}),
  }
}
