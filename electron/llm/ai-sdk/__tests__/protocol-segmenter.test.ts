import { describe, expect, it } from 'vitest'

import { ProtocolSegmenter } from '../protocol-segmenter'

// 从用户日志还原的真实模型输出（SiliconFlow DeepSeek,教授格式 + reasoning 通道混合）
const REAL_OUTPUT = [
  '我先在项目资料里查一下。《风纪日志》的出处。',
  '',
  '<tool_call>',
  '{"name": "search_knowledge", "arguments": {"query": "《风纪日志》的出处", "top_k": 8}}',
  '</tool_call>',
].join('\n')

describe('protocol segmenter against real model output', () => {
  it('extracts the taught tool_call from fine-grained streaming chunks', () => {
    const s = new ProtocolSegmenter()
    let content = ''
    // 2 字符细粒度切片,复现真实流的截断粒度
    for (let i = 0; i < REAL_OUTPUT.length; i += 2) {
      content += s.push(REAL_OUTPUT.slice(i, i + 2)).content ?? ''
    }
    content += s.finish().content ?? ''

    expect(s.toolCalls).toEqual([
      { name: 'search_knowledge', args: { query: '《风纪日志》的出处', top_k: 8 } },
    ])
    expect(content).not.toContain('<tool_call')
    expect(content).not.toContain('search_knowledge')
    expect(content.trim()).toBe('我先在项目资料里查一下。《风纪日志》的出处。')
  })

  it('holds partial openers across chunk boundaries regardless of marker length', () => {
    // 回归:holdback 窗口曾固定为 9 字符,导致 11 字符的 <tool_call> opener
    // 在跨 chunk 截断时前缀无法识别、整块泄漏为正文
    const s = new ProtocolSegmenter()
    let content = ''
    const raw = '前文。\n<tool_call>\n{"name": "read_blueprint", "arguments": {}}\n</tool_call>\n后文。'
    for (let i = 0; i < raw.length; i += 1) {
      content += s.push(raw.slice(i, i + 1)).content ?? ''
    }
    content += s.finish().content ?? ''

    expect(s.toolCalls).toEqual([{ name: 'read_blueprint', args: {} }])
    expect(content).not.toContain('<tool_call')
    expect(content.replace(/\n{2,}/u, '\n')).toBe('前文。\n后文。')
  })
})
