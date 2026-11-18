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
