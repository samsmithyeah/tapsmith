import { useRef, useCallback } from 'preact/hooks'

interface Props {
  /** 'horizontal' = drag left/right (between left panel and center), 'vertical' = drag up/down (between center and bottom). */
  direction: 'horizontal' | 'vertical'
  /** Called continuously during drag with the delta in px from the drag start. */
  onResize: (delta: number) => void
}

export function ResizeHandle({ direction, onResize }: Props) {
  const startPos = useRef(0)

  const onMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault()
    startPos.current = direction === 'horizontal' ? e.clientX : e.clientY

    const onMouseMove = (moveEvent: MouseEvent) => {
      const current = direction === 'horizontal' ? moveEvent.clientX : moveEvent.clientY
      onResize(current - startPos.current)
      startPos.current = current
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }, [direction, onResize])

  return (
    <div
      class={`resize-handle resize-handle-${direction}`}
      onMouseDown={onMouseDown}
    />
  )
}
