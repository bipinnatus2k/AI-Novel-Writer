import { afterEach, describe, expect, it, vi } from 'vitest'

import { runAgentLoop } from '../agent-engine'
import type { AgentGenerationResult } from '../agent-engine'
import { toolRegistry } from '../tool-registry'
import { requireAgentProject } from '../tools/project-context'

function registerStartWorkflow(execute = vi.fn(async () => ({ success: true, content: '工作流已登记' }))) {
  toolRegistry.register({
    name: 'start_workflow',
    description: 'test workflow launcher',
    source: 'builtin',
    inputSchema: { type: 'object', properties: {} },
    requiresConfirmation: true,
    isReadOnly: false,
    execute,
  })
  return execute
}

function callbacks(confirmed: boolean) {
  return {
    onTextChunk: vi.fn(),
    onReasoningChunk: vi.fn(),
    onToolCallStart: vi.fn(),
    onToolCallComplete: vi.fn(),
    onToolCallConfirmRequired: vi.fn(async () => confirmed),
    onDone: vi.fn(),
    onError: vi.fn(),
  }
}

afterEach(() => {
  toolRegistry.unregister('start_workflow')
  toolRegistry.unregister('status_probe')
  toolRegistry.unregister('read_blueprint')
  toolRegistry.unregister('list_chapters')
})

describe('Agent structured tool-call loop', () => {
  it('executes a structured tool call and keeps protocol text out of prose', async () => {
    const execute = registerStartWorkflow()
    const sink = callbacks(true)
    const startStatuses: string[] = []
    sink.onToolCallStart.mockImplementation(toolCall => {
      startStatuses.push(toolCall.status)
    })
    const generate = vi.fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ name: 'start_workflow', args: { workflow: 'generate_draft', chapter_number: 1 } }],
      } satisfies AgentGenerationResult)
      .mockResolvedValueOnce({ content: '已开始生成第一章。' })

    await runAgentLoop('system', [], '生成第一章', 'model', generate, sink)

    expect(sink.onToolCallConfirmRequired).toHaveBeenCalledOnce()
    expect(sink.onToolCallStart).toHaveBeenCalledOnce()
    expect(startStatuses).toEqual(['waiting_confirm'])
    expect(sink.onToolCallComplete).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledWith(
      { workflow: 'generate_draft', chapter_number: 1 },
      expect.any(Object),
    )
    expect(sink.onTextChunk).toHaveBeenCalledWith('已开始生成第一章。')
    expect(sink.onTextChunk).not.toHaveBeenCalledWith(expect.stringContaining('start_workflow'))
    expect(sink.onDone).toHaveBeenCalledWith(
      '已开始生成第一章。',
      [expect.objectContaining({
        toolName: 'start_workflow',
        status: 'completed',
      })],
      [],
    )
  })

  it('does not execute a structured write command when the user declines confirmation', async () => {
    const execute = registerStartWorkflow()
    const sink = callbacks(false)
    const startStatuses: string[] = []
    const completionStatuses: string[] = []
    sink.onToolCallStart.mockImplementation(toolCall => {
      startStatuses.push(toolCall.status)
    })
    sink.onToolCallComplete.mockImplementation(toolCall => {
      completionStatuses.push(toolCall.status)
    })
    const generate = vi.fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ name: 'start_workflow', args: { workflow: 'generate_draft', chapter_number: 1 } }],
      } satisfies AgentGenerationResult)
      .mockResolvedValueOnce({ content: '好的，未启动第一章。' })

    await runAgentLoop('system', [], '生成第一章', 'model', generate, sink)

    expect(sink.onToolCallConfirmRequired).toHaveBeenCalledOnce()
    expect(sink.onToolCallStart).toHaveBeenCalledOnce()
    expect(startStatuses).toEqual(['waiting_confirm'])
    expect(sink.onToolCallComplete).toHaveBeenCalledOnce()
    expect(completionStatuses).toEqual(['failed'])
    expect(execute).not.toHaveBeenCalled()
    expect(sink.onTextChunk).toHaveBeenCalledWith('好的，未启动第一章。')
  })

  it('keeps prose with trailing JSON inert even when it names a registered write tool', async () => {
    const execute = registerStartWorkflow()
    const sink = callbacks(true)
    const generate = vi.fn()
      .mockResolvedValueOnce({
        content: '好的，我来启动。\n\n{"name":"start_workflow","arguments":{"workflow":"generate_draft","chapter_number":1}}',
      } satisfies AgentGenerationResult)

    await runAgentLoop('system', [], '生成第一章', 'model', generate, sink)

    expect(generate).toHaveBeenCalledOnce()
    expect(sink.onToolCallConfirmRequired).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(sink.onTextChunk).toHaveBeenCalledWith(
      expect.stringContaining('"start_workflow"'),
    )
  })

  it('starts a non-confirming registered tool exactly once in the running state', async () => {
    const execute = vi.fn(async () => ({ success: true, content: '状态已读取' }))
    toolRegistry.register({
      name: 'status_probe',
      description: 'test read-only status probe',
      source: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      requiresConfirmation: false,
      isReadOnly: true,
      execute,
    })
    const sink = callbacks(true)
    const startStatuses: string[] = []
    sink.onToolCallStart.mockImplementation(toolCall => {
      startStatuses.push(toolCall.status)
    })
    const generate = vi.fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ name: 'status_probe', args: {} }] })
      .mockResolvedValueOnce({ content: '状态已读取。' })

    await runAgentLoop('system', [], '读取状态', 'model', generate, sink)

    expect(sink.onToolCallConfirmRequired).not.toHaveBeenCalled()
    expect(sink.onToolCallStart).toHaveBeenCalledOnce()
    expect(startStatuses).toEqual(['running'])
    expect(sink.onToolCallComplete).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()
  })

  it('keeps reasoning on the dedicated channel and out of prose', async () => {
    toolRegistry.register({
      name: 'status_probe',
      description: 'test read-only status probe',
      source: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      requiresConfirmation: false,
      isReadOnly: true,
      execute: vi.fn(async () => ({ success: true, content: '状态已读取' })),
    })
    const sink = callbacks(true)
    const generate = vi.fn()
      .mockResolvedValueOnce({
        content: '状态已读取。',
        reasoning: '先读取状态再回答。',
      })

    await runAgentLoop('system', [], '读取状态', 'model', generate, sink)

    expect(sink.onReasoningChunk).toHaveBeenCalledWith('先读取状态再回答。')
    expect(sink.onTextChunk).toHaveBeenCalledWith('状态已读取。')
  })

  it('uses the frozen UI locale for tool cards and writing language for model observations', async () => {
    toolRegistry.register({
      name: 'status_probe',
      description: 'test read-only status probe',
      source: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      requiresConfirmation: false,
      isReadOnly: true,
      execute: async (_args, context) => {
        requireAgentProject(context)
        return { success: true, content: 'unreachable' }
      },
    })
    const sink = callbacks(true)
    const generate = vi.fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ name: 'status_probe', args: {} }] })
      .mockResolvedValueOnce({ content: 'The project is not open.' })

    await runAgentLoop(
      'system',
      [],
      'Read the project status',
      'model',
      generate,
      sink,
      undefined,
      {
        projectSession: null,
        selectedModelId: 'model',
        writingLanguage: 'en-US',
        uiLocale: 'zh-CN',
      },
    )

    expect(sink.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: '工具执行失败，请重试。',
    }))
    const secondRequest = generate.mock.calls[1]?.[0] as Array<{ role: string; content: string }>
    const observation = secondRequest.at(-1)?.content ?? ''
    expect(observation).toContain('[The following are tool results. Continue answering the user based on them.]')
    expect(observation).toContain('Tool execution failed.')
    expect(observation).not.toContain('No frozen project session')
    expect(observation).not.toMatch(/[\u3400-\u9fff]/u)
  })

  it('does not expose a failed tool result while keeping its observation in the writing language', async () => {
    toolRegistry.register({
      name: 'status_probe',
      description: 'test read-only status probe',
      source: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      requiresConfirmation: false,
      isReadOnly: true,
      execute: async () => ({
        success: false,
        content: '',
        error: 'provider-secret-result-error',
      }),
    })
    const sink = callbacks(true)
    const generate = vi.fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ name: 'status_probe', args: {} }] })
      .mockResolvedValueOnce({ content: '已了解。' })

    await runAgentLoop(
      'system',
      [],
      '读取状态',
      'model',
      generate,
      sink,
      undefined,
      {
        projectSession: null,
        selectedModelId: 'model',
        writingLanguage: 'zh-CN',
        uiLocale: 'en-US',
      },
    )

    expect(sink.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: 'Tool execution failed. Please try again.',
    }))
    const secondRequest = generate.mock.calls[1]?.[0] as Array<{ role: string; content: string }>
    const observation = secondRequest.at(-1)?.content ?? ''
    expect(observation).toContain('工具执行失败。')
    expect(observation).not.toContain('provider-secret-result-error')
    expect(JSON.stringify(sink.onToolCallComplete.mock.calls)).not.toContain('provider-secret-result-error')
  })

  it('reports provider failures with frozen safe UI copy', async () => {
    const sink = callbacks(true)

    await runAgentLoop(
      'system',
      [],
      '读取状态',
      'model',
      vi.fn(async () => { throw new Error('provider-secret-throw') }),
      sink,
      undefined,
      {
        projectSession: null,
        selectedModelId: 'model',
        writingLanguage: 'zh-CN',
        uiLocale: 'en-US',
      },
    )

    expect(sink.onError).toHaveBeenCalledWith('The AI request failed. Please try again.')
    expect(JSON.stringify(sink.onError.mock.calls)).not.toContain('provider-secret-throw')
  })

  it('uses the frozen UI locale for an aborted run even when the writing language differs', async () => {
    const sink = callbacks(true)
    const controller = new AbortController()
    controller.abort()

    await runAgentLoop(
      'system',
      [],
      '停止',
      'model',
      vi.fn(),
      sink,
      controller.signal,
      {
        projectSession: null,
        selectedModelId: 'model',
        writingLanguage: 'zh-CN',
        uiLocale: 'en-US',
      },
    )

    expect(sink.onDone).toHaveBeenCalledWith('\n\n_(Generation stopped)_', [], [])
  })

  it('keeps English UI errors separate from Chinese model observations', async () => {
    const sink = callbacks(true)
    const generate = vi.fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ name: 'missing_probe', args: {} }] })
      .mockResolvedValueOnce({ content: '已了解。' })

    await runAgentLoop(
      'system',
      [],
      '读取状态',
      'model',
      generate,
      sink,
      undefined,
      {
        projectSession: null,
        selectedModelId: 'model',
        writingLanguage: 'zh-CN',
        uiLocale: 'en-US',
      },
    )

    expect(sink.onToolCallComplete).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: 'Unknown tool: missing_probe',
    }))
    const secondRequest = generate.mock.calls[1]?.[0] as Array<{ role: string; content: string }>
    const observation = secondRequest.at(-1)?.content ?? ''
    expect(observation).toContain('[以下是工具执行结果，请根据结果继续回答用户的问题]')
    expect(observation).not.toContain('The following are tool results')
  })

  it('re-serializes structured tool calls into the conversation history in the taught format', async () => {
    const execute = vi.fn(async () => ({ success: true, content: '蓝图已读取' }))
    toolRegistry.register({
      name: 'status_probe',
      description: 'test read-only status probe',
      source: 'builtin',
      inputSchema: { type: 'object', properties: {} },
      requiresConfirmation: false,
      isReadOnly: true,
      execute,
    })
    const sink = callbacks(true)
    const generate = vi.fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [{ name: 'status_probe', args: {} }] })
      .mockResolvedValueOnce({ content: '蓝图已读取。' })

    await runAgentLoop('system', [], '读取蓝图', 'model', generate, sink)

    const secondRequest = generate.mock.calls[1]?.[0] as Array<{ role: string; content: string }>
    const assistantTurn = secondRequest.filter(m => m.role === 'assistant').at(-1)?.content ?? ''
    expect(assistantTurn).toContain('<tool_call>')
    expect(assistantTurn).toContain('"status_probe"')
    expect(execute).toHaveBeenCalledOnce()
  })
})
