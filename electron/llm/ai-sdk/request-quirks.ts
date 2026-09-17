import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { ProviderReasoningDirective } from '../../../src/shared/reasoning-types'

/**
 * Per-provider request mutations that the AI SDK transport cannot know about.
 * The AI SDK owns URL construction, SSE parsing, usage extraction and finish
 * reasons; these quirks stay here because they are vendor-specific payload
 * compatibility rules verified by openai-provider/gemini-provider contracts.
 */
export interface QuirkContext {
  model: ModelProfile
  directive?: ProviderReasoningDirective
  /** Caller requested `response_format: json_object`-equivalent structured output. */
  wantsJsonResponse: boolean
}

export type QuirkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export function applyOpenAiQuirks(
  payload: Record<string, unknown>,
  model: ModelProfile,
  directive: ProviderReasoningDirective | undefined,
  wantsJsonResponse: boolean,
): void {
  const isNovelAI = model.provider === 'novelai'

  if (wantsJsonResponse && !isNovelAI) {
    payload.response_format = { type: 'json_object' }
  }

  if (directive?.adapter === 'openai-reasoning-effort' && !isNovelAI) {
    payload.reasoning_effort = directive.reasoningEffort
  }

  if (directive?.adapter === 'deepseek-v4-thinking' && model.provider === 'deepseek') {
    payload.thinking = { type: directive.thinking }
    if (directive.thinking === 'enabled') {
      payload.reasoning_effort = directive.reasoningEffort
    }
  }

  if (payload.stream === true) {
    // 旧契约显式请求最终 usage 块；NovelAI 只接受窄兼容载荷。
    if (isNovelAI) {
      delete payload.stream_options
    } else {
      payload.stream_options = { include_usage: true }
    }
  }
}

export function createQuirkFetchForGemini(context: QuirkContext): QuirkFetch {
  const impl: QuirkFetch = async (input, init) => {
    const requestInit = init ?? {}
    if (typeof requestInit.body === 'string' && requestInit.body.trimStart().startsWith('{')) {
      try {
        const payload = JSON.parse(requestInit.body) as Record<string, unknown>
        applyGeminiQuirks(payload, context.directive, context.wantsJsonResponse)
        requestInit.body = JSON.stringify(payload)
      } catch {
        // Non-JSON body: let the transport surface it downstream.
      }
    }
    return fetch(input, requestInit)
  }
  return impl
}

function applyGeminiQuirks(
  payload: Record<string, unknown>,
  directive: ProviderReasoningDirective | undefined,
  wantsJsonResponse: boolean,
): void {
  const generationConfig = payload.generationConfig !== null
    && typeof payload.generationConfig === 'object'
    && !Array.isArray(payload.generationConfig)
    ? payload.generationConfig as Record<string, unknown>
    : undefined
  if (!generationConfig) return

  if (directive?.adapter === 'gemini-thinking-budget') {
    generationConfig.thinkingConfig = { thinkingBudget: directive.thinkingBudget }
  }

  if (wantsJsonResponse) {
    generationConfig.responseMimeType = 'application/json'
  }
}

/** Derives the AI SDK openai-compatible baseURL from the authoritative resolver:
 * the provider appends `chat/completions`, so the resolver's path minus that
 * suffix (with a trailing slash) reproduces the exact legacy endpoint. */
export function toOpenAiCompatibleBaseUrl(resolvedUrl: string): string {
  const path = resolvedUrl.replace(/\/+$/u, '')
  const suffix = '/chat/completions'
  const stem = path.endsWith(suffix) ? path.slice(0, -suffix.length) : path
  return `${stem}/`
}
