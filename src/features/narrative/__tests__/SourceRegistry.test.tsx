import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AddSourceForm, SourceRegistry } from '../components/SourceRegistry'
import { narrativeApi } from '../api'
import type { NipSource } from '../types'

vi.mock('../api', () => ({
  narrativeApi: {
    createSource: vi.fn(),
    updateSource: vi.fn(),
    setSourceState: vi.fn(),
    deleteSource: vi.fn(),
  },
}))

const api = vi.mocked(narrativeApi, true)

const podcast: NipSource = {
  source_id: 'feed-a',
  kind: 'podcast',
  display_name: 'Synthetic show',
  locator: 'http://127.0.0.1:8765/wrong.xml',
  rights_status: 'approved',
  rights_statement: 'User confirmed rights to fetch and process this feed',
  topics: ['macro'],
  state: 'active',
  poll_interval_minutes: 360,
  per_scan_limit: 3,
  notes: null,
  created_at: '2026-11-17T09:00:00Z',
  updated_at: '2026-11-17T09:00:00Z',
  event_count: 2,
  episode_count: 4,
}

const meeting: NipSource = {
  ...podcast,
  source_id: 'meeting-q3',
  kind: 'company_meeting',
  display_name: 'Q3 earnings call',
  locator: 'https://example.invalid/q3',
  topics: ['guidance'],
  event_count: 0,
  episode_count: 0,
}

describe('SourceRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists every kind with lifecycle state, rights and scan caps', () => {
    render(<SourceRegistry sources={[podcast, meeting]} onChanged={vi.fn()} />)
    expect(screen.getByText('Synthetic show')).toBeTruthy()
    expect(screen.getByText('Podcast')).toBeTruthy()
    expect(screen.getByText('Company meeting')).toBeTruthy()
    expect(screen.getAllByText('active')).toHaveLength(2)
    expect(screen.getAllByText('rights approved')).toHaveLength(2)
    expect(screen.getAllByText('3/scan')).toHaveLength(2)
    expect(screen.getByText('2 events · 4 episodes')).toBeTruthy()
    expect(screen.getByText('http://127.0.0.1:8765/wrong.xml')).toBeTruthy()
  })

  it('corrects a wrong podcast URL through update_source', async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined)
    api.updateSource.mockResolvedValue(podcast)
    render(<SourceRegistry sources={[podcast]} scraperInventoryKnown onChanged={onChanged} />)

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const url = screen.getByLabelText('Source locator')
    fireEvent.change(url, { target: { value: 'http://127.0.0.1:8765/feed.xml' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.updateSource).toHaveBeenCalledTimes(1))
    expect(api.updateSource).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'feed-a',
      locator: 'http://127.0.0.1:8765/feed.xml',
      perScanLimit: 3,
    }))
    expect(onChanged).toHaveBeenCalled()
  })

  it('pauses and removes a source through set_source_state', async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined)
    api.setSourceState.mockResolvedValue({ ...podcast, state: 'paused' })
    render(<SourceRegistry sources={[podcast]} scraperInventoryKnown onChanged={onChanged} />)

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await waitFor(() => expect(api.setSourceState).toHaveBeenCalledWith('feed-a', 'paused'))

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.setSourceState).toHaveBeenCalledWith('feed-a', 'removed'))
  })

  it('blocks hard delete while events exist and allows it for an empty source', async () => {
    api.deleteSource.mockResolvedValue({ source_id: 'meeting-q3', deleted: true })
    const onChanged = vi.fn().mockResolvedValue(undefined)
    render(<SourceRegistry sources={[podcast, meeting]} onChanged={onChanged} />)

    const [podcastDelete, meetingDelete] = screen.getAllByRole('button', { name: 'Delete' })
    expect(podcastDelete?.hasAttribute('disabled')).toBe(true)

    fireEvent.click(meetingDelete!)
    await waitFor(() => expect(api.deleteSource).toHaveBeenCalledWith('meeting-q3'))
  })

  it('shows removed sources only behind the toggle', () => {
    render(<SourceRegistry sources={[{ ...podcast, state: 'removed' }]} onChanged={vi.fn()} />)
    expect(screen.queryByText('Synthetic show')).toBeNull()
    fireEvent.click(screen.getByTestId('show-removed'))
    expect(screen.getByText('Synthetic show')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy()
  })
})

describe('AddSourceForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates a non-podcast source kind without an initial fetch', async () => {
    api.createSource.mockResolvedValue(meeting)
    const onSubmitted = vi.fn().mockResolvedValue(undefined)
    render(<AddSourceForm onSubmitted={onSubmitted} />)

    fireEvent.change(screen.getByTestId('source-kind'), { target: { value: 'company_meeting' } })
    fireEvent.change(screen.getByLabelText('Source ID'), { target: { value: 'meeting-q3' } })
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Q3 earnings call' } })
    fireEvent.change(screen.getByLabelText('Source locator'), { target: { value: 'https://example.invalid/q3' } })
    fireEvent.change(screen.getByLabelText('Rights statement'), { target: { value: 'Internal transcript cleared for local retention' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Register source' }))

    await waitFor(() => expect(api.createSource).toHaveBeenCalledTimes(1))
    expect(api.createSource).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'meeting-q3',
      kind: 'company_meeting',
      locator: 'https://example.invalid/q3',
      userConfirmedRights: true,
    }))
    expect(onSubmitted).toHaveBeenCalled()
  })

  it('keeps the podcast path as the default kind', async () => {
    api.createSource.mockResolvedValue(podcast)
    render(<AddSourceForm onSubmitted={vi.fn().mockResolvedValue(undefined)} />)

    expect((screen.getByTestId('source-kind') as HTMLSelectElement).value).toBe('podcast')
    expect(screen.getByLabelText('Podcast feed URL')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve and sync' })).toBeTruthy()
  })
})
