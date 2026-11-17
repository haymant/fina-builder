import http from 'node:http'

const port = Number(process.env.NIP_FIXTURE_PORT ?? 8795)
const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>Illustrative Test Corpus</title><item><guid>nip-fixture-episode-1</guid><title>Policy outlook fixture</title><link>http://127.0.0.1:${port}/fixture/episode-1</link><pubDate>Sun, 15 Nov 2026 12:00:00 +0000</pubDate><enclosure url="http://127.0.0.1:${port}/fixture/episode-1.mp3" type="audio/mpeg"/></item></channel></rss>`
const audio = Buffer.from('synthetic-rights-cleared-audio-fixture-v1')

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
  if (request.url === '/fixture/episode-1.mp3') {
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
