import type { ProjectData } from '../../../shared/ipc-channels'
import type { FinalizationUnlockResult } from '../../../../electron/services/finalization-service'
import { globalEventBus } from '../../../shared/event-bus'
import { unlockFinalizedDraft } from '../../../services/finalization-client'
import { useLocaleStore } from '../../../stores/locale-store'
import { confirm } from '../../ui/Confirm'
import { toast } from '../../ui/Toast'
import {
  captureProjectSession,
  isProjectSessionCurrent,
  isProjectSessionPath,
} from '../../project-session-gate'

type SessionProject = Pick<ProjectData, 'id' | 'path' | 'sessionLease'>

export interface UnlockFinalizedChapterInput {
  project: SessionProject | null | undefined
  projectPath: string
  draftId: number
  chapterNumber: number
  displayName: string
}

/**
 * 解锁定稿的共享渲染进程动作：确认后调用主进程解锁 seam，再广播
 * FINALIZE_UNLOCKED 驱动编辑器 Tab、草稿箱、蓝图编辑器与文件树刷新。
 * 只有最高定稿章允许解锁；非最高章由主进程拒绝并提示。
 */
export async function unlockFinalizedChapter(
  input: UnlockFinalizedChapterInput,
): Promise<FinalizationUnlockResult | null> {
  const text = useLocaleStore.getState().text
  const projectSession = captureProjectSession(input.project)
  if (!projectSession || !isProjectSessionPath(projectSession, input.projectPath)) return null

  const confirmed = await confirm(text(
    `确认将「${input.displayName}」解锁为草稿？\n\n章节会回到可编辑草稿状态；其已发布实体稿与知识库投影会被清理，剧情树快照和连续性派生将失效并在下次定稿后重建。重新定稿前，后续章节无法定稿。`,
    `Unlock “${input.displayName}” back to draft?\n\nThe chapter becomes editable again; its published manuscript file and knowledge-base projection are cleaned up, and the plot-tree snapshot plus continuity derivations are invalidated until the next finalization. Later chapters cannot be finalized until this one is finalized again.`,
  ), {
    title: text('解锁为草稿', 'Unlock to draft'),
    confirmText: text('解锁为草稿', 'Unlock to draft'),
  })
  if (!confirmed || !isProjectSessionCurrent(projectSession)) return null

  let result: FinalizationUnlockResult
  try {
    result = await unlockFinalizedDraft(input.draftId, projectSession)
  } catch (error) {
    if (!isProjectSessionCurrent(projectSession)) return null
    toast.error(text(
      `解锁失败\n\n${error instanceof Error ? error.message : String(error)}`,
      `Unlock failed\n\n${error instanceof Error ? error.message : String(error)}`,
    ))
    return null
  }
  if (!isProjectSessionCurrent(projectSession)) return null
  if (!result.success) {
    toast.error(text(
      `解锁失败\n\n${result.error ?? '未知错误'}`,
      `Unlock failed\n\n${result.error ?? 'Unknown error'}`,
    ))
    return result
  }

  globalEventBus.emit('FINALIZE_UNLOCKED', {
    projectPath: input.projectPath,
    projectSession,
    draftId: input.draftId,
    chapterNumber: input.chapterNumber,
    chapterTitle: '',
  })
  if (result.warnings && result.warnings.length > 0) {
    toast.warning(text(
      `已解锁为草稿，但部分投影待清理：${result.warnings.join('；')}`,
      `Unlocked to draft, but some projections still need cleanup: ${result.warnings.join('; ')}`,
    ), 8000)
  } else {
    toast.success(text(
      `已解锁 ${input.displayName}，章节回到可编辑草稿状态`,
      `Unlocked ${input.displayName}; the chapter is editable again.`,
    ))
  }
  return result
}
