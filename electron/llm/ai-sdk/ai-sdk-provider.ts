import { generateText, streamText } from 'ai'
import type { LanguageModel, LanguageModelUsage, ModelMessage } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ILLMProvider, LLMGenerateOptions, LLMResponse, LLMStreamOptions } from '../provider.interface'
import type { LLMFinishReason, LLMToolCall, TokenUsage } from '../../../src/shared/ipc-channels'
import type { ModelProfile } from '../../../src/shared/ipc-channels'
import type { ProviderReasoningDirective } from '../../../src/shared/reasoning-types'
import {
  buildModelContext,
  createGeminiQuirkFetch,
  toAnthropicBaseUrl,
  toCompatibleBaseUrl,
  toGeminiBaseUrl,
  transformOpenAiRequestBody,
  type ModelContext,
} from './model-factory'
import { ProtocolSegmenter, segmentProtocolText } from './protocol-segmenter'

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
 * payload compatibility stays in request-quirks and model-text dialects
 * (think blocks, DSML tool calls) are segmented out by ProtocolSegmenter so
 * protocol text never reaches the UI. Retries stay disabled: generation side
 * effects are billed per call and callers own attempt budgets.
 */
/** Anthropic extended thinking：budget > 0 时启用 thinking，并必须省略
 * temperature（Anthropic 要求 thinking 启用时采样参数取默认值 1）。 */
function anthropicThinkingOptions(reasoning: ProviderReasoningDirective | undefined) {
  if (reasoning?.adapter !== 'anthropic-thinking-budget' || reasoning.thinkingBudget <= 0) {
    return undefined
  }
  return { type: 'enabled' as const, budgetTokens: reasoning.thinkingBudget }
}

export class AiSdkProvider implements ILLMProvider {
  async generate(
    model: ModelProfile,
    messages: Array<{ role: string; content: string }>,
    opts: LLMGenerateOptions,
  ): Promise<LLMResponse> {
    try {
      const context = buildModelContext(opts.reasoning, opts.responseFormat?.type === 'json_object')
      const { instructions, conversation } = splitInstructions(messages)
      const thinking = anthropicThinkingOptions(opts.reasoning)
      const result = await generateText({
        model: buildLanguageModel(model, context),
        instructions,
        messages: toModelMessages(conversation),
        temperature: thinking ? undefined : opts.temperature,
        maxOutputTokens: opts.maxTokens ?? model.maxTokens,
        ...(thinking ? { providerOptions: { anthropic: { thinking } } } : {}),
        maxRetries: 0,
      })

      const finishReason = mapFinishReason(result.finishReason)
      const usage = mapUsage(result.usage)
      // 正文与推理在传输层分离：think 块与工具调用方言永不进入 content
      const segmented = segmentProtocolText(result.text)
      const content = segmented.content
      const reasoning = segmented.reasoning || undefined
      const toolCalls = segmented.toolCalls.length > 0 ? segmented.toolCalls : undefined
      if (finishReason === 'stop') {
        return { success: true, content, finishReason, usage, reasoning, toolCalls }
      }
      return {
        success: false,
        content,
        finishReason,
        usage,
        reasoning,
        toolCalls,
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
    let toolCalls: LLMToolCall[] | undefined
    const fail = (error: string) => {
      opts.onError(error, fullText || undefined, usage)
    }

    try {
      const context = buildModelContext(opts.reasoning, opts.responseFormat?.type === 'json_object')
      const { instructions, conversation } = splitInstructions(messages)
      const thinking = anthropicThinkingOptions(opts.reasoning)
      const result = streamText({
        model: buildLanguageModel(model, context),
        instructions,
        messages: toModelMessages(conversation),
        temperature: thinking ? undefined : opts.temperature,
        maxOutputTokens: opts.maxTokens ?? model.maxTokens,
        ...(thinking ? { providerOptions: { anthropic: { thinking } } } : {}),
        abortSignal: opts.signal,
        maxRetries: 0,
      })

      // 协议分段器：think 推理与工具调用方言在这里截住，正文增量才外发
      const segmenter = new ProtocolSegmenter()
      const emitContent = (chunk: string) => {
        if (!chunk) return
        fullText += chunk
        opts.onChunk(chunk)
      }

      const parts: AsyncIterable<WideStreamPart> = result.fullStream
      for await (const part of parts) {
        if (part.type === 'reasoning-delta') {
          opts.onReasoning?.(part.text ?? '')
        } else if (part.type === 'text-delta') {
          const segmented = segmenter.push(part.text ?? '')
          if (segmented.reasoning) opts.onReasoning?.(segmented.reasoning)
          emitContent(segmented.content ?? '')
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

      const flushed = segmenter.finish()
      if (flushed.reasoning) opts.onReasoning?.(flushed.reasoning)
      emitContent(flushed.content ?? '')
      if (segmenter.toolCalls.length > 0) toolCalls = segmenter.toolCalls
      opts.onDone(fullText, usage, finishReason, toolCalls)
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        fail('已取消生成')
      } else {
        fail(String(error))
      }
    }
  }
}
