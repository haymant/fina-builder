import type { NipTranscriptionJob } from './types'

export function jobIsActive(job: NipTranscriptionJob | null | undefined): boolean {
  return Boolean(job && !['transcribed', 'failed', 'cancelled'].includes(job.state))
}
