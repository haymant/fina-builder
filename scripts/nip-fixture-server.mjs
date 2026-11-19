import http from 'node:http'

const port = Number(process.env.NIP_FIXTURE_PORT ?? 8795)
const audio = Buffer.from('synthetic-rights-cleared-audio-fixture-v1')
const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Illustrative Test Corpus</title><item><guid>nip-fixture-episode-1</guid><title>Policy outlook fixture</title><link>http://127.0.0.1:${port}/fixture/episode-1</link><pubDate>Sun, 15 Nov 2026 12:00:00 +0000</pubDate><enclosure url="http://127.0.0.1:${port}/fixture/episode-1.mp3" type="audio/mpeg"/></item></channel></rss>`

function lastCompletedWeekDate(dayOffset) {
  const monday = new Date()
  monday.setUTCHours(0, 0, 0, 0)
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
  monday.setUTCDate(monday.getUTCDate() - 7 + dayOffset)
  monday.setUTCHours(12, 0, 0, 0)
  return monday.toUTCString()
}

const multiSpeakerEpisodes = [
  { guid: 'nip-fixture-multi-1', title: 'Policy outlook fixture', day: 5, audio: 1 },
  { guid: 'nip-fixture-multi-2', title: 'Federal Reserve and issuer outlook', day: 3, audio: 2 },
  { guid: 'nip-fixture-multi-3', title: 'Treasury supply and company outlook', day: 1, audio: 3 },
]
const multiSpeakerFeed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Multi-speaker entity graph fixture</title>${multiSpeakerEpisodes.map((episode) => `<item><guid>${episode.guid}</guid><title>${episode.title}</title><link>http://127.0.0.1:${port}/fixture/${episode.guid}</link><pubDate>${lastCompletedWeekDate(episode.day)}</pubDate><enclosure url="http://127.0.0.1:${port}/fixture/episode-${episode.audio}.mp3" type="audio/mpeg"/></item>`).join('')}</channel></rss>`

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ service: 'nip-fixture', ready: true }))
    return
  }
  if (request.url === '/fixture/feed.xml') {
    response.writeHead(200, { 'content-type': 'application/rss+xml', etag: '"nip-fixture-v1"' })
    response.end(feed)
    return
  }
  if (request.url === '/fixture/multi-speaker-feed.xml') {
    response.writeHead(200, { 'content-type': 'application/rss+xml', etag: '"nip-fixture-multi-speaker-v1"' })
    response.end(multiSpeakerFeed)
    return
  }
  if (/^\/fixture\/episode-[1-3]\.mp3$/u.test(request.url ?? '')) {
    response.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length })
    response.end(audio)
    return
  }
  response.writeHead(404)
  response.end()
})

server.listen(port, '127.0.0.1', () => console.error(`nip-fixture listening on 127.0.0.1:${port}`))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
process.on('SIGINT', () => server.close(() => process.exit(0)))
