import { useEffect, useState } from 'react'

const MOBILE_BREAKPOINT = 768

/**
 * True when the viewport is below the mobile breakpoint. Used by the vendored
 * `ui/sidebar`. Mirrors the shadcn dashboard helper.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() =>
    typeof window === 'undefined' ? false : window.innerWidth < MOBILE_BREAKPOINT,
  )

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    query.addEventListener('change', onChange)
    onChange()
    return () => query.removeEventListener('change', onChange)
  }, [])

  return isMobile
}
