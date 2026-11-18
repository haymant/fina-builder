// React Flow fits the viewport once, on init. A tile that mounts inside a
// lazily-sized grid can still be zero-sized at that moment, which leaves the
// viewport at an invalid transform and the canvas blank until the tile is
// remounted (the "switch pages and it comes back" symptom).
//
// Fit again once the container actually has a size, but only once: after that
// the user's pan/zoom is left alone.

import { useEffect, useRef } from 'react'
import { useReactFlow, useStore } from '@xyflow/react'

export function AutoFit({ padding = 0.15 }: { padding?: number }) {
  const { fitView } = useReactFlow()
  const domNode = useStore((state) => state.domNode)
  const fitted = useRef(false)

  useEffect(() => {
    if (!domNode) return
    const fit = () => {
      if (fitted.current) return
      if (domNode.clientWidth <= 0 || domNode.clientHeight <= 0) return
      fitted.current = true
      void fitView({ padding })
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(domNode)
    return () => observer.disconnect()
  }, [domNode, fitView, padding])

  return null
}
