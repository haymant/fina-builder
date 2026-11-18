import { expect, test } from './fixtures/test'
import { TAG } from './support/tags'
import { WorkspacePage } from './pages/WorkspacePage'

/**
 * Narrated product demo with overlay highlights.
 *
 * Recording:
 *   PLAYWRIGHT_NIP=on PLAYWRIGHT_VIDEO=on npx playwright test \
 *     playwright/narrative-intelligence-demo.spec.ts --grep @demo-narrative-research
 *
 * The `demo` fixture injects fixed overlay highlights/annotations above the UI
 * (see playwright/support/demo.ts). It never modifies the page and pauses 5s
 * wherever the viewer needs to read or verify something.
 */
test('sets up NIP, approves a feed, transcribes, extracts evidence, and reviews the derived workspace', {
  tag: [TAG.demo.any, TAG.demo.narrativeResearch, TAG.journey.narrativeSetup, TAG.journey.narrativeIngestion, TAG.journey.narrativeEvidenceReview, TAG.feature.narrativeSetup, TAG.feature.narrativeSources, TAG.feature.narrativeEvents, TAG.feature.narrativeClaims, TAG.dependency.nip, TAG.priority.p1],
}, async ({ page, demo }) => {
  test.skip(process.env.PLAYWRIGHT_NIP !== 'on', 'run with PLAYWRIGHT_NIP=on for the real loopback NIP service')
  test.setTimeout(240_000)

  const workspace = new WorkspacePage(page)
  const checklist = page.getByTestId('nip-setup-checklist')

  await test.step('Open Narrative Intelligence from the desktop menu', async () => {
    await demo.step('Open Narrative Intelligence', async () => {
      await workspace.open()
      demo.cue('Workspace ready')
      await demo.highlight(page.getByTestId('menu-narrative'), 'Narrative workspace')
      await demo.caption('Narrative Intelligence', 'Synthetic fixture data · runs on the local NIP ledger · no remote ASR.')
      await demo.pause()
      await page.getByTestId('menu-narrative').click()
      await page.getByTestId('menuitem-narrative-overview').click()
      await expect(page.getByRole('heading', { name: 'Narrative Intelligence' })).toBeVisible()
      demo.cue('Workspace open')
      await demo.pause()
    })
  })

  await test.step('Review first-run setup and source boundaries', async () => {
    await demo.step('First-run checklist', async () => {
      await expect(checklist).toBeVisible()
      await demo.verify(checklist, 'Five steps from source rights to evidence-linked claims')
      await demo.caption('First-run setup', 'Verify: DuckDB schema, extraction provider, approved feeds, retained transcript.')
      await demo.pause(6_000)
      await expect(checklist).toContainText('DuckDB schema v9')
      await expect(checklist).toContainText('Extraction provider')
      await expect(checklist.getByText('Approved source')).toBeVisible()
    })
  })

  await test.step('Approve one podcast feed with rights confirmation', async () => {
    await demo.step('Approve a feed', async () => {
      const source = page.getByLabel('Source ID')
      const feed = page.getByLabel('Podcast feed URL')
      const rights = page.getByLabel('Rights statement')
      const confirm = page.getByLabel(/I confirm access and retention rights/)
      await source.fill('demo-fixture-feed')
      await feed.fill('http://127.0.0.1:8795/fixture/feed.xml')
      await page.getByLabel('Show name').fill('Illustrative Test Corpus')
      await rights.fill('Synthetic fixture approved for local processing and retention.')
      await demo.verify(page.getByTestId('add-source-form'), 'Rights are recorded before the first fetch')
      await demo.caption('Approve a source', 'Verify: the confirmation is required; approval triggers one initial sync.')
      await demo.pause()
      await confirm.check()
      await demo.click(page.getByRole('button', { name: 'Approve and sync' }), 'Approve and sync')
      await expect(page.getByText('Feed approved and initial sync requested.')).toBeVisible()
      await expect(page.getByText('Illustrative Test Corpus').first()).toBeVisible()
      await demo.pause()
    })
  })

  await test.step('Inspect the automatically discovered episode', async () => {
    await demo.step('Discovered episode', async () => {
      await expect(page.getByText('Policy outlook fixture').first()).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText('awaiting local transcription')).toBeVisible()
      await demo.verify(page.getByText('Policy outlook fixture').first(), 'RSS metadata only until you transcribe')
      await demo.caption('Discovered episodes', 'Verify: title, GUID, published time and state; audio is a separate explicit step.')
      await demo.pause()
    })
  })

  await test.step('Transcribe the episode locally', async () => {
    await demo.step('Transcribe locally', async () => {
      await demo.click(page.getByRole('button', { name: 'Transcribe locally' }), 'Start a local ASR job')
      await expect(page.getByText(/Started job-/)).toBeVisible()
      await demo.caption('Local transcription job', 'Watch: download → split into 5-minute chunks → transcribe n/N → commit. Cached audio stays reviewable.')
      await demo.pause()
      await expect(page.getByText('Transcript committed.', { exact: false })).toBeVisible({ timeout: 120_000 })
      await demo.verify(page.getByText('Transcript committed.', { exact: false }).first(), 'Final state: committed transcript')
      await demo.pause(6_000)
    })
  })

  await test.step('Open the retained transcript and its provenance', async () => {
    await demo.step('Retained transcript', async () => {
      await demo.click(page.getByRole('button', { name: /Open retained transcript/ }).first(), 'Open the immutable origin event')
      await expect(page.getByText(/Source-linked record/)).toBeVisible()
      await expect(page.locator('.event-detail').getByText(/fixture research team expects policy/)).toBeVisible()
      await demo.verify(page.locator('.event-detail'), 'Origin event with source, times and content hash')
      await demo.caption('Retained event', 'Verify: source, published/captured/ingested timestamps, and content hash.')
      await demo.pause(6_500)
    })
  })

  await test.step('Grant NIP consent for the remote extraction provider', async () => {
    await demo.step('Remote extraction consent', async () => {
      const consent = page.getByTestId('event-consent-grant')
      if (await consent.isVisible()) {
        await demo.verify(page.getByTestId('event-consent'), 'Transcript text would leave this device')
        await demo.caption('Consent gate', 'Verify: remote extraction is blocked until you allow this provider/model.')
        await demo.pause()
        await demo.click(consent, 'Allow remote extraction')
        await expect(page.getByTestId('event-consent')).toHaveCount(0)
        demo.cue('Consent recorded')
      }
      await demo.pause()
    })
  })

  await test.step('Extract evidence-linked claims from the transcript', async () => {
    await demo.step('Extract claims', async () => {
      await demo.click(page.getByRole('button', { name: 'Extract claims' }), 'Extract claims from this origin')
      await expect(page.getByText('1 claim committed with source evidence.')).toBeVisible()
      await expect(checklist).toContainText('5/5 complete')
      await demo.caption('Claims', 'Verify: every claim points back to the retained event and quote.')
      await demo.pause()
    })
  })

  await test.step('Review the claim and its source evidence', async () => {
    await demo.step('Claim Explorer', async () => {
      await page.getByRole('tab', { name: 'Claim Explorer' }).click()
      await expect(page.getByRole('heading', { name: /Policy is expected to remain restrictive/ })).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Source evidence' })).toBeVisible()
      await demo.verify(page.locator('.claim-detail'), 'Claim, evidence quote and derivation provenance')
      await demo.caption('Claim Explorer', 'Verify: confidence, provider/model, prompt version and linked evidence.')
      await demo.pause(6_500)
    })
  })

  await test.step('Rebuild the cluster and graph projections', async () => {
    await demo.step('Graph projection', async () => {
      await page.getByRole('tab', { name: 'Graph' }).click()
      await demo.click(page.getByRole('button', { name: 'Rebuild clusters' }), 'Cluster retained events')
      await expect(page.getByText(/narrative cluster.* rebuilt from canonical events/)).toBeVisible()
      await demo.pause()
      await demo.click(page.getByRole('button', { name: 'Rebuild graph' }), 'Rebuild the evidence-linked projection')
      await expect(page.getByText(/evidence-linked edges/)).toBeVisible()
      await demo.verify(page.getByText('Retained origins').first(), 'Every origin node is a retained event')
      await demo.caption('Narrative Graph', 'Verify: origin nodes, claim nodes and evidence edges; every edge cites its source event.')
      await demo.pause(6_000)
    })
  })

  await test.step('Follow a graph edge back to the immutable source event', async () => {
    await demo.step('Graph → origin', async () => {
      await demo.click(page.getByRole('button', { name: /Origin / }).first(), 'Follow an evidence link')
      await expect(page.getByText(/Source-linked record/)).toBeVisible()
      await demo.caption('Origin record', 'Verify: the graph reference opens the immutable event, not a copy.')
      await demo.pause()
    })
  })

  await test.step('Review the descriptive Radar and Timeline windows', async () => {
    await demo.step('Radar and Timeline', async () => {
      await page.getByRole('tab', { name: 'Radar' }).click()
      await expect(page.getByRole('heading', { name: 'Narrative Radar' })).toBeVisible()
      await demo.verify(page.locator('.narrative-card-body').first(), 'Descriptive signal counts, not a score')
      await demo.caption('Radar', 'Verify: the coverage label is honest and no ranking is implied as investment advice.')
      await demo.pause(6_000)
      await page.getByRole('tab', { name: 'Timeline' }).click()
      await expect(page.getByRole('heading', { name: 'Narrative Timeline' })).toBeVisible()
      await demo.pause(6_000)
    })
  })

  await test.step('Review the ETF and editorial research boundaries', async () => {
    await demo.step('Research boundaries', async () => {
      await page.getByRole('tab', { name: 'ETF Themes' }).click()
      await expect(page.getByRole('heading', { name: 'ETF Themes' })).toBeVisible()
      await demo.verify(page.getByText(/No manual ETF mappings yet/), 'Mappings require a dated rationale')
      await demo.caption('ETF Themes', 'Verify: no mappings, ticker validation or market-data coverage are invented.')
      await demo.pause()
      await page.getByRole('tab', { name: 'Editorial' }).click()
      await expect(page.getByRole('heading', { name: 'Editorial Planning' })).toBeVisible()
      await expect(page.getByText(/Awaiting human review|No editorial candidates yet/)).toBeVisible()
      await demo.caption('Editorial', 'Verify: candidates stay unreviewed until a human decision is recorded.')
      await demo.pause()
    })
  })

  await test.step('Review cached audio and the transcription step log', async () => {
    await demo.step('Cached media review', async () => {
      await page.getByRole('tab', { name: 'Event review' }).click()
      await expect(checklist).toContainText('5/5 complete')
      await demo.verify(page.getByText('Cached media').first(), 'Replay the audio NIP downloaded')
      await demo.caption('Cached media', 'Verify: the exact downloaded audio and transcript preview are reviewable and deletable.')
      await demo.pause(6_000)
    })
  })

  await test.step('Return to the completed setup checklist', async () => {
    await demo.step('Close', async () => {
      await demo.verify(checklist, 'All five steps complete')
      await demo.caption('Narrative Intelligence', 'Synthetic fixture run for a repeatable demo: rights → discovery → transcription → evidence → derived projections.')
      await demo.pause(8_500)
    })
  })
})
