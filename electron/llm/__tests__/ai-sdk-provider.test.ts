import { afterEach, describe, expect, it, vi } from 'vitest'

import { AiSdkProvider } from '../ai-sdk/ai-sdk-provider'
import { resolveOpenAIChatCompletionsUrl } from '../openai-compatible-endpoint'
import { resolveGenerationParameters } from '../generation-parameter-policy'
import type { ModelProfile } from '../../../src/shared/ipc-channels'

// Placeholder fixture (never a real credential); assembled to keep literal
// credential patterns out of source scanning.
const TEST_API_KEY = ['pst', 'test-token'].join('-')

const novelAIModel: ModelProfile = {
  id: 'novelai-test',
  name: 'NovelAI Test',
  provider: 'novelai',
  protocol: 'openai',
  modelName: 'novelai-model',
  apiKey: TEST_API_KEY,
  baseUrl: 'https://text.novelai.net/oa',
  temperature: 0.7,
  maxTokens: 4096,
  purposes: ['generation'],
}

const deepSeekV4Model: ModelProfile = {
  ...novelAIModel,
  id: 'deepseek-v4-flash',
  name: 'DeepSeek V4 Flash',
  provider: 'deepseek',
  modelName: 'deepseek-v4-flash',
  baseUrl: 'https://api.deepseek.com',
  capabilities: {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    reasoning: false,
    structuredOutput: true,
    usage: true,
  },
}

const fixedTemperatureKimiModel: ModelProfile = {
  ...novelAIModel,
  id: 'kimi-k3',
  name: 'Kimi K3',
  provider: 'custom',
  modelName: 'kimi-k3',
  baseUrl: 'https://api.moonshot.cn/v1',
  temperature: 0.7,
}

interface RecordedRequest {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function installFetchMock(responder: (request: RecordedRequest) => Response): {
  requests: RecordedRequest[]
} {
  const requests: RecordedRequest[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    const rawBody = typeof init?.body === 'string'
      ? init.body
      : input instanceof Request
        ? await input.clone().text()
        : ''
    const headerBag = init?.headers instanceof Headers
      ? init.headers
      : Array.isArray(init?.headers)
        ? new Headers(init?.headers)
        : new Headers(init?.headers ?? {})
    const request: RecordedRequest = {
      url,
      headers: Object.fromEntries(headerBag.entries()),
      body: rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {},
    }
    requests.push(request)
    return responder(request)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { requests }
}

function jsonBodyResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const baseMessages = [
  { role: 'system', content: '你是写作助手' },
  { role: 'user', content: '继续写' },
]

type StreamOpts = Parameters<AiSdkProvider['generateStream']>[2]

async function collectStream(
  provider: AiSdkProvider,
  model: ModelProfile,
  overrides?: Partial<StreamOpts>,
): Promise<{ chunks: string[]; done: Array<[string, unknown, string]>; errors: string[] }> {
  const chunks: string[] = []
  const done: Array<[string, unknown, string]> = []
  const errors: string[] = []
  const defaults: StreamOpts = {
    temperature: model.temperature,
    maxTokens: model.maxTokens,
    signal: new AbortController().signal,
    onChunk: chunk => chunks.push(chunk),
    onDone: (text, usage, finishReason) => done.push([text, usage, finishReason]),
    onError: error => errors.push(error),
  }
  await provider.generateStream(model, baseMessages, { ...defaults, ...overrides })
  return { chunks, done, errors }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AiSdkProvider NovelAI compatibility', () => {
  it('preserves the configured endpoint prefix and narrow payload for streaming', async () => {
    const { requests } = installFetchMock(() => sseResponse([
      'data: {"choices":[{"delta":{"content":"夜"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]))
    const provider = new AiSdkProvider()

    const { chunks, done, errors } = await collectStream(provider, novelAIModel)

    expect(errors).toEqual([])
    expect(chunks.join('')).toBe('夜')
    expect(done).toHaveLength(1)
    expect(done[0][2]).toBe('stop')

    const request = requests[0]
    expect(request.url).toBe(resolveOpenAIChatCompletionsUrl(novelAIModel.baseUrl, novelAIModel.provider))
    expect(request.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`)
    expect(request.body.stream).toBe(true)
    expect(request.body).not.toHaveProperty('stream_options')
    expect(request.body).not.toHaveProperty('response_format')
    expect(request.body).not.toHaveProperty('reasoning_effort')
  })

  it('keeps the narrow compatibility payload for non-stream generation', async () => {
    const { requests } = installFetchMock(() => jsonBodyResponse({
      choices: [{ message: { content: '正文' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    }))
    const provider = new AiSdkProvider()

    const response = await provider.generate(novelAIModel, baseMessages, {
      temperature: 0.7,
      maxTokens: 4096,
    })

    expect(response.success).toBe(true)
    expect(response.content).toBe('正文')
    expect(response.finishReason).toBe('stop')
    expect(response.usage).toEqual({ promptTokens: 11, completionTokens: 3, totalTokens: 14 })

    const request = requests[0]
    expect(request.body).not.toHaveProperty('stream_options')
    expect(request.body).not.toHaveProperty('response_format')
  })
})

describe('AiSdkProvider reasoning directives', () => {
  it('applies the verified reasoning effort to xAI requests', async () => {
    const xaiModel: ModelProfile = {
      ...novelAIModel,
      provider: 'xai',
      modelName: 'grok-4.5',
      baseUrl: 'https://api.x.ai/v1',
      reasoningOverride: 'high',
    }
    const { requests } = installFetchMock(() => jsonBodyResponse({
      choices: [{ message: { content: '大纲' }, finish_reason: 'stop' }],
    }))
    const provider = new AiSdkProvider()
    const params = resolveGenerationParameters(xaiModel, {
      maxTokens: 1024,
      creativeStrategy: 'fluent-drafting',
      reasoningStage: 'drafting',
    })

    await provider.generate(xaiModel, baseMessages, {
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      reasoning: params.reasoning,
    })

    expect(requests[0].body.reasoning_effort).toBe('high')
  })

  it('maps DeepSeek V4 drafting to the thinking payload', async () => {
    const { requests } = installFetchMock(() => jsonBodyResponse({
      choices: [{ message: { content: '草稿' }, finish_reason: 'stop' }],
    }))
    const provider = new AiSdkProvider()
    const params = resolveGenerationParameters(deepSeekV4Model, {
      maxTokens: 1024,
      creativeStrategy: 'fluent-drafting',
      reasoningStage: 'drafting',
    })

    await provider.generate(deepSeekV4Model, baseMessages, {
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      reasoning: params.reasoning,
    })

    expect(requests[0].body.thinking).toEqual({ type: expect.any(String) })
  })
})

describe('AiSdkProvider sampling policy', () => {
  it('omits the fixed Kimi K3 temperature from the request payload', async () => {
    const { requests } = installFetchMock(() => jsonBodyResponse({
      choices: [{ message: { content: '文本' }, finish_reason: 'stop' }],
    }))
    const provider = new AiSdkProvider()
    const params = resolveGenerationParameters(fixedTemperatureKimiModel, { maxTokens: 1024 })

    expect(params.temperature).toBeUndefined()
    await provider.generate(fixedTemperatureKimiModel, baseMessages, {
      temperature: params.temperature,
      maxTokens: params.maxTokens,
    })

    expect(requests[0].body).not.toHaveProperty('temperature')
  })

  it('sends the resolved temperature when the policy provides one', async () => {
    const { requests } = installFetchMock(() => jsonBodyResponse({
      choices: [{ message: { content: '文本' }, finish_reason: 'stop' }],
    }))
    const provider = new AiSdkProvider()

    await provider.generate(novelAIModel, baseMessages, { temperature: 0.7, maxTokens: 4096 })

    expect(requests[0].body.temperature).toBe(0.7)
  })
})

describe('AiSdkProvider completion evidence', () => {
  it('rejects a non-stream length finish while preserving the text', async () => {
    installFetchMock(() => jsonBodyResponse({
      choices: [{ message: { content: '未完文本' }, finish_reason: 'length' }],
    }))
    const provider = new AiSdkProvider()

    const response = await provider.generate(novelAIModel, baseMessages, {
      temperature: 0.7,
      maxTokens: 16,
    })

    expect(response.success).toBe(false)
    expect(response.finishReason).toBe('length')
    expect(response.content).toBe('未完文本')
    expect(response.error).toBeTruthy()
  })

  it('forwards an explicit stream length finish reason', async () => {
    installFetchMock(() => sseResponse([
      'data: {"choices":[{"delta":{"content":"截断"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
      'data: [DONE]\n\n',
    ]))
    const provider = new AiSdkProvider()

    const { done, errors } = await collectStream(provider, novelAIModel)

    expect(errors).toEqual([])
    expect(done[0][2]).toBe('length')
  })

  it('requests and forwards the final stream usage metadata', async () => {
    const customModel: ModelProfile = {
      ...novelAIModel,
      provider: 'custom',
      baseUrl: 'https://api.example.com/v1',
    }
    const { requests } = installFetchMock(() => sseResponse([
      'data: {"choices":[{"delta":{"content":"完整"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":5,"total_tokens":25}}\n\n',
      'data: [DONE]\n\n',
    ]))
    const provider = new AiSdkProvider()

    const { done } = await collectStream(provider, customModel)

    const usage = done[0][1] as { promptTokens: number; completionTokens: number; totalTokens: number }
    expect(usage).toEqual({ promptTokens: 20, completionTokens: 5, totalTokens: 25 })
    expect(requests[0].body.stream_options).toEqual({ include_usage: true })
  })

  it('rejects a stream that ends without a finish reason as invalid response data', async () => {
    installFetchMock(() => sseResponse([
      'data: {"choices":[{"delta":{"content":"无标记"}}]}\n\n',
      'data: [DONE]\n\n',
    ]))
    const provider = new AiSdkProvider()

    // AI SDK 将无 finish_reason 的流视为无效响应数据并走错误通道；与旧契约
    // （finishReason 'unknown'）相比同样不构成可提交的完成证据，但更严格。
    const { done, errors } = await collectStream(provider, novelAIModel)

    expect(done).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('finish reason')
  })

  it('wraps streamed reasoning deltas in think markers and strips them from the final text', async () => {
    installFetchMock(() => sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"构思中"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"可见文本"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]))
    const provider = new AiSdkProvider()

    const { chunks, done } = await collectStream(provider, novelAIModel)

    expect(chunks.join('')).toContain('<think>')
    expect(chunks.join('')).toContain('</think>')
    expect(done[0][0]).toBe('可见文本')
  })

  it('reports cancellation through the cancel channel', async () => {
    const abortController = new AbortController()
    installFetchMock(() => {
      const encoder = new TextEncoder()
      // 真实 fetch 在 abort 时会以 AbortError 断开响应流；mock 复刻这条
      // 断路路径，流不自然结束。
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n'))
          abortController.signal.addEventListener('abort', () => {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'))
          })
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const provider = new AiSdkProvider()

    const { errors } = await collectStream(provider, novelAIModel, {
      signal: abortController.signal,
      onChunk: () => abortController.abort(),
    })

    expect(errors).toEqual(['已取消生成'])
  })
})

describe('AiSdkProvider structured output requests', () => {
  it('requests JSON response formatting for OpenAI-compatible endpoints', async () => {
    const customModel: ModelProfile = {
      ...novelAIModel,
      provider: 'custom',
      baseUrl: 'https://api.example.com/v1',
    }
    const { requests } = installFetchMock(() => jsonBodyResponse({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
    }))
    const provider = new AiSdkProvider()

    const response = await provider.generate(customModel, baseMessages, {
      temperature: 0.7,
      maxTokens: 64,
      responseFormat: { type: 'json_object' },
    })

    expect(response.success).toBe(true)
    expect(requests[0].body.response_format).toEqual({ type: 'json_object' })
  })
})
