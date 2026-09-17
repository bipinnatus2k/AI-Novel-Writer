import { describe, expect, it } from 'vitest'

import { ProtocolSegmenter, segmentProtocolText } from '../protocol-segmenter'

/** 把整段文本按指定宽度切成增量依次喂入，模拟流式截断。 */
function streamInChunks(text: string, width = 3): { content: string; reasoning: string; toolCalls: ReturnType<typeof segmentProtocolText>['toolCalls'] } {
  const segmenter = new ProtocolSegmenter()
  let content = ''
  let reasoning = ''
  for (let index = 0; index < text.length; index += width) {
    const delta = segmenter.push(text.slice(index, index + width))
    content += delta.content ?? ''
    reasoning += delta.reasoning ?? ''
  }
  const flushed = segmenter.finish()
    content += flushed.content ?? ''
    reasoning += flushed.reasoning ?? ''
  return { content, reasoning, toolCalls: segmenter.toolCalls }
}

describe('ProtocolSegmenter', () => {
  it('parses the SiliconFlow double-bar DSML dialect (calls/invoke/parameter)', () => {
    const raw = [
      '好的，我先读取第 3 章蓝图。',
      '<｜｜DSML｜｜ calls>',
      '<｜｜DSML｜｜ invoke name="read_blueprint">',
      '<｜｜DSML｜｜ parameter name="arguments" string="false">{"chapter_number": 3}</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>',
      '</｜｜DSML｜｜ calls>',
    ].join('\n')

    const result = segmentProtocolText(raw)

    expect(result.content).toBe('好的，我先读取第 3 章蓝图。')
    expect(result.toolCalls).toEqual([
      { name: 'read_blueprint', args: { chapter_number: 3 } },
    ])
  })

  it('keeps streaming output clean when the dialect is split across chunks', () => {
    const raw = [
      '先查蓝图。',
      '<｜｜DSML｜｜ calls>',
      '<｜｜DSML｜｜ invoke name="read_blueprint">',
      '<｜｜DSML｜｜ parameter name="arguments" string="false">{"chapter_number": 3}</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>',
      '</｜｜DSML｜｜ calls>',
      '读完了。',
    ].join('\n')

    const { content, reasoning, toolCalls } = streamInChunks(raw, 2)

    expect(content.replace(/\n{2,}/u, '\n')).toBe('先查蓝图。\n读完了。')
    expect(content).not.toContain('DSML')
    expect(content).not.toContain('invoke')
    expect(reasoning).toBe('')
    expect(toolCalls).toEqual([
      { name: 'read_blueprint', args: { chapter_number: 3 } },
    ])
  })

  it('parses a bare double-bar invoke without the calls wrapper and resumes prose afterwards', () => {
    const raw = '<｜｜DSML｜｜ invoke name="list_chapters"></｜｜DSML｜｜ invoke>\n以下是章节列表。'
    const { content, toolCalls } = segmentProtocolText(raw)

    expect(toolCalls).toEqual([{ name: 'list_chapters', args: {} }])
    expect(content).toBe('以下是章节列表。')
  })

  it('treats string="true" parameters as raw strings and string="false" as JSON with fallback', () => {
    const raw = [
      '<｜｜DSML｜｜ invoke name="write_file">',
      '<｜｜DSML｜｜ parameter name="path" string="true">drafts/ch3.md</｜｜DSML｜｜ parameter>',
      '<｜｜DSML｜｜ parameter name="count" string="false">3</｜｜DSML｜｜ parameter>',
      '<｜｜DSML｜｜ parameter name="broken" string="false">{invalid</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>',
    ].join('\n')

    const { toolCalls } = segmentProtocolText(raw)

    expect(toolCalls).toEqual([
      { name: 'write_file', args: { path: 'drafts/ch3.md', count: 3, broken: '{invalid' } },
    ])
  })

  it('separates inline think blocks from content and keeps reasoning out of the body', () => {
    const raw = '<think>先想一下章节结构</think>正文第一段。'
    const { content, reasoning, toolCalls } = segmentProtocolText(raw)

    expect(reasoning).toBe('先想一下章节结构')
    expect(content).toBe('正文第一段。')
    expect(toolCalls).toEqual([])
  })

  it('treats an unclosed think block as reasoning when the stream ends', () => {
    const { content, reasoning } = streamInChunks('正文之前<think>还在构思', 4)
    expect(reasoning).toBe('还在构思')
    expect(content).toBe('正文之前')
  })

  it('keeps reasoning streaming incremental while a think block is open', () => {
    const segmenter = new ProtocolSegmenter()
    const first = segmenter.push('<think>第一段推理')
    const second = segmenter.push('第二段推理')
    const done = segmenter.finish()

    expect((first.reasoning ?? '') + (second.reasoning ?? '') + (done.reasoning ?? '')).toBe('第一段推理第二段推理')
    expect((first.content ?? '') + (second.content ?? '') + (done.content ?? '')).not.toContain('推理')
  })

  it('parses the single-bar DSML and standard XML tool_call dialects', () => {
    const singleBar = segmentProtocolText('<｜DSML｜tool_call>\n{"name":"read_blueprint","arguments":{"chapter_number":2}}\n</｜DSML｜tool_call>')
    expect(singleBar.toolCalls).toEqual([{ name: 'read_blueprint', args: { chapter_number: 2 } }])
    expect(singleBar.content).toBe('')

    const xml = segmentProtocolText('前文。<tool_call>{"name":"list_chapters","arguments":{}}</tool_call>')
    expect(xml.toolCalls).toEqual([{ name: 'list_chapters', args: {} }])
    expect(xml.content).toBe('前文。')
  })

  it('parses the name/arguments child-tag variant inside tool_call', () => {
    const raw = '<tool_call>\n<name>list_chapters</name>\n<arguments>\n{}\n</arguments>\n</tool_call>'
    const { toolCalls, content } = segmentProtocolText(raw)
    expect(toolCalls).toEqual([{ name: 'list_chapters', args: {} }])
    expect(content).toBe('')
  })

  it('parses an empty child-tag no-argument call', () => {
    const { toolCalls } = segmentProtocolText('<tool_call><read_blueprint></read_blueprint></tool_call>')
    expect(toolCalls).toEqual([{ name: 'read_blueprint', args: {} }])
  })

  it('recognizes whole-response raw name-plus-JSON and strict JSON envelope forms', () => {
    const raw = segmentProtocolText('start_workflow\n{"workflow":"generate_draft","chapter_number":1}')
    expect(raw.toolCalls).toEqual([
      { name: 'start_workflow', args: { workflow: 'generate_draft', chapter_number: 1 } },
    ])
    expect(raw.content).toBe('')

    const envelope = segmentProtocolText('{"name": "read_blueprint", "arguments": {"chapter_number": 2}}')
    expect(envelope.toolCalls).toEqual([{ name: 'read_blueprint', args: { chapter_number: 2 } }])
  })

  it('keeps prose with trailing or extra-key JSON inert', () => {
    const trailing = segmentProtocolText('好的，我来启动。\n\n{"name":"start_workflow","args":{"workflow":"generate_draft"}}')
    expect(trailing.toolCalls).toEqual([])
    expect(trailing.content).toContain('好的，我来启动。')

    const extraKeys = segmentProtocolText('{"name":"read_blueprint","arguments":{},"comment":"run this"}')
    expect(extraKeys.toolCalls).toEqual([])

    const malformed = segmentProtocolText('<｜DSML｜tool_call>not-json</｜DSML｜tool_call>')
    expect(malformed.toolCalls).toEqual([])
    expect(malformed.content).toBe('')
  })
})
