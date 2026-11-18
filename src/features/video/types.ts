export type VideoProjectStatus = 'draft' | 'in_review' | 'ready' | 'rendering' | 'exported' | 'archived'
export type VideoEpisodeStatus = 'draft' | 'in_review' | 'ready' | 'archived'
export type VideoShotStatus = 'planned' | 'ready' | 'rendering' | 'blocked' | 'complete'

export interface VideoProject {
  project_id: string
  revision: number
  title: string
  language: string
  target_platform: string
  target_duration_ms: number | null
  audience: string | null
  style_profile: string | null
  status: VideoProjectStatus
  created_at: string
  updated_at: string
}

export interface VideoEpisode {
  episode_id: string
  project_id: string
  revision: number
  title: string | null
  as_of: string | null
  disclosure: string | null
  status: VideoEpisodeStatus
  created_at: string
  updated_at: string
}

export interface VideoEvidenceRef {
  evidence_kind: 'event' | 'claim' | string
  evidence_id: string
  start_offset: number | null
  end_offset: number | null
  quote: string | null
}

export interface VideoStoryboard {
  storyboard_id: string
  narrative_id: string
  revision: number
  schema_version: string
  review_status: string
  created_at: string
  updated_at: string
}

export interface VideoScene {
  scene_id: string
  storyboard_id: string
  revision: number
  ordinal: number
  purpose: string
  narration_text: string | null
  visual_intent: string | null
  duration_ms: number | null
  created_at: string
  updated_at: string
}

export interface VideoShot {
  shot_id: string
  scene_id: string
  revision: number
  ordinal: number
  shot_type: string
  duration_ms: number
  camera_motion: string | null
  visual_prompt: string | null
  status: VideoShotStatus
  created_at: string
  updated_at: string
}

export interface VideoCapabilities {
  planning: string
  evidence_linkage: string
  deterministic_renderer: string
  mock_assets: string
  generative_video: string
  tts: string
  asr: string
  disclosure: string
}

export interface VideoAsset {
  asset_id: string
  revision: number
  asset_kind: string
  relative_path: string | null
  mime_type: string | null
  content_hash: string | null
  width: number | null
  height: number | null
  duration_ms: number | null
  provider: string
  workflow_id: string | null
  model: string | null
  reproducibility: string
  capability_state: string
  license_state: string
  job_id: string | null
  created_at: string
}

export interface VideoWorkflow {
  workflow_id: string
  revision: number
  capability: string
  provider_adapter: string
  schema_version: string
  model_identity: string | null
  parameters: Record<string, unknown>
  created_at: string
}

export type VideoVisualTemplate = 'evidence_card' | 'quote_card' | 'kinetic_text' | 'chart_transition' | 'caption' | 'scene_transition'
export type VideoVisualSourceKind = 'event' | 'claim' | 'transcript_span' | 'signal_snapshot'

export interface VideoChartPoint {
  label: string
  value_millis: number
}

export type VideoVisualPayload =
  | { kind: 'evidence_card'; title: string; body: string; disclosure?: string | null }
  | { kind: 'quote_card'; quote: string; speaker?: string | null; source_label?: string | null }
  | { kind: 'kinetic_text'; text: string }
  | { kind: 'chart_transition'; title: string; x_axis_label?: string | null; y_axis_label?: string | null; points: VideoChartPoint[] }
  | { kind: 'caption'; text: string }
  | { kind: 'scene_transition'; label?: string | null }

export interface VideoVisualSource {
  source_kind: VideoVisualSourceKind
  source_id: string
  source_revision?: number | null
  start_offset?: number | null
  end_offset?: number | null
  quote?: string | null
}

export interface VideoVisualSpec {
  spec_id: string
  revision: number
  schema_version: string
  project_id: string
  episode_id: string
  scene_id?: string | null
  shot_id?: string | null
  template: VideoVisualTemplate
  duration_ms: number
  width: number
  height: number
  fps: number
  payload: VideoVisualPayload
  sources: VideoVisualSource[]
  deterministic: boolean
  created_at: string
}

export type VideoExportKind = 'storyboard' | 'shot_list' | 'asset_requirements' | 'linkzag_scene' | 'timeline' | 'media_bundle'

export interface VideoExportFile {
  relative_path: string
  format: string
  content_hash?: string | null
  byte_size?: number | null
  mime_type?: string | null
  width?: number | null
  height?: number | null
  duration_ms?: number | null
}

export interface VideoExportManifest {
  manifest_id: string
  schema_version: string
  project_id: string
  project_revision: number
  episode_id?: string | null
  storyboard_id?: string | null
  export_kind: VideoExportKind
  deterministic: boolean
  visual_spec_ids: string[]
  asset_ids: string[]
  files: VideoExportFile[]
  evidence: VideoEvidenceRef[]
  content_hash?: string | null
  created_at: string
}

export interface LinkZagRenderResult {
  run_id: string
  asset: VideoAsset
  renderer: string
  renderer_revision: string
  scene_checksum: string
  scene_path_managed: boolean
  output_manifest: Record<string, unknown> | null
  state: string
  message: string
}

export interface VideoJob {
  job_id: string
  operation: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | string
  input_revision: number | null
  progress_millis: number
  cancellation_requested: boolean
  resource_estimate: Record<string, unknown> | null
  output_manifest: { asset?: VideoAsset; [key: string]: unknown } | null
  safe_error_message: string | null
  started_at: string | null
  finished_at: string | null
  created_at: string
}
