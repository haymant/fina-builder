import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { nip } from '../../api/nipTransport'
import { toSnakeKeys } from '../../api/keyCase'
import type { NipBacktestEvidence, NipThesis, NipTranscript } from '../narrative/types'
import type { VideoAsset, VideoAssetLineage, VideoCapabilities, VideoEpisode, VideoEvidenceRef, VideoExportManifest, VideoJob, VideoNarrative, VideoProject, VideoProjectDeleteResult, VideoQaReport, VideoScene, VideoShot, VideoSourceEvent, VideoStoryboard, VideoTimeline, VideoVisualSpec, VideoWorkflow } from './types'

/** The installed preview profile (revamp §d.1 steps 5–6; video_edl.rs PREVIEW_PROFILE_ID). */
export const VIDEO_PREVIEW_PROFILE_ID = 'mp4-h264-720p30-preview-v1'

export interface VideoTimelineBuildResult {
  status: string
  timeline_ref?: { id: string; revision: number } | null
  timeline_hash?: string | null
  summary?: { video_clips: number; audio_clips: number; caption_tracks: number; total_frames: number; duration_ms: number } | null
  findings: Array<{ code: string; severity: string; message: string; subject_ref?: { kind: string; id: string } | null; remediation?: string | null }>
}

export interface VideoTimelineEdl {
  timeline_id: string
  revision: number
  created_at: string
  build_version?: number | null
  build_status: string
  build_findings: Array<{ code: string; severity: string; message: string }>
  timeline_hash: string
  input_fingerprint: string
  edl: Record<string, unknown>
}

export interface VideoExportProfile {
  id: string
  revision?: number | null
  [key: string]: unknown
}

/**
 * Thesis / transcript / backtest reads (F2 record types, revamp §c.5/§d.2).
 * The video UI reads them through the NIP MCP tools; it never re-derives
 * NLP or writes the other side's lake.
 */
export const thesisApi = {
  listTheses: () => nip.callTool('list_theses').then((value) => fromTransport<NipThesis[]>(value)),
  getThesis: (thesisId: string) => nip.callTool('get_thesis', { thesis_id: thesisId }).then((value) => fromTransport<NipThesis>(value)),
  saveThesis: (thesis: NipThesis) => nip.callTool('save_thesis', { thesis }).then((value) => fromTransport<NipThesis>(value)),
  listTranscripts: (thesisId: string) => nip.callTool('list_transcripts', { thesis_id: thesisId }).then((value) => fromTransport<NipTranscript[]>(value)),
  getTranscript: (transcriptId: string) => nip.callTool('get_transcript', { transcript_id: transcriptId }).then((value) => fromTransport<NipTranscript>(value)),
  listBacktestEvidence: (thesisId: string) => nip.callTool('list_backtest_evidence', { thesis_id: thesisId }).then((value) => fromTransport<NipBacktestEvidence[]>(value)),
  getBacktestEvidence: (backtestId: string) => nip.callTool('get_backtest_evidence', { backtest_id: backtestId }).then((value) => fromTransport<NipBacktestEvidence>(value)),
}

function fromTransport<T>(value: unknown): T {
  return toSnakeKeys(value) as T
}

function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export const videoApi = {
  capabilities: () => nip.callTool('video_capabilities').then((value) => fromTransport<VideoCapabilities>(value)),
  listProjects: () => nip.callTool('list_video_projects').then((value) => fromTransport<VideoProject[]>(value)),
  createProject: (project: VideoProject) => nip.callTool('create_video_project', { project }).then((value) => fromTransport<VideoProject>(value)),
  getProject: (projectId: string) => nip.callTool('get_video_project', { project_id: projectId }).then((value) => fromTransport<VideoProject>(value)),
  deleteProject: (projectId: string, confirmationName: string) => nip.callTool('delete_video_project', { project_id: projectId, confirmation_name: confirmationName }).then((value) => fromTransport<VideoProjectDeleteResult>(value)),
  getEvent: (eventId: string) => nip.callTool('get_event', { event_id: eventId }).then((value) => fromTransport<VideoSourceEvent>(value)),
  createEpisode: (episode: VideoEpisode) => nip.callTool('create_video_episode', { episode }).then((value) => fromTransport<VideoEpisode>(value)),
  getEpisode: (episodeId: string) => nip.callTool('get_video_episode', { episode_id: episodeId }).then((value) => fromTransport<VideoEpisode>(value)),
  listEpisodes: (projectId: string) => nip.callTool('list_video_episodes', { project_id: projectId }).then((value) => fromTransport<VideoEpisode[]>(value)),
  listProjectAssets: (projectId: string, episodeId?: string, limit = 50) => nip.callTool('list_video_project_assets', { project_id: projectId, ...(episodeId ? { episode_id: episodeId } : {}), limit }).then((value) => fromTransport<VideoAsset[]>(value)),
  listEpisodeVisualSpecs: (projectId: string, episodeId: string) => nip.callTool('list_video_episode_visual_specs', { project_id: projectId, episode_id: episodeId }).then((value) => fromTransport<VideoVisualSpec[]>(value)),
  /**
   * Resolve a managed media path to a webview-asset URL. Returns null outside
   * the desktop host; the UI then keeps the asset metadata but cannot inline
   * the MP4.
   */
  mediaUrl: async (relativePath: string): Promise<string | null> => {
    if (!isDesktopRuntime()) return null
    const path = await invoke<string>('nip_media_file', { relativePath })
    return convertFileSrc(path)
  },
  linkEvidence: (episodeId: string, episodeRevision: number, evidence: VideoEvidenceRef) => nip.callTool('link_video_evidence', { episode_id: episodeId, episode_revision: episodeRevision, evidence }).then((value) => fromTransport<Record<string, unknown>>(value)),
  listEvidence: (episodeId: string, episodeRevision: number) => nip.callTool('list_video_evidence', { episode_id: episodeId, episode_revision: episodeRevision }).then((value) => fromTransport<VideoEvidenceRef[]>(value)),
  saveNarrative: (narrative: VideoNarrative) => nip.callTool('save_video_narrative', { narrative }).then((value) => fromTransport<VideoNarrative>(value)),
  getNarrative: (narrativeId: string) => nip.callTool('get_video_narrative', { narrative_id: narrativeId }).then((value) => fromTransport<VideoNarrative>(value)),
  listNarratives: (episodeId: string, limit = 50) => nip.callTool('list_video_narratives', { episode_id: episodeId, limit }).then((value) => fromTransport<VideoNarrative[]>(value)),
  saveStoryboard: (storyboard: VideoStoryboard) => nip.callTool('save_video_storyboard', { storyboard }).then((value) => fromTransport<VideoStoryboard>(value)),
  saveScene: (scene: VideoScene) => nip.callTool('save_video_scene', { scene }).then((value) => fromTransport<VideoScene>(value)),
  saveShot: (shot: VideoShot) => nip.callTool('save_video_shot', { shot }).then((value) => fromTransport<VideoShot>(value)),
  listAssets: (limit = 50) => nip.callTool('list_video_assets', { limit }).then((value) => fromTransport<VideoAsset[]>(value)),
  linkAssetLineage: (lineage: VideoAssetLineage) => nip.callTool('link_video_asset_lineage', { lineage }).then((value) => fromTransport<VideoAssetLineage>(value)),
  listAssetLineage: (assetId: string, assetRevision: number) => nip.callTool('list_video_asset_lineage', { asset_id: assetId, asset_revision: assetRevision }).then((value) => fromTransport<VideoAssetLineage[]>(value)),
  listWorkflows: () => nip.callTool('list_video_workflows').then((value) => fromTransport<VideoWorkflow[]>(value)),
  saveVisualSpec: (spec: VideoVisualSpec) => nip.callTool('save_video_visual_spec', { spec }).then((value) => fromTransport<VideoVisualSpec>(value)),
  getVisualSpec: (specId: string, revision: number) => nip.callTool('get_video_visual_spec', { spec_id: specId, revision }).then((value) => fromTransport<VideoVisualSpec>(value)),
  listVisualSpecs: (limit = 50) => nip.callTool('list_video_visual_specs', { limit }).then((value) => fromTransport<VideoVisualSpec[]>(value)),
  saveExportManifest: (manifest: VideoExportManifest) => nip.callTool('save_video_export_manifest', { manifest }).then((value) => fromTransport<VideoExportManifest>(value)),
  getExportManifest: (manifestId: string) => nip.callTool('get_video_export_manifest', { manifest_id: manifestId }).then((value) => fromTransport<VideoExportManifest>(value)),
  listExportManifests: (limit = 50) => nip.callTool('list_video_export_manifests', { limit }).then((value) => fromTransport<VideoExportManifest[]>(value)),
  saveQaReport: (report: VideoQaReport) => nip.callTool('save_video_qa_report', { report }).then((value) => fromTransport<VideoQaReport>(value)),
  getQaReport: (reportId: string) => nip.callTool('get_video_qa_report', { report_id: reportId }).then((value) => fromTransport<VideoQaReport>(value)),
  listQaReports: (projectId: string, limit = 50) => nip.callTool('list_video_qa_reports', { project_id: projectId, limit }).then((value) => fromTransport<VideoQaReport[]>(value)),
  saveTimeline: (timeline: VideoTimeline) => nip.callTool('save_video_timeline', { timeline }).then((value) => fromTransport<VideoTimeline>(value)),
  getTimeline: (timelineId: string, revision: number) => nip.callTool('get_video_timeline', { timeline_id: timelineId, revision }).then((value) => fromTransport<VideoTimeline>(value)),
  listTimelines: (projectId: string, limit = 50) => nip.callTool('list_video_timelines', { project_id: projectId, limit }).then((value) => fromTransport<VideoTimeline[]>(value)),
  renderLinkZag: (visualSpecs: Array<{ spec_id: string; revision: number }>, captureMode: 'flash' | 'full' = 'flash', narrate = false) => nip.callTool('render_video_linkzag', { visual_specs: visualSpecs, capture_mode: captureMode, narrate }).then((value) => fromTransport<VideoJob>(value)),
  /**
   * Skill steps 7–9, surfaced in the UI (revamp §d.1 steps 5–6). These
   * call the deterministic EDL/QA/export producers; the UI never authors
   * a QA report, a timeline, or an export manifest itself.
   */
  buildTimeline: (params: {
    project_ref: { id: string; revision: number }
    episode_ref: { id: string; revision: number }
    storyboard_ref: { id: string; revision: number }
    output_profile_id: string
    video_tracks: Array<Record<string, unknown>>
    audio_tracks?: Array<Record<string, unknown>>
    caption_tracks?: Array<Record<string, unknown>>
    gap_policy: 'block'
    request_id: string
  }) => nip.callTool('fina_video_timeline_build', params).then((value) => fromTransport<VideoTimelineBuildResult>(value)),
  getTimelineEdl: (timelineId: string, revision: number) => nip.callTool('fina_video_timeline_get', { timeline_ref: { id: timelineId, revision } }).then((value) => fromTransport<VideoTimelineEdl>(value)),
  runQa: (timelineId: string, timelineRevision: number, qaProfileId: string, requestId: string) => nip.callTool('fina_video_qa_run', { timeline_ref: { id: timelineId, revision: timelineRevision }, qa_profile_id: qaProfileId, request_id: requestId }).then((value) => fromTransport<VideoJob>(value)),
  getQaReportByRef: (reportId: string) => nip.callTool('fina_video_qa_get', { report_ref: { id: reportId, revision: 1 } }).then((value) => value as Record<string, unknown>),
  listExportProfiles: () => nip.callTool('fina_video_export_profiles_list', {}).then((value) => fromTransport<{ profiles: VideoExportProfile[] }>(value)),
  exportPreflight: (timelineId: string, timelineRevision: number, qaReportId: string, exportProfileId: string) => nip.callTool('fina_video_export_preflight', { timeline_ref: { id: timelineId, revision: timelineRevision }, qa_report_ref: { id: qaReportId, revision: 1 }, export_profile_id: exportProfileId }).then((value) => value as Record<string, unknown>),
  exportStart: (timelineId: string, timelineRevision: number, qaReportId: string, exportProfileId: string, requestId: string) => nip.callTool('fina_video_export_start', { timeline_ref: { id: timelineId, revision: timelineRevision }, qa_report_ref: { id: qaReportId, revision: 1 }, export_profile_id: exportProfileId, request_id: requestId }).then((value) => value as Record<string, unknown>),
  getExportManifestV1: (manifestId: string) => nip.callTool('fina_video_export_get', { manifest_ref: { id: manifestId, revision: 1 } }).then((value) => value as Record<string, unknown>),
  getJob: (jobId: string) => nip.callTool('video_job_status', { job_id: jobId }).then((value) => fromTransport<VideoJob>(value)),
  listJobs: (limit = 50) => nip.callTool('list_video_jobs', { limit }).then((value) => fromTransport<VideoJob[]>(value)),
  cancelJob: (jobId: string) => nip.callTool('cancel_video_job', { job_id: jobId }).then((value) => fromTransport<VideoJob>(value)),
  retryJob: (jobId: string) => nip.callTool('retry_video_job', { job_id: jobId }).then((value) => fromTransport<VideoJob>(value)),
}
