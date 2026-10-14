import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface ContextMenuItem {
  id: string
  label: string
  shortcut?: string
  disabled?: boolean
  separatorBefore?: boolean
}

interface Props {
  x: number
  y: number
  items: ContextMenuItem[]
  onAction: (id: string) => void
  onClose: () => void
}

export function EditorContextMenu({ x, y, items, onAction, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const [position, setPosition] = useState({ left: x, top: y })
  onCloseRef.current = onClose

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const rect = menu.getBoundingClientRect()
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    })
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onCloseRef.current()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const menu = menuRef.current
      const enabled = [...(menu?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
      if (!enabled.length) return
      event.preventDefault()
      const index = enabled.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? enabled.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length
      enabled[next]?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return <div ref={menuRef} className="editor-context-menu" role="menu" aria-label="Editor actions" style={{ left: position.left, top: position.top }}>
    {items.map((item) => <div key={item.id}>
      {item.separatorBefore && <div className="context-menu-separator" role="separator" />}
      <button type="button" role="menuitem" aria-label={item.label} disabled={item.disabled} onClick={() => onAction(item.id)}>
        <span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}
      </button>
    </div>)}
  </div>
}
