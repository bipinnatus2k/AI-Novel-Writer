import type { ModelProfile } from './ipc-channels'
import { resolveModelProfileReasoningMapping } from './provider-presets'
import { inferFamilyReasoningMapping } from './reasoning-families'
import type {
  CreativeStrategy,
  EffectiveReasoningEffort,
  GenerationReasoningStage,
  ProviderReasoningDirective,
  ReasoningEffort,
  ReasoningPolicyResolution,
  VerifiedReasoningMapping,
} from './reasoning-types'
import { CREATIVE_STRATEGIES, REASONING_EFFORTS } from './reasoning-types'

const STAGE_REQUESTS: Readonly<Record<CreativeStrategy, Readonly<Record<GenerationReasoningStage, ReasoningEffort>>>> = {
  auto: { drafting: 'low', planning: 'medium', review: 'high', general: 'low' },
  'fluent-drafting': { drafting: 'off', planning: 'low', review: 'low', general: 'low' },
  'consistency-first': { drafting: 'low', planning: 'high', review: 'high', general: 'medium' },
  'deep-planning': { drafting: 'low', planning: 'max', review: 'high', general: 'medium' },
}

const EFFORT_RANK: Readonly<Record<ReasoningEffort, number>> = {
  off: 0,
  low: 1,
  medium: 2,
  high: 3,
  max: 4,
}

function providerDirective(
  mapping: VerifiedReasoningMapping,
  effective: EffectiveReasoningEffort,
): ProviderReasoningDirective | undefined {
  const value = mapping.providerValues[effective]
  if (mapping.adapter === 'openai-reasoning-effort') {
    return value === 'low' || value === 'medium' || value === 'high'
      ? { adapter: mapping.adapter, reasoningEffort: value }
      : undefined
  }
  if (mapping.adapter === 'deepseek-v4-thinking') {
    if (effective === 'off' && value === 'disabled') {
      return { adapter: mapping.adapter, thinking: 'disabled' }
    }
    return (effective === 'low' || effective === 'high' || effective === 'max') && value === effective
      ? {
          adapter: mapping.adapter,
          thinking: 'enabled',
          reasoningEffort: effective,
        }
      : undefined
  }
  return typeof value === 'number'
    ? { adapter: mapping.adapter, thinkingBudget: value }
    : undefined
}

function closestEffectiveEffort(
  requested: ReasoningEffort,
  mapping: VerifiedReasoningMapping,
): { effective: EffectiveReasoningEffort; status: 'mapped' | 'capped' | 'forced' } | null {
  const documentedAlias = mapping.requestAliases?.[requested]
  if (documentedAlias && mapping.supportedEfforts.includes(documentedAlias)) {
    return { effective: documentedAlias, status: 'mapped' }
  }
  if (mapping.supportedEfforts.includes(requested)) {
    return { effective: requested, status: 'mapped' }
  }
  const supported = [...mapping.supportedEfforts]
    .sort((left, right) => EFFORT_RANK[left] - EFFORT_RANK[right])
  if (supported.length === 0) return null
  if (requested === 'off') return { effective: supported[0], status: 'forced' }

  const lowerOrEqual = supported.filter(effort => EFFORT_RANK[effort] <= EFFORT_RANK[requested])
  return {
    effective: lowerOrEqual.at(-1) ?? supported[0],
    status: 'capped',
  }
}

/**
 * 模型推理映射解析:已验证内置映射(官方端点 + 精确 slug)优先;
 * 未命中时按模型家族推断兜底(中转/发现模型可用,UI 会标注为推断)。
 */
export function resolveModelReasoningMapping(model: ModelProfile): {
  mapping: VerifiedReasoningMapping
  origin: 'verified' | 'inferred'
} | undefined {
  const verified = resolveModelProfileReasoningMapping(model)
  if (verified) return { mapping: verified, origin: 'verified' }
  const inferred = inferFamilyReasoningMapping(model)
  if (inferred) return { mapping: inferred, origin: 'inferred' }
  return undefined
}

/**
 * The single reasoning-policy seam. Callers provide product intent; this
 * module owns profile precedence, verified capability lookup,
 * provider-level capping and the user-visible resolution receipt.
 */
export function resolveReasoningPolicy(input: {
  model: ModelProfile
  creativeStrategy?: CreativeStrategy
  stage?: GenerationReasoningStage
}): ReasoningPolicyResolution {
  const strategy = CREATIVE_STRATEGIES.includes(input.creativeStrategy as CreativeStrategy)
    ? input.creativeStrategy as CreativeStrategy
    : 'auto'
  const persistedOverride = input.model.reasoningOverride
  const override = persistedOverride === 'auto'
    || REASONING_EFFORTS.includes(persistedOverride as ReasoningEffort)
    ? persistedOverride ?? 'auto'
    : 'auto'
  const source = override === 'auto' ? 'project-strategy' : 'model-override'
  const requested = override === 'auto'
    ? STAGE_REQUESTS[strategy][input.stage ?? 'general']
    : override
  const resolvedMapping = resolveModelReasoningMapping(input.model)
  if (!resolvedMapping) return { requested, effective: null, status: 'unsupported', source }

  const resolved = closestEffectiveEffort(requested, resolvedMapping.mapping)
  if (!resolved) return { requested, effective: null, status: 'unsupported', source }
  const directive = providerDirective(resolvedMapping.mapping, resolved.effective)
  if (!directive) return { requested, effective: null, status: 'unsupported', source }
  return {
    requested,
    effective: resolved.effective,
    status: resolvedMapping.origin === 'inferred'
      ? resolved.status === 'mapped' ? 'inferred' : resolved.status
      : resolved.status,
    source,
    providerDirective: directive,
  }
}
