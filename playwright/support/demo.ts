import type { Locator, Page } from '@playwright/test'

/**
 * Product-demo overlay director.
 *
 * The page is never modified: every highlight is a fixed overlay injected above
 * the UI, so demos look the same across pages and cannot change layout, focus or
 * behaviour. The overlays are pointer-transparent and removed between steps.
 *
 *   const demo = createDemo(page)
 *   await demo.step('Create an agent', async () => {
 *     await demo.highlight(page.getByRole('button', { name: 'Create' }), 'Create your first agent')
 *     await demo.pause(5_000)
 *   })
 *   await demo.click(page.getByRole('button', { name: 'Create' }), 'Create your first agent')
 */
type Target = string | Locator
type HighlightMode = 'glow' | 'spotlight' | 'both'

export interface DemoOptions {
  color?: string
  /** Default attention pause. The demo brief asks for 5s when the viewer must look. */
  pauseMs?: number
  spotlight?: boolean
  /** Dim strength outside a verified element. Defaults to 0.68. */
  dimOpacity?: number
}

export interface DemoBeat {
  label: string
  atMs: number
}

const OVERLAY_ID = '__demo-highlight'
const DIM_ID = '__demo-dim'
const ANNOTATION_ID = '__demo-annotation'
const CAPTION_ID = '__demo-caption'
const STYLE_ID = '__demo-style'

export class DemoDirector {
  private startedAt = Date.now()
  private readonly beats: DemoBeat[] = []

  constructor(private readonly page: Page, private readonly options: DemoOptions = {}) {}

  private get color(): string {
    return this.options.color ?? '#00D4FF'
  }

  private get pauseMs(): number {
    return this.options.pauseMs ?? 5_000
  }

  private get dimOpacity(): number {
    return this.options.dimOpacity ?? 0.68
  }

  cue(label: string): void {
    const atMs = Date.now() - this.startedAt
    this.beats.push({ label, atMs })
    console.log(`[demo-cue] ${(atMs / 1000).toFixed(2)}s ${label}`)
  }

  /** Beat timestamps for aligning narration; written next to the video by the fixture. */
  timeline(): DemoBeat[] {
    return this.beats.map((beat) => ({ ...beat }))
  }

  /** Give the viewer time to read. Defaults to 5 seconds. */
  async pause(ms = this.pauseMs): Promise<void> {
    await this.page.waitForTimeout(ms)
  }

  private async boxOf(target: Target): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const locator = typeof target === 'string' ? this.page.locator(target).first() : target
    await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined)
    return locator.boundingBox()
  }

  /**
   * Draw a glowing border (and optionally a spotlight cut-out) around the target.
   * `label` adds a callout below the element; `verify` adds a caption line.
   */
  async highlight(target: Target, label?: string, options: { mode?: HighlightMode; verify?: string } = {}): Promise<void> {
    const box = await this.boxOf(target)
    if (!box) return
    const mode = options.mode ?? (this.options.spotlight ? 'both' : 'glow')
    await this.inject({
      rect: box,
      label: label ?? null,
      caption: options.verify ?? null,
      mode,
      color: this.color,
      dimOpacity: this.dimOpacity,
    })
  }

  /**
   * Spotlight a component the viewer must verify: everything else dims, the
   * target keeps a pulsing border, and the optional callout states the check.
   */
  async verify(target: Target, label?: string): Promise<void> {
    await this.highlight(target, label, { mode: 'spotlight' })
  }

  /** Dim the page around a target, or the whole page when no target is given. */
  async dim(target?: Target | null): Promise<void> {
    const box = target ? await this.boxOf(target) : null
    await this.inject({
      rect: box,
      label: null,
      caption: null,
      mode: 'spotlight',
      color: this.color,
      dimOpacity: this.dimOpacity,
      border: false,
    })
  }

  /** A callout without a border, anchored to the target (or bottom-centre). */
  async annotate(target: Target | null, text: string): Promise<void> {
    const box = target ? await this.boxOf(target) : null
    await this.inject({
      rect: box,
      label: text,
      caption: null,
      mode: 'annotation',
      color: this.color,
      dimOpacity: this.dimOpacity,
    })
  }

  /** A persistent lower-third with the current step and what to verify. */
  async caption(title: string, verify?: string): Promise<void> {
    await this.page.evaluate(
      ({ title, verify, id, styleId, color }) => {
        let style = document.getElementById(styleId)
        if (!style) {
          style = document.createElement('style')
          style.id = styleId
          style.textContent = '@keyframes demoPulse{0%,100%{box-shadow:0 0 10px var(--demo),0 0 22px var(--demo)}50%{box-shadow:0 0 22px var(--demo),0 0 54px var(--demo)}}@keyframes demoRipple{from{transform:scale(.2);opacity:.9}to{transform:scale(2.4);opacity:0}}@keyframes demoFade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}'
          document.head.appendChild(style)
        }
        document.getElementById(id)?.remove()
        const el = document.createElement('div')
        el.id = id
        Object.assign(el.style, {
          position: 'fixed',
          left: '50%',
          bottom: '28px',
          transform: 'translateX(-50%)',
          maxWidth: 'min(760px, 80vw)',
          padding: '10px 16px',
          borderRadius: '10px',
          background: 'rgba(12,16,22,.92)',
          border: `1px solid ${color}`,
          color: '#e8f7ff',
          font: '13px/1.45 system-ui, sans-serif',
          textAlign: 'center',
          pointerEvents: 'none',
          zIndex: '2147483647',
          boxShadow: `0 0 18px ${color}55`,
          animation: 'demoFade .3s ease-out',
        })
        el.innerHTML = `<strong style="display:block;font-size:13px">${title}</strong>${
          verify ? `<span style="display:block;margin-top:3px;color:#9fd8e8;font-size:11px">${verify}</span>` : ''
        }`
        document.body.appendChild(el)
      },
      { title, verify: verify ?? '', id: CAPTION_ID, styleId: STYLE_ID, color: this.color },
    )
  }

  /** Pulse the border, ripple the click point, then click. */
  async click(target: Locator, label?: string, options: { mode?: HighlightMode } = {}): Promise<void> {
    await this.highlight(target, label, options)
    const box = await target.boundingBox()
    if (box) {
      await this.page.evaluate(
        ({ x, y, color }) => {
          const dot = document.createElement('div')
          Object.assign(dot.style, {
            position: 'fixed',
            left: `${x - 18}px`,
            top: `${y - 18}px`,
            width: '36px',
            height: '36px',
            borderRadius: '999px',
            border: `2px solid ${color}`,
            boxShadow: `0 0 18px ${color}`,
            pointerEvents: 'none',
            zIndex: '2147483647',
            animation: 'demoRipple .7s ease-out forwards',
          })
          document.body.appendChild(dot)
          window.setTimeout(() => dot.remove(), 800)
        },
        { x: box.x + box.width / 2, y: box.y + box.height / 2, color: this.color },
      )
      await this.page.waitForTimeout(220)
    }
    await target.click()
  }

  /** Remove every injected overlay, dim panel, callout and caption. */
  async clear(): Promise<void> {
    await this.page.evaluate(
      ({ overlay, dim, annotation, caption }) => {
        for (const id of [overlay, dim, annotation, caption]) document.getElementById(id)?.remove()
      },
      { overlay: OVERLAY_ID, dim: DIM_ID, annotation: ANNOTATION_ID, caption: CAPTION_ID },
    )
  }

  /** Cue a step, run it, then clear the overlays. */
  async step(title: string, body: () => Promise<void>): Promise<void> {
    this.cue(title)
    await body()
    await this.clear()
  }

  private async inject(input: {
    rect: { x: number; y: number; width: number; height: number } | null
    label: string | null
    caption: string | null
    mode: HighlightMode | 'annotation'
    color: string
    dimOpacity: number
    border?: boolean
  }): Promise<void> {
    await this.page.evaluate(
      ({ rect, label, caption, mode, color, dimOpacity, border, overlayId, dimId, annotationId, captionId, styleId }) => {
        let style = document.getElementById(styleId)
        if (!style) {
          style = document.createElement('style')
          style.id = styleId
          style.textContent =
            '@keyframes demoPulse{0%,100%{transform:scale(1);box-shadow:0 0 26px 2px var(--demo),0 0 70px 12px var(--demo)}50%{transform:scale(1.03);box-shadow:0 0 40px 6px var(--demo),0 0 100px 20px var(--demo)}}@keyframes demoRipple{from{transform:scale(.2);opacity:.9}to{transform:scale(2.4);opacity:0}}@keyframes demoFade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@keyframes demoDim{from{opacity:0}to{opacity:1}}'
          document.head.appendChild(style)
        }
        document.getElementById(overlayId)?.remove()
        document.getElementById(dimId)?.remove()
        document.getElementById(annotationId)?.remove()
        if (caption) {
          // Reuse the caption slot for a per-step "verify" note.
          const existing = document.getElementById(captionId)
          if (existing) existing.remove()
        }

        const vw = window.innerWidth
        const vh = window.innerHeight
        const left = rect ? Math.max(0, Math.min(rect.x, vw)) : 0
        const top = rect ? Math.max(0, Math.min(rect.y, vh)) : 0
        const right = rect ? Math.max(left, Math.min(rect.x + rect.width, vw)) : vw
        const bottom = rect ? Math.max(top, Math.min(rect.y + rect.height, vh)) : vh

        if (mode === 'spotlight' || mode === 'both') {
          const dim = document.createElement('div')
          dim.id = dimId
          Object.assign(dim.style, {
            position: 'fixed',
            inset: '0',
            pointerEvents: 'none',
            zIndex: '2147483645',
            animation: 'demoDim .18s ease-out',
          })
          const panel = (x: number, y: number, width: number, height: number) => {
            if (width <= 0 || height <= 0) return
            const el = document.createElement('div')
            Object.assign(el.style, {
              position: 'fixed',
              left: `${x}px`,
              top: `${y}px`,
              width: `${width}px`,
              height: `${height}px`,
              background: `rgba(4,8,12,${dimOpacity})`,
              pointerEvents: 'none',
            })
            dim.appendChild(el)
          }
          if (!rect) {
            panel(0, 0, vw, vh)
          } else {
            // Four panels leave a crisp, click-through cut-out around the target.
            panel(0, 0, vw, top)
            panel(0, bottom, vw, vh - bottom)
            panel(0, top, left, bottom - top)
            panel(right, top, vw - right, bottom - top)
          }
          document.body.appendChild(dim)
        }

        if (border !== false && mode !== 'annotation' && rect) {
          const box = document.createElement('div')
          box.id = overlayId
          Object.assign(box.style, {
            position: 'fixed',
            left: `${left - 6}px`,
            top: `${top - 6}px`,
            width: `${right - left + 12}px`,
            height: `${bottom - top + 12}px`,
            border: 'none',
            borderRadius: '14px',
            pointerEvents: 'none',
            zIndex: '2147483646',
            ['--demo' as string]: color,
            // No hard border: a soft, oversized glow marks the target without
            // boxing it in or hiding its own edges.
            boxShadow: `0 0 26px 2px ${color}, 0 0 70px 12px ${color}`,
            animation: 'demoPulse 1.6s ease-in-out infinite',
          })
          document.body.appendChild(box)
        }

        if (label) {
          const note = document.createElement('div')
          note.id = annotationId
          const below = rect ? bottom + 12 : vh - 96
          const placeBelow = below < vh - 70
          Object.assign(note.style, {
            position: 'fixed',
            left: rect ? `${Math.max(12, Math.min(left, vw - 340))}px` : '50%',
            top: `${below}px`,
            transform: placeBelow ? 'none' : 'translateY(-100%)',
            maxWidth: '320px',
            padding: '8px 12px',
            borderRadius: '8px',
            background: 'rgba(12,16,22,.94)',
            border: 'none',
            color: '#e8f7ff',
            font: '12px/1.4 system-ui, sans-serif',
            pointerEvents: 'none',
            zIndex: '2147483647',
            boxShadow: `0 0 16px ${color}55`,
            animation: 'demoFade .25s ease-out',
          })
          if (!rect) note.style.transform = 'translateX(-50%)'
          note.textContent = label
          document.body.appendChild(note)
        }
      },
      {
        rect: input.rect,
        label: input.label,
        caption: input.caption,
        mode: input.mode,
        color: input.color,
        dimOpacity: input.dimOpacity,
        border: input.border ?? true,
        overlayId: OVERLAY_ID,
        dimId: DIM_ID,
        annotationId: ANNOTATION_ID,
        captionId: CAPTION_ID,
        styleId: STYLE_ID,
      },
    )
  }
}

export function createDemo(page: Page, options: DemoOptions = {}): DemoDirector {
  return new DemoDirector(page, options)
}
