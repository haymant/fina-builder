import { createHash } from 'node:crypto'
import http from 'node:http'

// Deterministic stand-in for the desktop host's loopback RIGA provider bridge.
// It exists only for the local Playwright NIP journey. It never contacts a
// remote provider, never logs transcript content, and is bound to loopback.
const port = Number(process.env.NIP_BRIDGE_FIXTURE_PORT ?? 8796)
const token = process.env.NIP_BRIDGE_FIXTURE_TOKEN ?? 'nip-e2e-bridge-token'
const providerId = 'riga-fixture-provider'
const model = 'fixture-claim-model'
const promptVersion = 'nip-claims-riga-bridge-v1'
const maxBodyBytes = 256 * 1024

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function authorized(request) {
  return request.headers.authorization === `Bearer ${token}`
}

function stableSuffix(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBodyBytes) {
        reject(new Error('request body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function claimsFor(contentText) {
  const definitions = [
    {
      text: 'Maya Chen expects policy to remain restrictive until inflation cools.',
      speaker_or_author: 'Host Maya Chen',
      confidence_millis: 910,
      quote: 'The fixture research team expects policy to remain restrictive until inflation cools.',
    },
    {
      text: 'Arun Patel says the Federal Reserve outlook remains unconfirmed while Acme Energy expects lower refinancing costs.',
      speaker_or_author: 'Guest Arun Patel',
      confidence_millis: 880,
      quote: 'The Federal Reserve has not independently confirmed the outlook, while Acme Energy expects refinancing costs to ease next quarter.',
    },
    {
      text: "Maya Chen says Treasury's supply plan is conditional and Acme Energy's forecast is not official guidance.",
      speaker_or_author: 'Host Maya Chen',
      confidence_millis: 900,
      quote: "Treasury officials say the supply plan is conditional, and Acme Energy's forecast remains a company view, not official guidance.",
    },
  ]
  const matchingClaims = definitions.flatMap((definition) => {
    const start = contentText.indexOf(definition.quote)
    return start < 0 ? [] : [{
      ...definition,
      start_offset: start,
      end_offset: start + definition.quote.length,
    }]
  })
  if (matchingClaims.length) return matchingClaims

  const quote = 'policy to remain restrictive until inflation cools'
  const start = contentText.indexOf(quote)
  return [{
    text: 'Policy is expected to remain restrictive until inflation cools.',
    speaker_or_author: 'Fixture research team',
    confidence_millis: 910,
    quote: start >= 0 ? quote : contentText.slice(0, Math.min(80, contentText.length)),
    ...(start >= 0 ? { start_offset: start, end_offset: start + quote.length } : {}),
  }]
}

const server = http.createServer(async (request, response) => {
  if (request.url === '/health') {
    json(response, 200, { service: 'nip-provider-bridge-fixture', ready: true })
    return
  }
  if (!authorized(request)) {
    json(response, 401, { error: 'unauthorized' })
    return
  }
  if (request.method === 'GET' && request.url === '/provider_status') {
    json(response, 200, {
      configured: true,
      provider_kind: 'remote',
      provider_id: providerId,
      model,
      reasoning_effort: 'low',
      provider_api: 'chat',
      provider_type: 'open_ai_compatible',
      warnings: ['illustrative_fixture_provider'],
    })
    return
  }
  if (request.method === 'POST' && request.url === '/claims/extract') {
    let body
    try {
      body = JSON.parse(await readBody(request))
    } catch {
      json(response, 400, { error: 'invalid_request' })
      return
    }
    const eventId = typeof body.event_id === 'string' ? body.event_id : ''
    const contentText = typeof body.content_text === 'string' ? body.content_text : ''
    if (!eventId || !contentText.trim()) {
      json(response, 400, { error: 'invalid_request' })
      return
    }
    const claims = claimsFor(contentText)
    json(response, 200, {
      extraction_run_id: `run-bridge-${stableSuffix(`${eventId}\0${contentText}`)}`,
      provider_kind: 'remote',
      provider_id: providerId,
      model,
      reasoning_effort: 'low',
      prompt_version: promptVersion,
      claims,
    })
    return
  }
  json(response, 404, { error: 'not_found' })
})

server.listen(port, '127.0.0.1', () => {
  console.error(`nip-provider-bridge-fixture listening on 127.0.0.1:${port}`)
})
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
