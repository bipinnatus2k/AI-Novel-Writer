import { useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useLocaleStore } from '../../stores/locale-store'

/**
 * 可折叠的模型推理展示块 —— 从 AIOutputPanel 的同名组件抽取共用。
 * 正文未开始时默认展开，正文出现后自动收起。
 */
export default function ThinkingBlock({ thinking, showCursor, hasContent }: {
  thinking: string
  showCursor: boolean
  hasContent: boolean
}) {
  const locale = useLocaleStore(s => s.locale)
  const zhCN = locale !== 'en-US'
  const [expanded, setExpanded] = useState(!hasContent)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let mounted = true
    if (hasContent) {
      Promise.resolve().then(() => {
        if (mounted) setExpanded(false)
      })
    }
    return () => { mounted = false }
  }, [hasContent])

  useEffect(() => {
    if (expanded && scrollRef.current) {
      const el = scrollRef.current
      // 只有在用户没有往上滚动太多时，才自动贴近底部
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        })
      }
    }
  }, [thinking, expanded])

  return (
    <div className="mb-0.5">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="group flex items-center gap-1.5 w-full text-left text-xs min-h-6 py-1 select-none transition-colors"
        style={{ color: 'var(--color-text-muted)', opacity: 0.8 }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-text)' }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-text-muted)' }}
      >
        <ChevronRight
          size={12}
          style={{
            transition: 'transform 0.2s',
            transform: expanded ? 'rotate(90deg)' : 'none',
          }}
        />
        <span>
          {showCursor
            ? (zhCN ? '思考中...' : 'Thinking...')
            : (zhCN ? '思考过程' : 'Thinking process')}
        </span>
        {showCursor && !expanded && (
          <span className="ai-stream-cursor" style={{ height: 11, width: 3 }} />
        )}
      </button>

      {expanded && (
        <div
          ref={scrollRef}
          className="ml-0.5 pl-3 border-l-2 py-0.5 mb-2 mt-1 text-xs leading-relaxed whitespace-pre-wrap overflow-y-auto"
          style={{
            borderColor: 'var(--color-border)',
            color: 'var(--color-text-muted)',
            maxHeight: 250,
            fontFamily: 'var(--font-mono)',
            fontSize: '0.75rem',
            lineHeight: 1.6,
          }}
        >
          {thinking}
          {showCursor && <span className="ai-stream-cursor" style={{ height: 12, width: 3 }} />}
        </div>
      )}
    </div>
  )
}
