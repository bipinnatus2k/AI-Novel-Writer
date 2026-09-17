import type { LLMToolCall } from '../../../src/shared/ipc-channels'
import { parseDoubleBarDsmlBlocks, parseTaggedToolCallBlock } from './tool-block-parsers'
import { parseWholeResponseToolCall } from './whole-response-parser'

/**
 * 协议感知的流式分段器 —— 传输层唯一拥有「模型文本方言」知识的地方。
 *
 * 从文本增量中分离三类内容：
 * - reasoning：`<think>...</think>` 内联推理块（未闭合时按推理处理）
 * - content：普通可见正文
 * - toolCalls：工具调用方言块（解析逻辑见 tool-block-parsers / whole-response-parser）
 *
 * 支持的方言（与系统提示中教授的调用格式及各家模型自发格式对齐）：
 * - `<｜｜DSML｜｜ calls/invoke/parameter ...>`（SiliconFlow DeepSeek 属性式，双全角竖线）
 * - `<｜DSML｜tool_call>`（单全角竖线 JSON 式）
 * - `<tool_call>`（标准 XML JSON 式）
 * - 整段响应式：裸 name+JSON 两行式，或恰含 name/arguments 的单 JSON 对象
 *
 * 方言块解析失败时按既有契约丢弃，不打回正文。
 */

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

const DSML_DOUBLE_OPEN = '<｜｜DSML｜｜'
const DSML_CALLS_CLOSE = '</｜｜DSML｜｜ calls>'

/** 单闭合标签的方言（opener → closer）。 */
const TAGGED_OPENERS: ReadonlyArray<readonly [opener: string, closer: string]> = [
  ['<｜DSML｜tool_call>', '</｜DSML｜tool_call>'],
  ['<tool_call>', '</tool_call>'],
]

const ALL_OPENERS: readonly string[] = [DSML_DOUBLE_OPEN, THINK_OPEN, ...TAGGED_OPENERS.map(([opener]) => opener)]

/** 判断文本尾部是否存在某个标记的未完成前缀（跨 chunk 截断保护）。 */
function longestMarkerPrefixSuffix(buffer: string): string {
  const windowLength = Math.min(buffer.length, DSML_DOUBLE_OPEN.length)
  const window = buffer.slice(buffer.length - windowLength)
  for (let length = window.length; length > 0; length -= 1) {
    const suffix = window.slice(window.length - length)
    for (const marker of ALL_OPENERS) {
      if (marker.startsWith(suffix)) return suffix
    }
    if (THINK_CLOSE.startsWith(suffix)) return suffix
  }
  return ''
}

type SegmenterMode = 'text' | 'think' | 'tagged-block' | 'dsml-double'

export interface SegmentedDelta {
  reasoning?: string
  content?: string
}

export class ProtocolSegmenter {
  private mode: SegmenterMode = 'text'
  private buffer = ''
  private taggedCloser = ''
  /** 双竖线缓冲中已完成解析的字符游标（防止同一 invoke 被重复解析）。 */
  private dsmlParsedUpTo = 0
  /** 整段便捷模式：push 只缓冲，finish 时一次性判定（支持整段响应式方言）。 */
  private readonly bufferAll: boolean
  private readonly reasoningParts: string[] = []
  private readonly contentParts: string[] = []
  private readonly collectedToolCalls: LLMToolCall[] = []

  constructor(options: { bufferAll?: boolean } = {}) {
    this.bufferAll = options.bufferAll ?? false
  }

  /** 已解析出的工具调用（流结束前随时可读，一般取自 finish 之后）。 */
  get toolCalls(): LLMToolCall[] {
    return this.collectedToolCalls
  }

  get reasoningText(): string {
    return this.reasoningParts.join('')
  }

  /** 喂入一个文本增量，返回本次可安全外发的分段。 */
  push(delta: string): SegmentedDelta {
    this.buffer += delta
    if (this.bufferAll) return {}
    return this.drain(false)
  }

  /** 流结束：冲洗缓冲；未闭合的 think 按推理、未闭合的工具块按方言尽力解析。 */
  finish(): SegmentedDelta {
    const result: SegmentedDelta = {}

    // 整段便捷模式：先判「整个回复就是一次工具调用」的方言，命中则不外发正文
    if (this.bufferAll && this.mode === 'text' && this.buffer) {
      const whole = parseWholeResponseToolCall(this.buffer)
      if (whole) {
        this.collectedToolCalls.push(whole)
        this.buffer = ''
        this.mode = 'text'
        return result
      }
    }

    const drained = this.drain(true)
    // drain 内部已把分段推入 reasoningParts/contentParts，这里只透传结果
    result.reasoning = drained.reasoning
    result.content = drained.content

    if (this.buffer) {
      if (this.mode === 'think') {
        this.emit(result, this.buffer, undefined)
      } else if (this.mode === 'tagged-block') {
        const call = parseTaggedToolCallBlock(this.buffer)
        if (call) this.collectedToolCalls.push(call)
        else this.emit(result, undefined, this.buffer)
      } else if (this.mode === 'dsml-double') {
        const tail = this.buffer.slice(this.dsmlParsedUpTo)
        this.collectedToolCalls.push(...parseDoubleBarDsmlBlocks(tail))
      } else {
        this.emit(result, undefined, this.buffer)
      }
      this.buffer = ''
      this.mode = 'text'
    }
    return result
  }

  private emit(result: SegmentedDelta, reasoning: string | undefined, content: string | undefined): void {
    if (reasoning) {
      this.reasoningParts.push(reasoning)
      result.reasoning = (result.reasoning ?? '') + reasoning
    }
    if (content) {
      this.contentParts.push(content)
      result.content = (result.content ?? '') + content
    }
  }

  /** 双竖线区域：解析缓冲内全部已闭合 invoke，返回「协议区是否已终结」。 */
  private drainDsmlDouble(final: boolean, result: SegmentedDelta): boolean {
    // 容忍空格差异：扫描全部闭合标签，跟踪最后一个 invoke 闭合的位置
    // （跳过 parameter/calls 等内层闭合）
    const closeBase = '</｜｜DSML｜｜'
    let search = this.dsmlParsedUpTo
    let lastInvokeEnd = this.dsmlParsedUpTo
    for (;;) {
      const base = this.buffer.indexOf(closeBase, search)
      if (base < 0) break
      const tagEnd = this.buffer.indexOf('>', base)
      if (tagEnd < 0) break
      const inner = this.buffer.slice(base + closeBase.length, tagEnd).trim()
      if (inner === 'invoke') {
        lastInvokeEnd = tagEnd + 1
      }
      search = tagEnd + 1
    }
    if (lastInvokeEnd > this.dsmlParsedUpTo) {
      const region = this.buffer.slice(this.dsmlParsedUpTo, lastInvokeEnd)
      this.collectedToolCalls.push(...parseDoubleBarDsmlBlocks(region))
      this.dsmlParsedUpTo = lastInvokeEnd
    }

    // calls 包裹的闭合已完整到达 → 协议区终结
    const callsCloseIndex = this.buffer.indexOf(DSML_CALLS_CLOSE, this.dsmlParsedUpTo)
    if (callsCloseIndex >= 0) {
      this.buffer = this.buffer.slice(callsCloseIndex + DSML_CALLS_CLOSE.length)
      this.dsmlParsedUpTo = 0
      this.mode = 'text'
      return true
    }

    if (!final) {
      const tail = this.buffer.slice(this.dsmlParsedUpTo).trimStart()
      if (tail === '') return false
      if (tail.startsWith(DSML_DOUBLE_OPEN) || tail.startsWith(DSML_CALLS_CLOSE) || DSML_CALLS_CLOSE.startsWith(tail)) return false
      // invoke 之后已是正文：退出协议区，剩余交回 text 模式
      this.buffer = this.buffer.slice(this.dsmlParsedUpTo)
      this.dsmlParsedUpTo = 0
      this.mode = 'text'
      return false
    }

    // 流结束：残尾非协议文本外发为正文；协议残渣丢弃
    this.collectedToolCalls.push(...parseDoubleBarDsmlBlocks(this.buffer.slice(this.dsmlParsedUpTo)))
    const lastInvoke = this.buffer.lastIndexOf('</｜｜DSML｜｜ invoke>')
    const trailing = lastInvoke >= 0 ? this.buffer.slice(lastInvoke + '</｜｜DSML｜｜ invoke>'.length) : ''
    if (trailing.trim()) this.emit(result, undefined, trailing)
    this.buffer = ''
    this.dsmlParsedUpTo = 0
    this.mode = 'text'
    return true
  }
  private drain(final: boolean): SegmentedDelta {
    const result: SegmentedDelta = {}

    for (;;) {
      if (!this.buffer) return result

      if (this.mode === 'think') {
        const closeIndex = this.buffer.indexOf(THINK_CLOSE)
        if (closeIndex >= 0) {
          this.emit(result, this.buffer.slice(0, closeIndex), undefined)
          this.buffer = this.buffer.slice(closeIndex + THINK_CLOSE.length)
          this.mode = 'text'
          continue
        }
        if (final) {
          this.emit(result, this.buffer, undefined)
          this.buffer = ''
          this.mode = 'text'
          return result
        }
        // 保留可能是关闭标记前缀的尾部
        const holdBack = Math.min(this.buffer.length, THINK_CLOSE.length - 1)
        const safe = this.buffer.slice(0, this.buffer.length - holdBack)
        this.buffer = this.buffer.slice(this.buffer.length - holdBack)
        this.emit(result, safe, undefined)
        return result
      }

      if (this.mode === 'tagged-block') {
        const closeIndex = this.buffer.indexOf(this.taggedCloser)
        if (closeIndex >= 0) {
          const call = parseTaggedToolCallBlock(this.buffer.slice(0, closeIndex))
          if (call) this.collectedToolCalls.push(call)
          this.buffer = this.buffer.slice(closeIndex + this.taggedCloser.length)
          this.mode = 'text'
          continue
        }
        if (!final) return result // 工具块整体缓冲，不外发
        const call = parseTaggedToolCallBlock(this.buffer)
        if (call) this.collectedToolCalls.push(call)
        this.buffer = ''
        this.mode = 'text'
        return result
      }

      if (this.mode === 'dsml-double') {
        const exited = this.drainDsmlDouble(final, result)
        if (!exited) return result
        continue
      }

      // text 模式：寻找最早的协议开启标记
      let openIndex = -1
      let opener = ''
      for (const candidate of ALL_OPENERS) {
        const index = this.buffer.indexOf(candidate)
        if (index >= 0 && (openIndex < 0 || index < openIndex)) {
          openIndex = index
          opener = candidate
        }
      }

      if (openIndex < 0) {
        if (final) {
          this.emit(result, undefined, this.buffer)
          this.buffer = ''
          return result
        }
        // 无协议标记：扣留可能是 opener 前缀的尾部，防止跨 chunk 截断
        const hold = longestMarkerPrefixSuffix(this.buffer)
        const safe = hold ? this.buffer.slice(0, this.buffer.length - hold.length) : this.buffer
        this.buffer = hold
        if (safe) this.emit(result, undefined, safe)
        return result
      }

      this.emit(result, undefined, this.buffer.slice(0, openIndex))
      this.buffer = this.buffer.slice(openIndex)

      if (opener === THINK_OPEN) {
        this.buffer = this.buffer.slice(THINK_OPEN.length)
        this.mode = 'think'
        continue
      }
      if (opener === DSML_DOUBLE_OPEN) {
        // opener 保留在缓冲内，dsml-double 区域按完整 invoke 块解析
        this.mode = 'dsml-double'
        continue
      }
      const tagged = TAGGED_OPENERS.find(([tagOpener]) => tagOpener === opener)
      if (tagged) {
        this.buffer = this.buffer.slice(opener.length)
        this.taggedCloser = tagged[1]
        this.mode = 'tagged-block'
        continue
      }
    }
  }
}

/** 非流式便捷入口：整段文本一次分段。 */
export function segmentProtocolText(text: string): {
  reasoning: string
  content: string
  toolCalls: LLMToolCall[]
} {
  // bufferAll：整段响应式方言只有在流结束时才能判定，必须全量缓冲
  const segmenter = new ProtocolSegmenter({ bufferAll: true })
  segmenter.push(text)
  const finished = segmenter.finish()
  return {
    reasoning: segmenter.reasoningText.trim(),
    content: (finished.content ?? '').trim(),
    toolCalls: segmenter.toolCalls,
  }
}
