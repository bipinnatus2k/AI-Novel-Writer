/**
 * Agent 核心引擎 — ReAct（Reasoning + Acting）循环
 *
 * 这是 Agent 的大脑，负责：
 * 1. 将用户消息、系统提示、Tool 描述组装为 LLM 输入
 * 2. 解析 LLM 输出中的 <tool_call> 标签
 * 3. 执行 Tool 并将结果注入为 observation
 * 4. 循环直到 LLM 不再调用 Tool 或达到最大循环次数
 *
 * 参考 Claude Code 的 query.ts 和 QueryEngine 设计，
 * 但简化为 Vela 的 Electron + React 架构。
 */

import {
  toolRegistry,
  type AgentExecutionContext,
  type ToolResult,
  type ToolArtifact,
} from './tool-registry'
import { createAgentExecutionContext } from './tools/project-context'
import { writingLanguageText, type WritingLanguage } from '../../shared/writing-language'
import type { FileWriteCommitState, LLMToolCall } from '../../shared/ipc-channels'

// ===== 常量 =====

/** ReAct 循环最大次数（防止死循环）；长文件分页读取需要更多轮次 */
const MAX_TOOL_ROUNDS = 16

/** Tool 执行超时（毫秒） */
const TOOL_TIMEOUT_MS = 30_000

/** Tool 返回内容最大长度（字符）；read_file 的分页窗口(12k)不应被此项截断 */
const TOOL_RESULT_MAX_CHARS = 12_000

// ===== 类型 =====

/** Tool 调用信息 */
export interface ToolCallInfo {
  id: string
  toolName: string
  arguments: Record<string, unknown>
  status: 'pending' | 'running' | 'completed' | 'failed' | 'result_unknown' | 'waiting_confirm'
  result?: string
  error?: string
  commitState?: FileWriteCommitState
  /** Tool 来源标记 */
  source?: string
  /** Frozen project identity used to render and execute a confirmed domain proposal. */
  projectSession?: AgentExecutionContext['projectSession']
}

/** One optional blueprint diff selected from a transient novel-config impact preview. */
export interface ConfigImpactBlueprintProposal {
  readonly name: 'propose_chapter_blueprint'
  readonly arguments: Record<string, unknown>
}

export interface ToolConfirmationDecision {
  readonly confirmed: boolean
  readonly blueprintProposals?: readonly ConfigImpactBlueprintProposal[]
}

/** Agent Engine 回调 */
export interface AgentEngineCallbacks {
  /** 流式文本片段 */
  onTextChunk: (chunk: string) => void
  /** 本轮模型推理内容（think 块 / reasoning 通道） */
  onReasoningChunk?: (reasoning: string) => void
  /** Tool 调用开始 */
  onToolCallStart: (toolCall: ToolCallInfo) => void
  /** Tool 调用完成 */
  onToolCallComplete: (toolCall: ToolCallInfo) => void
  /** Tool 需要用户确认 */
  onToolCallConfirmRequired: (toolCall: ToolCallInfo) => Promise<boolean | ToolConfirmationDecision>
  /** 全部完成 */
  onDone: (fullText: string, toolCalls: ToolCallInfo[], artifacts: ToolArtifact[]) => void
  /** 错误 */
  onError: (error: string) => void
}

/** LLM 消息格式 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 一轮生成的结果：正文已在传输层与推理、工具调用方言分离。 */
export interface AgentGenerationResult {
  content: string
  /** 传输层从文本方言中解析出的结构化工具调用。 */
  toolCalls?: LLMToolCall[]
  /** 模型推理内容（think 块 / reasoning 通道）。 */
  reasoning?: string
}

/** LLM 生成函数签名（由 agent-store 提供实际实现） */
export type LLMGenerateFn = (
  messages: LLMMessage[],
  modelId: string,
) => Promise<AgentGenerationResult>

const TOOL_CALL_BLOCK = /<(tool_call|｜DSML｜tool_call)>[\s\S]*?<\/\1>/g
const TOOL_CALL_TAG = /<\/?(?:tool_call|｜DSML｜tool_call)>/g

/** Remove provider tool-protocol markup before any model text reaches the UI. */
export function cleanAgentVisibleText(text: string): string {
  return text
    .replace(TOOL_CALL_BLOCK, '')
    .replace(/<tool_result[\s\S]*?<\/tool_result>/g, '')
    .replace(TOOL_CALL_TAG, '')
    .replace(/<\/?tool_result[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ===== 核心引擎 =====

/**
 * 执行 Agent ReAct 循环
 *
 * 流程：
 * 1. 将系统提示（含 Tool 描述）+ 历史消息 + 用户消息发送给 LLM
 * 2. 解析 LLM 回复中的 <tool_call> 标签
 * 3. 如果有 tool_call → 执行 Tool → 将结果作为 observation 追加到消息历史 → 重新调用 LLM
 * 4. 循环直到 LLM 不再调用 Tool 或达到 MAX_TOOL_ROUNDS
 * 5. 返回最终文本回复
 */
export async function runAgentLoop(
  systemPrompt: string,
  historyMessages: LLMMessage[],
  userMessage: string,
  modelId: string | undefined,
  generateFn: LLMGenerateFn,
  callbacks: AgentEngineCallbacks,
  abortSignal?: AbortSignal,
  providedExecutionContext?: AgentExecutionContext,
): Promise<void> {
  const allToolCalls: ToolCallInfo[] = []
  const allArtifacts: ToolArtifact[] = []
  // One agent run gets one immutable project identity. Tool calls later in the
  // loop must not silently borrow a lease issued after a same-path reopen.
  const executionContext = providedExecutionContext ?? createAgentExecutionContext(modelId)
  const modelText = (zhCN: string, enUS: string) => (
    writingLanguageText(executionContext.writingLanguage, zhCN, enUS)
  )
  const uiText = (zhCN: string, enUS: string) => (
    executionContext.uiLocale === 'en-US' ? enUS : zhCN
  )

  // 构建消息列表
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    ...historyMessages,
    { role: 'user', content: userMessage },
  ]

  let rounds = 0
  let fullAssistantText = ''

  while (rounds < MAX_TOOL_ROUNDS) {
    // 检查中止信号
    if (abortSignal?.aborted) {
      callbacks.onDone(fullAssistantText + uiText('\n\n_（已停止生成）_', '\n\n_(Generation stopped)_'), allToolCalls, allArtifacts)
      return
    }

    rounds++

    // 调用 LLM
    let generation: AgentGenerationResult
    try {
      generation = await generateFn(messages, modelId ?? '')
    } catch {
      if (abortSignal?.aborted) {
        callbacks.onDone(fullAssistantText + uiText('\n\n_（已停止生成）_', '\n\n_(Generation stopped)_'), allToolCalls, allArtifacts)
        return
      }
      callbacks.onError(uiText('AI 请求失败，请重试。', 'The AI request failed. Please try again.'))
      return
    }

    // 检查中止
    if (abortSignal?.aborted) {
      callbacks.onDone(fullAssistantText + uiText('\n\n_（已停止生成）_', '\n\n_(Generation stopped)_'), allToolCalls, allArtifacts)
      return
    }

    // 推理内容走独立通道，永不进入正文
    if (generation.reasoning) {
      callbacks.onReasoningChunk?.(generation.reasoning)
    }

    // 工具调用由传输层从文本方言中解析为结构化结果；正文已不含协议文本
    const toolCalls = generation.toolCalls ?? []
    const textContent = cleanAgentVisibleText(generation.content)
    if (textContent) {
      callbacks.onTextChunk(textContent)
      fullAssistantText += textContent
    }

    // 如果没有 tool_call，循环结束
    if (toolCalls.length === 0) {
      callbacks.onDone(fullAssistantText, allToolCalls, allArtifacts)
      return
    }

    // 将 LLM 的完整回复加入历史（以教授给模型的标准格式回填工具调用，保持上下文连续）
    const historyContent = toolCalls.length > 0
      ? `${generation.content}\n${toolCalls.map(tc =>
          `<tool_call>\n${JSON.stringify({ name: tc.name, arguments: tc.args })}\n</tool_call>`,
        ).join('\n')}`
      : generation.content
    messages.push({ role: 'assistant', content: historyContent })

    // 依次执行每个 tool_call。配置影响预览中明确选择的蓝图差异会在
    // 配置写入成功后插入此轮，并继续走同一条确认与工具执行路径。
    const observationParts: string[] = []
    const roundToolCalls = [...toolCalls]
    let resultUnknown = false

    for (let toolIndex = 0; toolIndex < roundToolCalls.length; toolIndex++) {
      if (abortSignal?.aborted) break
      const tc = roundToolCalls[toolIndex]
      const toolCallInfo: ToolCallInfo = {
        id: crypto.randomUUID(),
        toolName: tc.name,
        arguments: tc.args,
        status: 'pending',
        projectSession: executionContext.projectSession,
      }
      allToolCalls.push(toolCallInfo)

      // 查找 Tool
      const tool = toolRegistry.get(tc.name)
      if (!tool) {
        toolCallInfo.status = 'failed'
        toolCallInfo.error = uiText(`未知工具：${tc.name}`, `Unknown tool: ${tc.name}`)
        callbacks.onToolCallComplete(toolCallInfo)
        observationParts.push(`<tool_result name="${tc.name}" error="true">\n${modelText(
          `未知工具：${tc.name}。可用工具：${toolRegistry.listAll().map(t => t.name).join(', ')}`,
          `Unknown tool: ${tc.name}. Available tools: ${toolRegistry.listAll().map(t => t.name).join(', ')}`,
        )}\n</tool_result>`)
        continue
      }

      // 记录来源
      toolCallInfo.source = tool.source

      // 需要用户确认的 Tool
      let confirmationDecision: ToolConfirmationDecision = { confirmed: true }
      if (tool.requiresConfirmation) {
        toolCallInfo.status = 'waiting_confirm'
        callbacks.onToolCallStart(toolCallInfo)

        const response = await callbacks.onToolCallConfirmRequired(toolCallInfo)
        confirmationDecision = typeof response === 'boolean' ? { confirmed: response } : response
        if (!confirmationDecision.confirmed) {
          toolCallInfo.status = 'failed'
          if (!tool.isReadOnly) toolCallInfo.commitState = 'not_committed'
          toolCallInfo.error = uiText('用户拒绝执行', 'The user declined this action')
          callbacks.onToolCallComplete(toolCallInfo)
          observationParts.push(`<tool_result name="${tc.name}" error="true">\n${modelText('用户拒绝了此操作', 'The user declined this action')}\n</tool_result>`)
          continue
        }
        // The waiting confirmation card already represents this call. Its
        // completion below updates that same card instead of appending a
        // second one when execution begins.
        toolCallInfo.status = 'running'
      } else {
        // Non-confirming tools still need one visible lifecycle card.
        toolCallInfo.status = 'running'
        callbacks.onToolCallStart(toolCallInfo)
      }

      // 执行 Tool

      let sideEffectStarted = false
      try {
        const result = await executeToolWithTimeout(
          tool.execute,
          tc.args,
          Object.freeze({
            ...executionContext,
            markSideEffectStarted: () => { sideEffectStarted = true },
          }),
          TOOL_TIMEOUT_MS,
          executionContext.writingLanguage,
          tool.isReadOnly,
          () => sideEffectStarted,
          abortSignal,
        )

        // 截断过长的结果
        const truncatedContent = truncateResult(
          result.content,
          TOOL_RESULT_MAX_CHARS,
          executionContext.writingLanguage,
        )

        toolCallInfo.commitState = result.commitState
        if (!tool.isReadOnly && result.commitState === 'unknown') {
          toolCallInfo.status = 'result_unknown'
          toolCallInfo.error = uiText(
            '操作可能已提交，但回执未返回；结果待确认，本轮不会自动重试。',
            'The operation may have committed, but no receipt returned. Its result is unknown and this run will not retry it automatically.',
          )
          callbacks.onToolCallComplete(toolCallInfo)
          resultUnknown = true
          break
        }

        toolCallInfo.status = result.success ? 'completed' : 'failed'
        if (result.success) {
          toolCallInfo.result = truncatedContent
        } else {
          toolCallInfo.error = uiText('工具执行失败，请重试。', 'Tool execution failed. Please try again.')
        }
        if (result.artifacts) allArtifacts.push(...result.artifacts)

        callbacks.onToolCallComplete(toolCallInfo)

        if (result.success) {
          observationParts.push(`<tool_result name="${tc.name}">\n${truncatedContent}\n</tool_result>`)
          if (tc.name === 'propose_novel_config' && confirmationDecision.blueprintProposals?.length) {
            roundToolCalls.splice(
              toolIndex + 1,
              0,
              ...confirmationDecision.blueprintProposals.map(proposal => makeTransportToolCall(proposal.name, proposal.arguments)),
            )
          }
        } else {
          observationParts.push(`<tool_result name="${tc.name}" error="true">\n${modelText('工具执行失败。', 'Tool execution failed.')}\n</tool_result>`)
        }
      } catch (error) {
        const unknownWriteResult = !tool.isReadOnly && sideEffectStarted
        if (!tool.isReadOnly) {
          toolCallInfo.commitState = unknownWriteResult ? 'unknown' : 'not_committed'
        }
        toolCallInfo.status = unknownWriteResult ? 'result_unknown' : 'failed'
        toolCallInfo.error = unknownWriteResult
          ? uiText(
              '操作可能已提交，但回执未返回；结果待确认，本轮不会自动重试。',
              'The operation may have committed, but no receipt returned. Its result is unknown and this run will not retry it automatically.',
            )
          : error instanceof ToolExecutionTimeoutError
          ? uiText('工具停止等待：执行超时，操作已取消。', 'Tool wait timed out; the operation was cancelled.')
          : abortSignal?.aborted
            ? uiText('工具已在提交前取消。', 'The tool was cancelled before commit.')
            : uiText('工具执行失败，请重试。', 'Tool execution failed. Please try again.')
        callbacks.onToolCallComplete(toolCallInfo)
        if (unknownWriteResult) {
          resultUnknown = true
          break
        } else {
          observationParts.push(`<tool_result name="${tc.name}" error="true">\n${modelText('工具执行失败。', 'Tool execution failed.')}\n</tool_result>`)
        }
      }
    }

    if (resultUnknown) {
      callbacks.onDone(fullAssistantText + uiText(
        '\n\n_（写入结果待确认；为避免重复写入，本轮已停止。）_',
        '\n\n_(The write result is unknown. This run stopped to avoid a duplicate write.)_',
      ), allToolCalls, allArtifacts)
      return
    }

    // 将所有 tool 结果作为 user role 的 observation 注入
    // 加上明确提示，防止 LLM 误以为这是用户新发言
    const observation = `${modelText(
      '[以下是工具执行结果，请根据结果继续回答用户的问题]',
      '[The following are tool results. Continue answering the user based on them.]',
    )}\n\n${observationParts.join('\n\n')}\n\n${modelText(
      '[请根据上面的工具结果，继续回答用户的原始问题。如果需要更多信息可以继续调用工具。]',
      '[Continue answering the original request using the tool results above. Call another tool only if more information is needed.]',
    )}`
    messages.push({ role: 'user', content: observation })
  }

  // 达到最大循环次数
  if (rounds >= MAX_TOOL_ROUNDS) {
    fullAssistantText += uiText(
      '\n\n已达到最大工具调用次数限制，自动停止。',
      '\n\nThe maximum number of tool calls was reached, so generation stopped.',
    )
  }

  callbacks.onDone(fullAssistantText, allToolCalls, allArtifacts)
}

// ===== 工具函数 =====

/** 把结构化调用统一为传输层 LLMToolCall 形状。 */
function makeTransportToolCall(name: string, args: Record<string, unknown>): LLMToolCall {
  return { name, args }
}

async function executeToolWithTimeout(
  executeFn: (
    args: Record<string, unknown>,
    context?: AgentExecutionContext,
  ) => Promise<ToolResult>,
  args: Record<string, unknown>,
  context: AgentExecutionContext,
  timeoutMs: number,
  writingLanguage: WritingLanguage,
  isReadOnly: boolean,
  hasSideEffectStarted: () => boolean,
  outerSignal?: AbortSignal,
): Promise<ToolResult> {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(outerSignal?.reason)
  if (outerSignal?.aborted) forwardAbort()
  else outerSignal?.addEventListener('abort', forwardAbort, { once: true })
  const toolContext = Object.freeze({ ...context, abortSignal: controller.signal })
  const execution = executeFn(args, toolContext)

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      execution,
      new Promise<ToolResult>((_, reject) => {
        timer = setTimeout(() => {
          // A dispatched write gets the same finite foreground wait, but is
          // reported as unknown rather than cancelled/retryable.
          if (isReadOnly || !hasSideEffectStarted()) controller.abort()
          reject(new ToolExecutionTimeoutError(writingLanguageText(
            writingLanguage,
            `工具执行超时（${timeoutMs / 1000}s）`,
            `Tool execution timed out (${timeoutMs / 1000}s)`,
          )))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    outerSignal?.removeEventListener('abort', forwardAbort)
  }
}

class ToolExecutionTimeoutError extends Error {}

/**
 * 截断过长的 Tool 结果
 */
function truncateResult(content: string, maxChars: number, writingLanguage: WritingLanguage): string {
  if (content.length <= maxChars) return content
  return content.slice(0, maxChars) + writingLanguageText(
    writingLanguage,
    `\n\n…（内容已截断，完整内容共 ${content.length} 字符。可使用 read_file 工具获取完整文件内容）`,
    `\n\n... (Result truncated. The complete content is ${content.length} characters; use read_file to retrieve it.)`,
  )
}
