import { describe, expect, it } from 'vitest'

import { ProtocolSegmenter, segmentProtocolText } from '../protocol-segmenter'

describe('DSML spacing variants', () => {
  it('parses no-space invoke/closer variants', () => {
    const { toolCalls, content } = segmentProtocolText(
      '<｜｜DSML｜｜invoke name="read_blueprint"><｜｜DSML｜｜parameter name="arguments" string="false">{"chapter_number": 3}</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>',
    )
    expect(toolCalls).toEqual([{ name: 'read_blueprint', args: { chapter_number: 3 } }])
    expect(content).toBe('')
  })

  it('parses mixed spacing (spaced opener, tight closer)', () => {
    const { toolCalls } = segmentProtocolText(
      '<｜｜DSML｜｜ invoke name="write_file"><｜｜DSML｜｜parameter name="path" string="true">drafts/ch3.md</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke>',
    )
    expect(toolCalls).toEqual([{ name: 'write_file', args: { path: 'drafts/ch3.md' } }])
  })

  it('streams a no-space dialect without leaking protocol text', () => {
    const segmenter = new ProtocolSegmenter()
    const raw = '<｜｜DSML｜｜invoke name="list_chapters"></｜｜DSML｜｜invoke>以下是列表。'
    let content = ''
    for (let i = 0; i < raw.length; i += 3) {
      content += segmenter.push(raw.slice(i, i + 3)).content ?? ''
    }
    content += segmenter.finish().content ?? ''
    expect(segmenter.toolCalls).toEqual([{ name: 'list_chapters', args: {} }])
    expect(content).not.toContain('DSML')
    expect(content).toContain('以下是列表。')
  })
})
