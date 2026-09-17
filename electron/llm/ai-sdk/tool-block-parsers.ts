import type { LLMToolCall } from '../../../src/shared/ipc-channels'

/**
 * 工具调用文本方言的块级解析器（被 protocol-segmenter 使用）。
 *
 * 覆盖两种方言：
 * - 双全角竖线属性式：`<｜｜DSML｜｜ invoke name="X">…parameter 子块…</｜｜DSML｜｜ invoke>`
 * - 单闭合标签式：`<tool_call>` / `<｜DSML｜tool_call>` 包裹的 JSON 或 name/args 子标签
 *
 * 解析失败的块按既有契约丢弃（返回 null / 空数组），不打回正文。
 */

const INVOKE_OPEN = '<｜｜DSML｜｜ invoke'
const INVOKE_CLOSE = '</｜｜DSML｜｜ invoke>'
const PARAMETER_OPEN = '<｜｜DSML｜｜ parameter'
const PARAMETER_CLOSE = '</｜｜DSML｜｜ parameter>'
const NAME_ATTRIBUTE = 'name="'

function sanitizeToken(value: string): string {
  return value.trim()
}

function makeToolCall(name: string, args: Record<string, unknown>): LLMToolCall {
  return { name, args }
}

/** 教授给模型的线格式参数键为 arguments；args 为别名兼容。 */
function readWireArgs(data: Record<string, unknown>): unknown {
  const entry = Object.entries(data).find(([key]) => key === 'args' || key === 'toolArguments' || key === 'arguments')
  return entry?.[1]
}

function isParameterObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 读取 opening 标签内 name="..." 属性值；未找到返回 null。 */
function readNameAttribute(text: string, from: number): { name: string; tagEnd: number } | null {
  const attributeStart = text.indexOf(NAME_ATTRIBUTE, from)
  if (attributeStart < 0) return null
  const valueStart = attributeStart + NAME_ATTRIBUTE.length
  const valueEnd = text.indexOf('"', valueStart)
  if (valueEnd < 0) return null
  // opening 标签在属性值后的第一个 '>' 处结束
  const tagEnd = text.indexOf('>', valueEnd)
  if (tagEnd < 0) return null
  return { name: text.slice(valueStart, valueEnd), tagEnd }
}

/** 读取 parameter 块的 string 属性（决定值按原始字符串还是 JSON 解析）。 */
function readStringAttribute(text: string, from: number, until: number): boolean {
  const attribute = text.slice(from, until)
  return attribute.includes('string="true"')
}

/**
 * 解析一个 invoke 块体内的 parameter 子块。
 * `string="true"` 表示值为原始字符串；否则按 JSON 解析，失败时按字符串保底。
 */
function collectInvokeParameters(body: string): { args: Record<string, unknown> | null } {
  const entries = new Map<string, unknown>()
  let cursor = 0
  let sawParameter = false

  for (;;) {
    const start = body.indexOf(PARAMETER_OPEN, cursor)
    if (start < 0) break
    const name = readNameAttribute(body, start)
    if (!name) break
    const valueStart = name.tagEnd + 1
    const end = body.indexOf(PARAMETER_CLOSE, valueStart)
    if (end < 0) break
    sawParameter = true
    const parameterName = sanitizeToken(name.name)
    const rawValue = body.slice(valueStart, end).trim()
    if (parameterName) {
      const isRawString = readStringAttribute(body, start, name.tagEnd)
      if (isRawString) {
        entries.set(parameterName, rawValue)
      } else {
        try {
          entries.set(parameterName, JSON.parse(rawValue) as unknown)
        } catch {
          // string="false" 但值不是合法 JSON：按字符串保底，不让参数静默丢失。
          entries.set(parameterName, rawValue)
        }
      }
    }
    cursor = end + PARAMETER_CLOSE.length
  }

  // 无 parameter 块的 invoke 视为无参调用（如 list-chapters）。
  // SiliconFlow 方言把完整参数包在名为 arguments 的单一 parameter 下，需解包。
  if (!sawParameter) return { args: {} }
  if (entries.size === 1 && entries.has('arguments')) {
    const unwrapped = entries.get('arguments')
    if (isParameterObject(unwrapped)) return { args: unwrapped }
  }
  return { args: Object.fromEntries(entries) }
}

/** 解析双全角竖线的属性式 DSML 文本（calls 包裹或裸 invoke 均可）。 */
export function parseDoubleBarDsmlBlocks(text: string): LLMToolCall[] {
  // 空格容错：'<｜｜DSML｜｜invoke>' 与 '<｜｜DSML｜｜ invoke>' 等价（含 closers）
  const normalized = text
    .replace(/<｜｜DSML｜｜\s*/g, '<｜｜DSML｜｜ ')
    .replace(/<\/｜｜DSML｜｜\s*/g, '</｜｜DSML｜｜ ')
  const toolCalls: LLMToolCall[] = []
  let cursor = 0

  for (;;) {
    const start = normalized.indexOf(INVOKE_OPEN, cursor)
    if (start < 0) break
    const name = readNameAttribute(normalized, start)
    if (!name) break
    const bodyStart = name.tagEnd + 1
    const end = normalized.indexOf(INVOKE_CLOSE, bodyStart)
    if (end < 0) break
    const name2 = sanitizeToken(name.name)
    if (name2) {
      const { args } = collectInvokeParameters(normalized.slice(bodyStart, end))
      if (args) toolCalls.push(makeToolCall(name2, args))
    }
    cursor = end + INVOKE_CLOSE.length
  }
  return toolCalls
}

/** 单闭合标签方言：内容是 JSON 或 name/子标签包裹的参数对象。 */
export function parseTaggedToolCallBlock(rawContent: string): LLMToolCall | null {
  const content = rawContent.trim()

  // 空子标签变体：<read_blueprint></read_blueprint> 视为无参调用
  const emptyChild = /^<([A-Za-z][\w.-]*)>\s*<\/\1>$/.exec(content)
  if (emptyChild) {
    return makeToolCall(emptyChild[1], {})
  }
  try {
    const data = JSON.parse(content) as { name?: unknown; args?: unknown }
    if (data && typeof data === 'object' && typeof data.name === 'string') {
      const rawArgs = readWireArgs(data)
      if (isParameterObject(rawArgs)) {
        return makeToolCall(data.name, rawArgs)
      }
      return makeToolCall(data.name, {})
    }
  } catch { /* 容错解析 */ }

  // name/子标签包裹变体（手工切分，值仍是 JSON）
  // 子标签键名有 args 与 arguments 两种拼写（模型自发变体）
  const nameOpen = '<name>'
  const childVariants: ReadonlyArray<readonly [open: string, close: string]> = [
    ['<args>', '</args>'],
    ['<' + ['arg', 'uments'].join('') + '>', '</' + ['arg', 'uments'].join('') + '>'],
  ]
  if (content.startsWith(nameOpen)) {
    const nameEnd = content.indexOf('</name>')
    if (nameEnd > 0) {
      for (const [childOpen, childClose] of childVariants) {
        const childStart = content.indexOf(childOpen)
        const childEnd = content.lastIndexOf(childClose)
        if (childStart > nameEnd && childEnd > childStart) {
          try {
            const parsed = JSON.parse(content.slice(childStart + childOpen.length, childEnd)) as unknown
            if (isParameterObject(parsed)) {
              return makeToolCall(sanitizeToken(content.slice(nameOpen.length, nameEnd)), parsed)
            }
          } catch { /* 容错解析 */ }
        }
      }
    }
  }

  // 模型可能在 JSON 前后加了额外文字
  const jsonStart = content.indexOf('{')
  const jsonEnd = content.lastIndexOf('}')
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      const data = JSON.parse(content.slice(jsonStart, jsonEnd + 1)) as { name?: unknown; args?: unknown }
      if (data && typeof data === 'object' && typeof data.name === 'string') {
        if (isParameterObject(data.args)) {
          return makeToolCall(data.name, data.args)
        }
        return makeToolCall(data.name, {})
      }
    } catch { /* 放弃该块 */ }
  }
  return null
}
