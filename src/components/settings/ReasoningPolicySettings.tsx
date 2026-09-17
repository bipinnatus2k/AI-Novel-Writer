import { useEffect, useState } from 'react'

import type { ModelProfile } from '../../shared/ipc-channels'
import { projectSessionContextFromProject } from '../../shared/project-session-context'
import { resolveModelReasoningMapping, resolveReasoningPolicy } from '../../shared/reasoning-policy'
import type {
  CreativeStrategy,
  EffectiveReasoningEffort,
  ReasoningEffort,
  ReasoningOverride,
  ReasoningResolutionStatus,
} from '../../shared/reasoning-types'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { Label } from '../ui/Label'
import { NativeSelect } from '../ui/NativeSelect'

export function ProjectCreativeStrategySettings() {
  const text = useLocaleStore(state => state.text)
  const currentProject = useProjectStore(state => state.currentProject)
  const updateNovelConfig = useProjectStore(state => state.updateNovelConfig)
  const saveProject = useProjectStore(state => state.saveProject)
  const [projectSaveState, setProjectSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const creativeStrategy = currentProject?.novelConfig.creativeStrategy ?? 'auto'
  const updateCreativeStrategy = async (value: CreativeStrategy) => {
    const session = projectSessionContextFromProject(currentProject)
    if (!session) return
    setProjectSaveState('saving')
    updateNovelConfig({ creativeStrategy: value }, session)
    const saved = await saveProject(session)
    setProjectSaveState(saved ? 'saved' : 'error')
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] p-3">
      <Label>{text('创作策略（当前项目）', 'Creative strategy (current project)')}</Label>
      <NativeSelect
        value={creativeStrategy}
        disabled={!currentProject || projectSaveState === 'saving'}
        onChange={event => { void updateCreativeStrategy(event.target.value as CreativeStrategy) }}
        aria-label={text('创作策略（当前项目）', 'Creative strategy (current project)')}
      >
        <option value="auto">{text('自动', 'Auto')}</option>
        <option value="fluent-drafting">{text('流畅起草', 'Fluent drafting')}</option>
        <option value="consistency-first">{text('一致性优先', 'Consistency first')}</option>
        <option value="deep-planning">{text('深度规划', 'Deep planning')}</option>
      </NativeSelect>
      <p className="mt-1 text-[0.7rem] text-[var(--color-text-muted)]">
        {!currentProject
          ? text('打开项目后可配置；该设置跟随项目，不随模型切换。', 'Open a project to configure this. It follows the project, not the selected model.')
          : projectSaveState === 'saving'
            ? text('正在保存项目策略…', 'Saving project strategy…')
            : projectSaveState === 'error'
              ? text('项目策略保存失败。', 'Could not save the project strategy.')
              : text('该设置跟随项目，不随模型切换。', 'This setting follows the project and does not change with the model.')}
      </p>
    </div>
  )
}

export function ModelReasoningOverrideSettings({
  model,
  onModelChange,
}: {
  model: ModelProfile
  onModelChange: (model: ModelProfile) => void
}) {
  const text = useLocaleStore(state => state.text)
  const creativeStrategy = useProjectStore(state => state.currentProject?.novelConfig.creativeStrategy ?? 'auto')
  // models.dev 元数据快照按需加载:加载后未收录家族的模型也能显示推理档位
  const [, setMetadataReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    void import('../../shared/reasoning-metadata')
      .then(m => m.ensureModelMetadataLoaded())
      .then(() => {
        if (!cancelled) setMetadataReady(true)
      })
      .catch(() => { /* 元数据不可用时保持家族推断/全量回退 */ })
    return () => { cancelled = true }
  }, [model.modelName])
  const effortLabel = (value: ReasoningEffort | EffectiveReasoningEffort | null): string => {
    if (value === null) return '—'
    return {
      off: text('关闭', 'Off'),
      low: text('低', 'Low'),
      medium: text('中', 'Medium'),
      high: text('高', 'High'),
      max: text('最高', 'Max'),
    }[value]
  }
  const drafting = resolveReasoningPolicy({ model, creativeStrategy, stage: 'drafting' })
  const planning = resolveReasoningPolicy({
    model,
    creativeStrategy,
    stage: 'planning',
  })
  const review = resolveReasoningPolicy({
    model,
    creativeStrategy,
    stage: 'review',
  })

  const statusLabel = (status: ReasoningResolutionStatus) => ({
    mapped: text('已映射', 'Mapped'),
    capped: text('已限制', 'Capped'),
    forced: text('模型强制', 'Model-forced'),
    inferred: text('按模型推断', 'Inferred from model'),
    unsupported: text('不支持 / 不发送参数', 'Unsupported / no parameter sent'),
  }[status])
  // 按模型映射过滤可选档位:已验证映射用验证档位,家族推断用推断档位;
  // 无法识别的模型保持全量选项(此时均为不发送参数的偏好声明)。
  const resolvedMapping = resolveModelReasoningMapping(model)
  const overrideOptions: ReasoningEffort[] = resolvedMapping
    ? [...resolvedMapping.mapping.supportedEfforts]
    : ['off', 'low', 'medium', 'high', 'max']

  const outcome = (
    label: string,
    resolution: typeof drafting,
  ) => (
    <div className="flex items-center justify-between gap-3 text-xs" data-reasoning-status={resolution.status}>
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <span className="text-right text-[var(--color-text)]">
        {effortLabel(resolution.requested)} → {effortLabel(resolution.effective)}
        <span className="ml-1 text-[var(--color-text-muted)]">({statusLabel(resolution.status)})</span>
      </span>
    </div>
  )

  return (
    <div className="space-y-3" data-model-reasoning-override-settings>
      <div>
        <Label>{text('模型推理覆盖', 'Model reasoning override')}</Label>
        <NativeSelect
          value={model.reasoningOverride ?? 'auto'}
          onChange={event => onModelChange({
            ...model,
            reasoningOverride: event.target.value as ReasoningOverride,
          })}
          aria-label={text('模型推理覆盖', 'Model reasoning override')}
        >
          <option value="auto">{text('自动（遵循项目与阶段）', 'Auto (project and stage)')}</option>
          {overrideOptions.map(effort => (
            <option key={effort} value={effort}>{effortLabel(effort)}</option>
          ))}
          {/* 已保存但不在当前模型支持列表内的覆盖:保留显示,避免静默丢设置 */}
          {model.reasoningOverride && model.reasoningOverride !== 'auto'
            && !overrideOptions.includes(model.reasoningOverride) && (
            <option value={model.reasoningOverride}>{effortLabel(model.reasoningOverride)}</option>
          )}
        </NativeSelect>
        <p className="mt-1 text-[0.7rem] text-[var(--color-text-muted)]">
          {resolvedMapping?.origin === 'verified'
            ? text(
              '这是请求偏好，不是跨服务商的统一质量刻度；实际值取决于已验证的模型映射。',
              'This is a request preference, not a universal quality scale; the effective value depends on a verified model mapping.',
            )
            : resolvedMapping?.origin === 'models-dev'
              ? text('档位来自 models.dev 模型元数据，按所选模型动态给出。', 'Efforts come from models.dev model metadata for the selected model.')
              : resolvedMapping?.origin === 'family'
                ? text('档位按模型家族推断(未经官方端点验证);实际值以端点接受为准。', 'Efforts are inferred from the model family (not verified against an official endpoint); the endpoint decides what it accepts.')
                : text(
                  '未能从模型家族识别推理能力：选项仅作为偏好保存，不会发送参数。',
                  'Reasoning support could not be identified from the model family: options are saved as preferences only and no parameter is sent.',
                )}
        </p>
      </div>

      <div className="space-y-1.5 rounded-md bg-[var(--color-bg)] p-2" aria-label={text('实际生效推理强度', 'Effective reasoning effort')}>
        {outcome(text('章节起草', 'Chapter drafting'), drafting)}
        {outcome(text('故事规划', 'Story planning'), planning)}
        {outcome(text('审稿与修订', 'Review and revision'), review)}
      </div>
      <p className="text-[0.7rem] text-[var(--color-text-muted)]">
        {text(
          '原始推理不会作为章节正文或写入小说长期记忆。',
          'Raw reasoning is not treated as chapter prose or persisted into long-term novel memory.',
        )}
      </p>
    </div>
  )
}

export default function ReasoningPolicySettings(props: {
  model: ModelProfile
  onModelChange: (model: ModelProfile) => void
}) {
  return (
    <div className="space-y-3 rounded-lg border border-[var(--color-border)] p-3" data-reasoning-policy-settings>
      <ProjectCreativeStrategySettings />
      <ModelReasoningOverrideSettings {...props} />
    </div>
  )
}
