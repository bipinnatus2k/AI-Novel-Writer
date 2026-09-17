import type { LLMToolCall } from '../../../src/shared/ipc-channels'
import { parseTaggedToolCallBlock } from './tool-block-parsers'

function isParameterObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 整段响应式方言：整个回复就是一次工具调用。两种形态：
 * - 裸两行式：第一行是已注册工具名，第二行是参数 JSON
 * - 单 JSON 对象式：恰好含 name 与 arguments 两个键（多余键视为散文，不执行）
 *
 * 任何前后散文都会使其失效；该解析无注册表感知，未知工具由 Agent 循环
 * 的未知工具守卫按失败观察处理。
 */
export function parseWholeResponseToolCall(text: string): LLMToolCall | null {
  const content = text.trim()

  // 单 JSON 对象式：严格两键
  if (content.startsWith('{') && content.endsWith('}')) {
    try {
      const value = JSON.parse(content) as Record<string, unknown>
      const keys = Object.keys(value)
      const name = value.name
      if (keys.length === 2 && keys.includes('name') && keys.includes('arguments') && typeof name === 'string') {
        const args = value.arguments
        if (isParameterObject(args)) return { name, args }
        return { name, args: {} }
      }
    } catch { /* 非整段 JSON，继续两行式 */ }
  }

  // 裸两行式：name 行 + 参数 JSON 行
  const newlineIndex = content.indexOf('\n')
  if (newlineIndex > 0) {
    const name = content.slice(0, newlineIndex).trim()
    const rawArgs = content.slice(newlineIndex + 1).trim()
    if (/^[A-Za-z][\w.-]*$/.test(name) && rawArgs.startsWith('{') && rawArgs.endsWith('}')) {
      try {
        const args = JSON.parse(rawArgs) as unknown
        if (isParameterObject(args)) return { name, args }
        return { name, args: {} }
      } catch { /* 两行式参数非法，放弃 */ }
    }
  }
  return null
}

/** 便于复用：单闭合标签方言的块级解析透传。 */
export function parseTaggedToolCall(text: string): LLMToolCall | null {
  return parseTaggedToolCallBlock(text)
}
