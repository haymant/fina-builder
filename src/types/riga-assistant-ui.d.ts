// Ambient types for the vendored RIGA assistant surface.
//
// The package is consumed straight from `modules/riga/packages/assistant-ui/src`
// (Vite aliases in `vite.config.ts`); these declarations keep its internals out
// of fina-builder's type-check while still giving the chat panel a typed API.
// Keep in step with `modules/riga/packages/assistant-ui/src/index.ts` and
// `src/options.ts`.

declare module '@rigai/assistant-ui' {
  import type { ComponentType } from 'react'

  export interface AssistantUiOptions {
    /** Show the session-history button in the header. */
    showSessionHistoryButton?: boolean
    /** Fill the host width instead of the default fixed panel width. */
    fullWidth?: boolean
    /** Feature flags / labels resolved by the package's defaults. */
    [option: string]: unknown
  }

  export interface AssistantUIProps extends AssistantUiOptions {
    /** Build the transport (Tauri IPC for desktop; HTTP/WebSocket otherwise). */
    transportFactory?: (listeners: unknown) => unknown
  }

  export const AssistantUI: ComponentType<AssistantUIProps>
  export const RIGA_ASSISTANT_UI_VERSION: string
  export const DEFAULT_ASSISTANT_UI_OPTIONS: Record<string, unknown>
}

declare module '@rigai/assistant-ui/tauri' {
  export function createTauriTransport(options: { listeners: unknown }): unknown
}

declare module '@rigai/assistant-ui/http' {
  export function createHttpTransport(...args: unknown[]): unknown
}

declare module '@rigai/assistant-ui/protocol' {
  export type RigaTransport = unknown
  export type RigaTransportListeners = unknown
}

declare module '@rigai/assistant-ui/styles.css'
