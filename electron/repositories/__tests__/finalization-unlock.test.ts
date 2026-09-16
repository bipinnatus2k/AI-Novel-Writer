import type BetterSqlite3 from 'better-sqlite3'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getProjectDb } from '../../database'
import { FinalizationRepository } from '../finalization-repository'

vi.mock('../../database', () => ({
  getProjectDb: vi.fn(),
}))

let db: BetterSqlite3.Database

/** 最小化建表：只覆盖 unlock / commit 事实链路需要的表与列。 */
const SCHEMA_STATEMENTS: readonly string[] = [
  'CREATE TABLE contents (id INTEGER PRIMARY KEY, body TEXT NOT NULL)',
  `CREATE TABLE drafts (
    id INTEGER PRIMARY KEY,
    chapter_number INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    content_id INTEGER NOT NULL,
    word_count INTEGER NOT NULL,
    updated_at TEXT
  )`,
  `CREATE TABLE finalization_outbox (
    finalization_id TEXT PRIMARY KEY,
    draft_id INTEGER NOT NULL UNIQUE,
    chapter_number INTEGER NOT NULL,
    chapter_title TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content_revision INTEGER NOT NULL,
    content_snapshot TEXT NOT NULL,
    target_file_name TEXT NOT NULL,
    knowledge_document_id TEXT NOT NULL DEFAULT '',
    publication_status TEXT NOT NULL,
    last_error TEXT NOT NULL DEFAULT '',
    published_at TEXT,
    updated_at TEXT
  )`,
  `CREATE TABLE continuity_projection_meta (
    id TEXT PRIMARY KEY CHECK (id = 'main'),
    generation INTEGER NOT NULL DEFAULT 0,
    stale_from_chapter INTEGER DEFAULT NULL
  )`,
  "INSERT INTO continuity_projection_meta (id, generation) VALUES ('main', 4)",
  `CREATE TABLE post_process_runs (
    id TEXT PRIMARY KEY,
    trigger_source_type TEXT NOT NULL,
    trigger_source_id TEXT NOT NULL
  )`,
  `CREATE TABLE project_core (
    id TEXT PRIMARY KEY,
    plot_tree_snapshot TEXT NOT NULL DEFAULT ''
  )`,
  "INSERT INTO project_core (id, plot_tree_snapshot) VALUES ('main', '{\"snapshot\":true}')",
]

/** 第 1、2 章已定稿；第 3 章是普通草稿。 */
function seedFinalizedChapters(): void {
  db.prepare('INSERT INTO contents (id, body) VALUES (?, ?)').run(1, '第一章正文')
  db.prepare('INSERT INTO contents (id, body) VALUES (?, ?)').run(2, '第二章正文')
  db.prepare('INSERT INTO contents (id, body) VALUES (?, ?)').run(3, '第三章草稿')
  db.prepare(`
    INSERT INTO drafts (id, chapter_number, status, content_id, word_count)
    VALUES (10, 1, 'finalized', 1, 5), (20, 2, 'finalized', 2, 5), (30, 3, 'draft', 3, 5)
  `).run()
  db.prepare(`
    INSERT INTO finalization_outbox (
      finalization_id, draft_id, chapter_number, chapter_title, content_hash,
      content_revision, content_snapshot, target_file_name, knowledge_document_id,
      publication_status, last_error
    ) VALUES
      ('finalization-1', 10, 1, '第一章', 'hash-1', 1, '第一章正文', '第1章 第一章.txt', 'kb-doc-1', 'published', ''),
      ('finalization-2', 20, 2, '第二章', 'hash-2', 2, '第二章正文', '第2章 第二章.txt', 'kb-doc-2', 'published', '')
  `).run()
  db.prepare(`
    INSERT INTO post_process_runs (id, trigger_source_type, trigger_source_id) VALUES
      ('run-ch1', 'chapter_finalize', '1'),
      ('run-ch2', 'chapter_finalize', '2')
  `).run()
}

beforeEach(() => {
  db = new Database(':memory:')
  for (const statement of SCHEMA_STATEMENTS) {
    db.prepare(statement).run()
  }
  seedFinalizedChapters()
  vi.mocked(getProjectDb).mockReturnValue(db)
})

afterEach(() => {
  db.close()
  vi.clearAllMocks()
})

describe('FinalizationRepository.unlock', () => {
  it('reverts the highest finalized chapter to draft and freezes projection identity in one transaction', () => {
    const projection = FinalizationRepository.unlock(20)

    expect(projection).toEqual({
      finalizationId: 'finalization-2',
      draftId: 20,
      chapterNumber: 2,
      chapterTitle: '第二章',
      targetFileName: '第2章 第二章.txt',
      knowledgeDocumentId: 'kb-doc-2',
    })
    expect(db.prepare('SELECT status FROM drafts WHERE id = 20').get())
      .toEqual({ status: 'draft' })
    expect(db.prepare('SELECT status FROM drafts WHERE id = 10').get())
      .toEqual({ status: 'finalized' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM finalization_outbox').get())
      .toEqual({ count: 1 })

    const meta = db.prepare(
      "SELECT generation, stale_from_chapter FROM continuity_projection_meta WHERE id = 'main'",
    ).get() as { generation: number; stale_from_chapter: number | null }
    expect(meta.generation).toBe(5)
    expect(meta.stale_from_chapter).toBe(2)

    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM post_process_runs WHERE trigger_source_id = '2'",
    ).get()).toEqual({ count: 0 })
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM post_process_runs WHERE trigger_source_id = '1'",
    ).get()).toEqual({ count: 1 })

    expect(db.prepare("SELECT plot_tree_snapshot FROM project_core WHERE id = 'main'").get())
      .toEqual({ plot_tree_snapshot: '' })
  })

  it('refuses to unlock a chapter that is not the highest finalized chapter', () => {
    expect(() => FinalizationRepository.unlock(10)).toThrow('只能解锁最新的定稿章节')
    expect(db.prepare('SELECT status FROM drafts WHERE id = 10').get())
      .toEqual({ status: 'finalized' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM finalization_outbox').get())
      .toEqual({ count: 2 })
  })

  it('refuses to unlock a draft that is not finalized', () => {
    expect(() => FinalizationRepository.unlock(30)).toThrow('只有已定稿的草稿才能解锁为草稿')
  })

  it('refuses to unlock a finalized draft that lacks a recoverable publication receipt', () => {
    db.prepare('DELETE FROM finalization_outbox WHERE draft_id = 20').run()
    expect(() => FinalizationRepository.unlock(20)).toThrow('缺少可恢复发布记录')
    expect(db.prepare('SELECT status FROM drafts WHERE id = 20').get())
      .toEqual({ status: 'finalized' })
  })

  it('allows re-finalizing the unlocked chapter as the next authority', () => {
    FinalizationRepository.unlock(20)

    const committed = FinalizationRepository.commit({
      finalizationId: 'finalization-2b',
      draftId: 20,
      chapterNumber: 2,
      chapterTitle: '第二章',
      content: '第二章正文（修订）',
      contentHash: 'hash-2b',
      contentRevision: 3,
      targetFileName: '第2章 第二章.txt',
    })
    expect(committed.finalizationId).toBe('finalization-2b')
    expect(db.prepare('SELECT status FROM drafts WHERE id = 20').get())
      .toEqual({ status: 'finalized' })
  })
})

describe('FinalizationRepository.commit continuity guard', () => {
  it('refuses to finalize a chapter that would leave a gap in finalized authority', () => {
    db.prepare('DELETE FROM drafts WHERE id = 20').run()
    db.prepare('DELETE FROM finalization_outbox WHERE draft_id = 20').run()
    // 现在最高定稿是第 1 章；直接定稿第 3 章必须被拒绝
    expect(() => FinalizationRepository.commit({
      finalizationId: 'finalization-3',
      draftId: 30,
      chapterNumber: 3,
      chapterTitle: '第三章',
      content: '第三章草稿',
      contentHash: 'hash-3',
      contentRevision: 1,
      targetFileName: '第3章 第三章.txt',
    })).toThrow('定稿必须连续')
    expect(db.prepare('SELECT status FROM drafts WHERE id = 30').get())
      .toEqual({ status: 'draft' })
  })

  it('still allows the consecutive next chapter to be finalized', () => {
    const committed = FinalizationRepository.commit({
      finalizationId: 'finalization-3',
      draftId: 30,
      chapterNumber: 3,
      chapterTitle: '第三章',
      content: '第三章草稿',
      contentHash: 'hash-3',
      contentRevision: 1,
      targetFileName: '第3章 第三章.txt',
    })
    expect(committed.publicationStatus).toBe('pending')
  })
})
