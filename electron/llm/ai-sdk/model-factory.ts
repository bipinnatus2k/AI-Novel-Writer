import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { ProviderReasoningDirective } from '../../../src/shared/reasoning-types'
import { resolveOpenAIChatCompletionsUrl } from '../openai-compatible-endpoint'
import {
  applyOpenAiQuirks,
  createQuirkFetchForGemini,
  toOpenAiCompatibleBaseUrl,
} from './request-quirks'

/** Everything the AI SDK model builders need for one resolved request. */
export interface ModelContext {
  directive?: ProviderReasoningDirective
  wantsJsonResponse: boolean
}

export function buildModelContext(
  directive: ProviderReasoningDirective | undefined,
  wantsJsonResponse: boolean,
): ModelContext {
  return { directive, wantsJsonResponse }
}

/** Sanctioned `transformRequestBody` hook for the openai-compatible provider. */
export function transformOpenAiRequestBody(model: ModelProfile, context: ModelContext) {
  return (payload: Record<string, unknown>): Record<string, unknown> => {
    applyOpenAiQuirks(payload, model, context.directive, context.wantsJsonResponse)
    return payload
  }
}

export function createGeminiQuirkFetch(model: ModelProfile, context: ModelContext) {
  return createQuirkFetchForGemini({
    model,
    directive: context.directive,
    wantsJsonResponse: context.wantsJsonResponse,
  })
}

/** Gemini-native profiles may point at proxies, so the AI SDK base URL must
 * reproduce the legacy `${baseUrl}/v1beta/models/...` path layout. */
export function toGeminiBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}/v1beta`
}

/** Reproduces the legacy chat-completions endpoint exactly: the authoritative
 * resolver decides the full path, then we strip the suffix the AI SDK appends. */
export function toCompatibleBaseUrl(model: ModelProfile): string {
  return toOpenAiCompatibleBaseUrl(resolveOpenAIChatCompletionsUrl(model.baseUrl, model.provider))
}
