import { generateText, streamText } from 'ai'
import type { LanguageModel, LanguageModelUsage, ModelMessage } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ILLMProvider, LLMGenerateOptions, LLMResponse, LLMStreamOptions } from '../provider.interface'
import type { LLMFinishReason, TokenUsage } from '../../../src/shared/ipc-channels'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import {
  buildModelContext,
  createGeminiQuirkFetch,
  toAnthropicBaseUrl,
  toCompatibleBaseUrl,
  toGeminiBaseUrl,
  transformOpenAiRequestBody,
  type ModelContext,
} from './model-factory'
import { stripThinkingTags, THINK_CLOSE_MARKER, THINK_OPEN_MARKER } from './think-tags'

/** The AI SDK reports success only with explicit semantic stop evidence,
 * matching the legacy provider contract downstream workflows rely on. */
function mapFinishReason(finishReason: string): LLMFinishReason {
  if (finishReason === 'stop') return 'stop'
  if (finishReason === 'length') return 'length'
  if (finishReason === 'content-filter') return 'content_filter'
  if (finishReason === 'error') return 'error'
  return 'unknown'
}

function mapUsage(usage: {
  inputTokens?: number | null
  outputTokens?: number | null
  totalTokens?: number | null
} | undefined): TokenUsage | undefined {
  if (!usage) return undefined
  const { inputTokens, outputTokens, totalTokens } = usage
  if (inputTokens == null && outputTokens == null && totalTokens == null) return undefined
  return {
    promptTokens: inputTokens ?? null,
    completionTokens: outputTokens ?? null,
    totalTokens: totalTokens ?? null,
  }
}

function toModelMessages(messages: Array<{ role: string; content: string }>): ModelMessage[] {
  return messages.map(message => {
    if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') {
      throw new Error(`不支持的对话角色：${message.role}`)
    }
    return { role: message.role, content: message.content }
  })
}

/** AI SDK v7 移除了 messages 中的 system 消息，必须走 instructions 选项；
 * 这里把调用方的 system 消息合并成一段指令，其余角色保持原样。 */
function splitInstructions(
  messages: Array<{ role: string; content: string }>,
): { instructions: string | undefined; conversation: Array<{ role: string; content: string }> } {
  const systemParts = messages
    .filter(message => message.role === 'system')
    .map(message => message.content)
  const conversation = messages.filter(message => message.role !== 'system')
  return {
    instructions: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    conversation,
  }
}

function buildLanguageModel(model: ModelProfile, context: ModelContext): LanguageModel {
  if (model.protocol === 'anthropic') {
    const anthropic = createAnthropic({
      apiKey: model.apiKey,
      baseURL: toAnthropicBaseUrl(model.baseUrl),
    })
    return anthropic.languageModel(model.modelName)
  }
  if (model.protocol === 'gemini') {
    const google = createGoogleGenerativeAI({
      apiKey: model.apiKey,
      baseURL: toGeminiBaseUrl(model.baseUrl),
      fetch: createGeminiQuirkFetch(model, context),
    })
    return google.languageModel(model.modelName)
  }
  // openai-compatible：怪癖走官方 transformRequestBody 钩子；includeUsage 控制
  // 最终 usage 块（NovelAI 只接受窄兼容载荷）。
  const openaiCompatible = createOpenAICompatible({
    name: `ai-novel-${model.provider}`,
    baseURL: toCompatibleBaseUrl(model),
    apiKey: model.apiKey,
    includeUsage: model.provider !== 'novelai',
    transformRequestBody: transformOpenAiRequestBody(model, context),
  })
  return openaiCompatible.chatModel(model.modelName)
}

/** Structural view of the AI SDK stream parts consumed here. Deliberately
 * wide: instantiating the SDK's full discriminated union per narrowing branch
 * is pathologically expensive for the type checker. */
interface WideStreamPart {
  type: string
  text?: string
  finishReason?: unknown
  totalUsage?: LanguageModelUsage
  error?: unknown
}

/**
 * Transport implementation over the Vercel AI SDK. URL construction, SSE
 * parsing, usage extraction and finish reasons are owned by the SDK; vendor
 * payload compatibility stays in request-quirks. Retries stay disabled:
 * generation side effects are billed per call and callers own attempt budgets.
 */
export class AiSdkProvider implements ILLMProvider {
  async generate(
    model: ModelProfile,
    messages: Array<{ role: string; content: string }>,
    opts: LLMGenerateOptions,
  ): Promise<LLMResponse> {
    try {
      const context = buildModelContext(opts.reasoning, opts.responseFormat?.type === 'json_object')
      const { instructions, conversation } = splitInstructions(messages)
      const result = await generateText({
        model: buildLanguageModel(model, context),
        instructions,
        messages: toModelMessages(conversation),
        temperature: opts.temperature,
        maxOutputTokens: opts.maxTokens ?? model.maxTokens,
        maxRetries: 0,
      })

      const finishReason = mapFinishReason(result.finishReason)
      const usage = mapUsage(result.usage)
      const content = stripThinkingTags(result.text)
      if (finishReason === 'stop') {
        return { success: true, content, finishReason, usage }
      }
      return {
        success: false,
        content,
        finishReason,
        usage,
        error: 'API 返回的文本未正常完成',
      }
    } catch (error) {
      return { success: false, content: '', finishReason: 'error', error: String(error) }
    }
  }

  async generateStream(
    model: ModelProfile,
    messages: Array<{ role: string; content: string }>,
    opts: LLMStreamOptions,
  ): Promise<void> {
    let fullText = ''
    let usage: TokenUsage | undefined
    let finishReason: LLMFinishReason = 'unknown'
    const fail = (error: string) => {
      const visibleCandidate = stripThinkingTags(fullText)
      opts.onError(error, visibleCandidate || undefined, usage)
    }

    try {
      const context = buildModelContext(opts.reasoning, opts.responseFormat?.type === 'json_object')
      const { instructions, conversation } = splitInstructions(messages)
      const result = streamText({
        model: buildLanguageModel(model, context),
        instructions,
        messages: toModelMessages(conversation),
        temperature: opts.temperature,
        maxOutputTokens: opts.maxTokens ?? model.maxTokens,
        abortSignal: opts.signal,
        maxRetries: 0,
      })

      let isThinking = false
      const emit = (chunk: string) => {
        fullText += chunk
        opts.onChunk(chunk)
      }

      const parts: AsyncIterable<WideStreamPart> = result.fullStream
      for await (const part of parts) {
        if (part.type === 'reasoning-delta') {
          if (!isThinking) {
            isThinking = true
            emit(THINK_OPEN_MARKER)
          }
          emit(part.text ?? '')
        } else if (part.type === 'text-delta') {
          if (isThinking) {
            isThinking = false
            emit(THINK_CLOSE_MARKER)
          }
          emit(part.text ?? '')
        } else if (part.type === 'error') {
          throw part.error instanceof Error ? part.error : new Error(String(part.error))
        } else if (part.type === 'abort') {
          const abortError = new Error('已取消生成')
          abortError.name = 'AbortError'
          throw abortError
        } else if (part.type === 'finish') {
          finishReason = mapFinishReason(String(part.finishReason))
          usage = mapUsage(part.totalUsage)
        }
      }

      if (isThinking) emit(THINK_CLOSE_MARKER)
      opts.onDone(stripThinkingTags(fullText), usage, finishReason)
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        fail('已取消生成')
      } else {
        fail(String(error))
      }
    }
  }
}
