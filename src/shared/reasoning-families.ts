import type { VerifiedReasoningMapping } from './reasoning-types'

/**
 * 模型家族推理推断表 —— 已验证内置映射未命中时的兜底层。
 *
 * 按「协议 + 模型名家族特征」推断推理适配器与档位;中转 baseUrl 也因此
 * 能获得推理选项(家族由模型名决定,与接入点无关)。推断档位带
 * `inferred` 来源标记,与官方端点的已验证映射在 UI 上区分。
 *
 * 顺序即优先级,先命中先赢;default 由调用方表达(不推断、不发参数)。
 */

interface FamilyRule {
  /** 匹配模型名小写形式的片段或前缀;`namePrefix` 为前缀匹配,`nameIncludes` 为包含匹配。 */
  match: { namePrefix?: string; nameIncludes?: string; protocol?: 'openai' | 'gemini' | 'anthropic' }
  mapping: Omit<VerifiedReasoningMapping, 'adapter'> & { adapter: VerifiedReasoningMapping['adapter'] }
}

const ANTHROPIC_BUDGET: Pick<FamilyRule, 'mapping'>['mapping'] = {
  adapter: 'anthropic-thinking-budget',
  supportedEfforts: ['off', 'low', 'medium', 'high'],
  providerValues: { off: 0, low: 2_048, medium: 8_192, high: 24_576 },
}

const GEMINI_BUDGET: Pick<FamilyRule, 'mapping'>['mapping'] = {
  adapter: 'gemini-thinking-budget',
  supportedEfforts: ['off', 'low', 'medium', 'high'],
  providerValues: { off: 0, low: 1_024, medium: 8_192, high: 24_576 },
}

const OPENAI_EFFORT: Pick<FamilyRule, 'mapping'>['mapping'] = {
  adapter: 'openai-reasoning-effort',
  supportedEfforts: ['low', 'medium', 'high'],
  providerValues: { low: 'low', medium: 'medium', high: 'high' },
}

const DEEPSEEK_THINKING: Pick<FamilyRule, 'mapping'>['mapping'] = {
  adapter: 'deepseek-v4-thinking',
  supportedEfforts: ['off', 'low', 'high', 'max'],
  providerValues: { off: 'disabled', low: 'low', high: 'high', max: 'max' },
  requestAliases: { medium: 'high' },
}

const FAMILY_RULES: readonly FamilyRule[] = [
  { match: { nameIncludes: 'deepseek' }, mapping: DEEPSEEK_THINKING },
  { match: { namePrefix: 'claude' }, mapping: ANTHROPIC_BUDGET },
  { match: { protocol: 'anthropic' }, mapping: ANTHROPIC_BUDGET },
  { match: { namePrefix: 'gemini' }, mapping: GEMINI_BUDGET },
  { match: { protocol: 'gemini' }, mapping: GEMINI_BUDGET },
  { match: { namePrefix: 'grok' }, mapping: OPENAI_EFFORT },
  { match: { namePrefix: 'o1' }, mapping: OPENAI_EFFORT },
  { match: { namePrefix: 'o3' }, mapping: OPENAI_EFFORT },
  { match: { namePrefix: 'o4' }, mapping: OPENAI_EFFORT },
  { match: { namePrefix: 'gpt-5' }, mapping: OPENAI_EFFORT },
]

/**
 * 按模型家族推断推理映射;无法识别的家族返回 undefined
 * (调用方回退到「不支持 / 不发送参数」)。
 */
export function inferFamilyReasoningMapping(model: {
  provider?: unknown
  protocol?: unknown
  modelName?: unknown
}): VerifiedReasoningMapping | undefined {
  if (typeof model.protocol !== 'string') return undefined
  const name = typeof model.modelName === 'string' ? model.modelName.trim().toLowerCase() : ''
  if (!name) return undefined

  for (const rule of FAMILY_RULES) {
    const { match, mapping } = rule
    if (match.protocol !== undefined && match.protocol !== model.protocol) continue
    if (match.namePrefix !== undefined && !name.startsWith(match.namePrefix)) continue
    if (match.nameIncludes !== undefined && !name.includes(match.nameIncludes)) continue
    return {
      adapter: mapping.adapter,
      supportedEfforts: [...mapping.supportedEfforts],
      providerValues: { ...mapping.providerValues },
      ...(mapping.requestAliases ? { requestAliases: { ...mapping.requestAliases } } : {}),
    }
  }
  return undefined
}
