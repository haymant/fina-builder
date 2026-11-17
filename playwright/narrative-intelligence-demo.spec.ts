import { expect, test } from './fixtures/test'
import { TAG } from './support/tags'
import { WorkspacePage } from './pages/WorkspacePage'

const MCP_URL = 'http://127.0.0.1:8794/mcp'
let rpcId = 1
let sessionId: string | undefined

async function nipTool(name: string, args: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId
  const rpc = async (method: string, params: Record<string, unknown>, notify = false) => {
    const id = notify ? undefined : rpcId++
    const response = await fetch(MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, params }),
    })
    sessionId = response.headers.get('Mcp-Session-Id') ?? sessionId
    if (notify) return undefined
    const body = await response.json() as { result?: { structuredContent?: unknown; content?: Array<{ text?: string }> }; error?: { message: string } }
    if (body.error) throw new Error(body.error.message)
    const result = body.result
    if (result?.structuredContent !== undefined) return result.structuredContent
    const text = result?.content?.find((item) => item.text)?.text
    return text ? JSON.parse(text) : result
  }
  if (!sessionId) {
    await rpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'narrative-demo-seeder', version: '0.1.0' },
    })
    await rpc('notifications/initialized', {}, true)
  }
  return rpc('tools/call', { name, arguments: args })
}

test('subscribes once, reviews a fixture transcript, and opens evidence-linked claims', {
  tag: [TAG.demo.any, TAG.demo.narrativeResearch, TAG.journey.narrativeIngestion, TAG.journey.narrativeEvidenceReview, TAG.feature.narrativeEvents, TAG.feature.narrativeClaims, TAG.dependency.nip, TAG.priority.p1],
}, async ({ page }) => {
  test.skip(process.env.PLAYWRIGHT_NIP !== 'on', 'run with PLAYWRIGHT_NIP=on for the real loopback NIP service')
  test.setTimeout(120_000)

  await test.step('Prepare the illustrative loopback corpus', async () => {
    await nipTool('subscribe_podcast_feed', {
      source_id: 'fixture-podcast',
      feed_url: 'http://127.0.0.1:8795/fixture/feed.xml',
      show_name: 'Illustrative Test Corpus',
      rights_statement: 'Synthetic fixture approved for local processing and retention.',
      user_confirmed_rights: true,
    })
    await nipTool('transcribe_podcast_episode', {
      source_id: 'fixture-podcast',
      source_native_id: 'nip-fixture-episode-1',
    })
    const search = await nipTool('search_events', { source_id: 'fixture-podcast', limit: 10 }) as { events: Array<Record<string, unknown>> }
    expect(search.events).toHaveLength(1)
    await nipTool('extract_claims', { event: search.events[0] })
    await nipTool('rebuild_narrative_clusters')
    await nipTool('rebuild_narrative_graph')
  })

  const workspace = new WorkspacePage(page)
  await test.step('Open the Narrative Intelligence workspace', async () => {
    await workspace.open()
    await page.getByTestId('menu-narrative').click()
    await page.getByTestId('menuitem-narrative-overview').click()
    await expect(page.getByRole('heading', { name: 'Narrative Intelligence' })).toBeVisible()
    await expect(page.getByText('Illustrative Test Corpus').first()).toBeVisible()
    await expect(page.getByText(/Operational monitor/)).toBeVisible()
    await expect(page.getByText(/1 claims · 1 runs/)).toBeVisible()
    await page.waitForTimeout(3_000)
  })

  await test.step('Review the retained transcript provenance', async () => {
    await expect(page.getByText('nip-fixture-episode-1')).toBeVisible()
    await page.getByRole('button', { name: /nip-fixture-episode-1/ }).click()
    await expect(page.getByText(/Source-linked record/)).toBeVisible()
    await expect(page.getByText(/fixture research team expects policy/).last()).toBeVisible()
    await page.waitForTimeout(4_000)
  })

  await test.step('Review the Phase 2 Radar and Timeline', async () => {
    await page.getByRole('tab', { name: 'Radar' }).click()
    await expect(page.getByRole('heading', { name: 'Narrative Radar' })).toBeVisible()
    await expect(page.getByText(/unknown coverage/)).toBeVisible()
    await page.getByRole('tab', { name: 'Timeline' }).click()
    await expect(page.getByRole('heading', { name: 'Narrative Timeline' })).toBeVisible()
    await page.waitForTimeout(3_000)
  })
  await test.step('Inspect the versioned graph and return to evidence', async () => {
    await page.getByRole('tab', { name: 'Graph' }).click()
    await expect(page.getByRole('heading', { name: 'Narrative Graph' })).toBeVisible()
    await expect(page.getByText(/evidence-linked edges/)).toBeVisible()
    await page.getByRole('button', { name: /Rebuild graph/ }).click()
    await expect(page.getByText(/evidence-linked edges/)).toBeVisible()
    await expect(page.getByRole('button', { name: /Evidence event-/ }).first()).toBeVisible()
    await page.getByRole('button', { name: /Evidence event-/ }).first().click()
    await expect(page.getByText(/Source-linked record/)).toBeVisible()
    await page.waitForTimeout(3_000)
  })
  await test.step('Review Phase 3 research boundaries', async () => {
    await page.getByRole('tab', { name: 'ETF Themes' }).click()
    await expect(page.getByRole('heading', { name: 'ETF Themes' })).toBeVisible()
    await expect(page.getByText(/No manual ETF mappings yet/)).toBeVisible()
    await page.getByRole('tab', { name: 'Editorial' }).click()
    await expect(page.getByRole('heading', { name: 'Editorial Planning' })).toBeVisible()
    await expect(page.getByText(/Awaiting human review|No editorial candidates yet/)).toBeVisible()
    await page.waitForTimeout(3_000)
  })
  await test.step('Inspect the evidence-linked claim', async () => {
    await page.getByRole('tab', { name: 'Claim Explorer' }).click()
    await expect(page.getByRole('heading', { name: /fixture research team expects policy/ })).toBeVisible()
    await expect(page.getByText('Source evidence')).toBeVisible()
    await expect(page.getByText('deterministic_fake', { exact: true })).toBeVisible()
    await page.waitForTimeout(5_000)
  })
})
