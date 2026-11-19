import { nip } from '../../api/nipTransport'
import { toSnakeKeys } from '../../api/keyCase'
import type { VideoAsset, VideoAssetLineage, VideoCapabilities, VideoEpisode, VideoEvidenceRef, VideoExportManifest, VideoJob, VideoNarrative, VideoProject, VideoProjectDeleteResult, VideoQaReport, VideoScene, VideoShot, VideoSourceEvent, VideoStoryboard, VideoTimeline, VideoVisualSpec, VideoWorkflow } from './types'

function fromTransport<T>(value: unknown): T {
  return toSnakeKeys(value) as T
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
  renderLinkZag: (visualSpecs: Array<{ spec_id: string; revision: number }>, captureMode: 'flash' | 'full' = 'flash') => nip.callTool('render_video_linkzag', { visual_specs: visualSpecs, capture_mode: captureMode }).then((value) => fromTransport<VideoJob>(value)),
  getJob: (jobId: string) => nip.callTool('video_job_status', { job_id: jobId }).then((value) => fromTransport<VideoJob>(value)),
  listJobs: (limit = 50) => nip.callTool('list_video_jobs', { limit }).then((value) => fromTransport<VideoJob[]>(value)),
  cancelJob: (jobId: string) => nip.callTool('cancel_video_job', { job_id: jobId }).then((value) => fromTransport<VideoJob>(value)),
  retryJob: (jobId: string) => nip.callTool('retry_video_job', { job_id: jobId }).then((value) => fromTransport<VideoJob>(value)),
}
