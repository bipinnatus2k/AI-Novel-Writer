import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FinalizationRepository } from '../../repositories/finalization-repository'
import { FinalizationService } from '../finalization-service'

vi.mock('../../repositories/finalization-repository', () => ({
  FinalizationRepository: {
    unlock: vi.fn(),
  },
}))

const unlockMock = vi.mocked(FinalizationRepository.unlock)

function createCleaner() {
  return {
    removeManuscript: vi.fn(async () => undefined),
    removeKnowledgeDocument: vi.fn(async () => undefined),
  }
}

beforeEach(() => {
  unlockMock.mockReset()
})

describe('FinalizationService.unlock projection cleanup', () => {
  it('cleans the manuscript file and knowledge document using the identity frozen in the unlock transaction', async () => {
    unlockMock.mockReturnValue({
      finalizationId: 'finalization-2',
      draftId: 20,
      chapterNumber: 2,
      chapterTitle: '第二章',
      targetFileName: '第2章 第二章.txt',
      knowledgeDocumentId: 'kb-doc-2',
    })
    const cleaner = createCleaner()
    const service = new FinalizationService({ unlockCleaner: cleaner })

    const result = await service.unlock({ projectRoot: 'D:/project', draftId: 20 })

    expect(result).toEqual({
      success: true,
      draftId: 20,
      chapterNumber: 2,
      finalizationId: 'finalization-2',
    })
    expect(cleaner.removeManuscript).toHaveBeenCalledWith('D:/project', '第2章 第二章.txt')
    expect(cleaner.removeKnowledgeDocument).toHaveBeenCalledWith('D:/project', 'kb-doc-2')
  })

  it('keeps the committed unlock fact and returns warnings when projection cleanup fails', async () => {
    unlockMock.mockReturnValue({
      finalizationId: 'finalization-2',
      draftId: 20,
      chapterNumber: 2,
      chapterTitle: '第二章',
      targetFileName: '第2章 第二章.txt',
      knowledgeDocumentId: 'kb-doc-2',
    })
    const cleaner = createCleaner()
    cleaner.removeManuscript.mockRejectedValue(new Error('file locked'))
    cleaner.removeKnowledgeDocument.mockRejectedValue(new Error('native module unavailable'))
    const service = new FinalizationService({ unlockCleaner: cleaner })

    const result = await service.unlock({ projectRoot: 'D:/project', draftId: 20 })

    expect(result.success).toBe(true)
    expect(result.warnings).toEqual([
      '实体稿清理失败：file locked',
      '知识库清理失败：native module unavailable',
    ])
  })

  it('skips projection cleanup when the unlocked finalization has no linked projections', async () => {
    unlockMock.mockReturnValue({
      finalizationId: 'finalization-1',
      draftId: 10,
      chapterNumber: 1,
      chapterTitle: '第一章',
      targetFileName: '',
      knowledgeDocumentId: '',
    })
    const cleaner = createCleaner()
    const service = new FinalizationService({ unlockCleaner: cleaner })

    const result = await service.unlock({ projectRoot: 'D:/project', draftId: 10 })

    expect(result.success).toBe(true)
    expect(result.warnings).toBeUndefined()
    expect(cleaner.removeManuscript).not.toHaveBeenCalled()
    expect(cleaner.removeKnowledgeDocument).not.toHaveBeenCalled()
  })

  it('reports the repository refusal without touching projections', async () => {
    unlockMock.mockImplementation(() => {
      throw new Error('只能解锁最新的定稿章节（第 2 章）；解锁中间章会让权威定稿出现缺口。')
    })
    const cleaner = createCleaner()
    const service = new FinalizationService({ unlockCleaner: cleaner })

    const result = await service.unlock({ projectRoot: 'D:/project', draftId: 10 })

    expect(result.success).toBe(false)
    expect(result.error).toContain('只能解锁最新的定稿章节')
    expect(cleaner.removeManuscript).not.toHaveBeenCalled()
    expect(cleaner.removeKnowledgeDocument).not.toHaveBeenCalled()
  })
})
