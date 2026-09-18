import { registerModelMetadataProbe } from './reasoning-policy'

/**
 * models.dev 快照（@opencode-ai/models/snapshot）的懒加载封装。
 *
 * 快照随包离线分发（数 MB，按需动态导入），提供 220+ 供应商、数千模型的
 * 推理支持标志、上下文/输出上限与成本。加载后向 reasoning-policy 注册探针，
 * 使「已验证内置映射未命中的模型」也能按元数据显示推理选项。
 *
 * 两侧进程（主进程策略执行 / 渲染层设置界面）各自持有实例；加载为
 * 幂等操作，已加载时是 O(1)。
 */

export interface ModelMetadataEntry {
  reasoning?: boolean
  limit?: { context?: number; output?: number }
}

export interface ModelLimits {
  context?: number
  output?: number
}

let index: Map<string, ModelMetadataEntry> | undefined
let loadPromise: Promise<void> | undefined

/** 加载快照并注册探针；幂等。 */
export async function ensureModelMetadataLoaded(): Promise<void> {
  loadPromise ??= (async () => {
    const snapshot = await import('@opencode-ai/models/snapshot')
    const map = new Map<string, ModelMetadataEntry>()
    for (const [key, meta] of Object.entries(snapshot.models as Record<string, ModelMetadataEntry>)) {
      const lower = key.toLowerCase()
      map.set(lower, meta)
      // 'deepseek-ai/DeepSeek-V3.2' 之类带命名空间前缀的键，同时按裸名索引
      const base = lower.includes('/') ? (lower.split('/').pop() ?? lower) : lower
      if (!map.has(base)) map.set(base, meta)
    }
    index = map
    registerModelMetadataProbe(probeModelReasoning)
  })()
  try {
    await loadPromise
  } catch (error) {
    // 快照加载失败不阻塞策略层：回退到「家族推断 / 不支持」
    loadPromise = undefined
    throw error
  }
}

function probeModelMetadata(model: { modelName: string }): ModelMetadataEntry | undefined {
  if (!index) return undefined
  const key = model.modelName.trim().toLowerCase()
  const entry = index.get(key) ?? index.get(key.includes('/') ? (key.split('/').pop() ?? key) : key)
  if (!entry || typeof entry.reasoning !== 'boolean') return undefined
  return entry
}

/** 注册给 reasoning-policy 的探针（仅回答推理支持布尔）。 */
export function probeModelReasoning(model: { modelName: string }): { reasoning: boolean } | undefined {
  const entry = probeModelMetadata(model)
  return entry ? { reasoning: entry.reasoning === true } : undefined
}

/** 按模型名查询上下文/输出上限（未收录返回 undefined）。 */
export function lookupModelLimits(modelName: string): ModelLimits | undefined {
  if (!index) return undefined
  const key = modelName.trim().toLowerCase()
  const entry = index.get(key) ?? index.get(key.includes('/') ? (key.split('/').pop() ?? key) : key)
  return entry?.limit
}
