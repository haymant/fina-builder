import fs from 'node:fs/promises'

const MCP_URL = process.env.NIP_MCP_URL ?? 'http://127.0.0.1:8802/mcp'
const corpusPath = new URL('../benchmarks/nip-financial-corpus.json', import.meta.url)
const corpus = JSON.parse(await fs.readFile(corpusPath, 'utf8'))
const queries = [
  { id: 'q01', text: 'higher interest rates net interest income credit losses', relevant: ['jpm-rates-credit-2024'] },
  { id: 'q02', text: 'stress testing risk models capital liquidity regulatory scrutiny', relevant: ['jpm-risk-models-2024', 'jpm-capital-liquidity-2024'] },
  { id: 'q03', text: 'AI infrastructure cloud datacenters GPUs capital investment', relevant: ['msft-cloud-ai-investment-2024', 'msft-datacenter-supply-2024'] },
  { id: 'q04', text: 'cloud AI infrastructure costs reduce operating margins', relevant: ['msft-cloud-margin-risk-2024'] },
  { id: 'q05', text: 'semiconductor manufacturing lead times supply capacity premiums', relevant: ['nvda-demand-supply-2025', 'nvda-supply-chain-concentration-2025'] },
  { id: 'q06', text: 'demand estimates customer orders excess inventory shortages', relevant: ['nvda-inventory-mismatch-2025'] },
  { id: 'q07', text: 'refining margins capacity additions global demand oversupply', relevant: ['xom-refining-margins-2024'] },
  { id: 'q08', text: 'energy demand recession economic growth commodity margins', relevant: ['xom-commodity-demand-2024'] },
  { id: 'q09', text: 'firm order backlog billion construction industries energy transportation', relevant: ['cat-backlog-2024'] },
  { id: 'q10', text: 'dealer rental fleet construction demand infrastructure investment', relevant: ['cat-construction-outlook-2024'] },
  { id: 'q11', text: 'supplier financial viability production flexibility component constraints', relevant: ['cat-supplier-components-2024'] },
  { id: 'q12', text: 'hydrogen carbon capture lithium supportive government policies commercial scale', relevant: ['xom-energy-transition-2024'] },
]

let id = 1
let sessionId
async function rpc(method, params = {}, notify = false) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId
  const response = await fetch(MCP_URL, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id: id++ }), method, params }),
  })
  sessionId = response.headers.get('Mcp-Session-Id') ?? sessionId
  if (notify) return undefined
  const body = await response.json()
  if (body.error) throw new Error(JSON.stringify(body.error))
  const result = body.result
  if (result?.structuredContent !== undefined) return result.structuredContent
  const text = result?.content?.find((item) => item.text)?.text
  return text ? JSON.parse(text) : result
}

function tokens(text) {
  return new Set(text.toLowerCase().replace(/[^a-z0-9$]+/g, ' ').split(/\s+/).filter((x) => x.length > 2))
}
function lexicalScore(query, doc) {
  const q = tokens(query)
  const d = tokens(doc.content)
  let score = 0
  for (const token of q) if (d.has(token)) score += 1
  return score / Math.max(1, q.size)
}
function rankMetrics(rankedIds, relevant, k) {
  const relevantSet = new Set(relevant)
  const top = rankedIds.slice(0, k)
  const hits = top.filter((id) => relevantSet.has(id)).length
  const first = rankedIds.findIndex((id) => relevantSet.has(id))
  let dcg = 0
  for (let i = 0; i < top.length; i += 1) if (relevantSet.has(top[i])) dcg += 1 / Math.log2(i + 2)
  let idcg = 0
  for (let i = 0; i < Math.min(k, relevant.length); i += 1) idcg += 1 / Math.log2(i + 2)
  return {
    recall: hits / relevant.length,
    precision: hits / k,
    mrr: first < 0 ? 0 : 1 / (first + 1),
    ndcg: idcg === 0 ? 0 : dcg / idcg,
  }
}
function mean(rows, key) { return rows.reduce((sum, row) => sum + row[key], 0) / rows.length }

await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'nip-semantic-benchmark', version: '1.0.0' } })
await rpc('notifications/initialized', {}, true)

for (const doc of corpus) {
  await rpc('tools/call', { name: 'import_local_event', arguments: { import: {
    source_id: `sec-${doc.company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    source_display_name: `${doc.company} 2024/2025 Form 10-K`,
    source_native_id: doc.id,
    canonical_url: doc.source_url,
    title: `${doc.company}: ${doc.topic}`,
    content_text: doc.content,
    published_at: '2025-01-01T00:00:00Z',
    source_updated_at: '2025-01-01T00:00:00Z',
    rights_statement: 'Public SEC filing excerpt used for local retrieval evaluation.',
    user_confirmed_rights: true,
  } } })
}
const manifest = await rpc('tools/call', { name: 'rebuild_semantic_index', arguments: {} })
if (manifest.status !== 'ready' || manifest.event_count !== corpus.length) throw new Error(`Index rebuild failed: ${JSON.stringify(manifest)}`)

const eventsPage = await rpc('tools/call', { name: 'search_events', arguments: { limit: 50 } })
const eventIdByNativeId = new Map(eventsPage.events.map((event) => [event.source_native_id, event.event_id]))
if (eventIdByNativeId.size !== corpus.length) throw new Error(`Expected ${corpus.length} events, got ${eventIdByNativeId.size}`)

const rows = []
for (const query of queries) {
  const semantic = await rpc('tools/call', { name: 'semantic_search', arguments: { text: query.text, limit: 10 } })
  const semanticIds = semantic.map((result) => result.event.source_native_id)
  const lexicalIds = [...corpus].sort((a, b) => lexicalScore(query.text, b) - lexicalScore(query.text, a)).map((doc) => doc.id)
  const semanticMetrics = rankMetrics(semanticIds, query.relevant, 5)
  const lexicalMetrics = rankMetrics(lexicalIds, query.relevant, 5)
  rows.push({ ...query, semantic_ids: semanticIds, lexical_ids: lexicalIds.slice(0, 5), semantic_metrics: semanticMetrics, lexical_metrics: lexicalMetrics })
}

const summary = {
  benchmark: 'NIP financial semantic retrieval benchmark',
  generated_at: new Date().toISOString(),
  corpus_documents: corpus.length,
  query_count: queries.length,
  k: 5,
  embedding_model: process.env.NIP_EMBEDDING_MODEL ?? 'benchmark-financial-hash',
  embedding_dimensions: Number(process.env.NIP_EMBEDDING_DIMENSIONS ?? 8),
  manifest,
  hybrid: {
    recall_at_5: mean(rows.map((r) => r.semantic_metrics), 'recall'),
    precision_at_5: mean(rows.map((r) => r.semantic_metrics), 'precision'),
    mrr: mean(rows.map((r) => r.semantic_metrics), 'mrr'),
    ndcg_at_5: mean(rows.map((r) => r.semantic_metrics), 'ndcg'),
  },
  lexical_baseline: {
    recall_at_5: mean(rows.map((r) => r.lexical_metrics), 'recall'),
    precision_at_5: mean(rows.map((r) => r.lexical_metrics), 'precision'),
    mrr: mean(rows.map((r) => r.lexical_metrics), 'mrr'),
    ndcg_at_5: mean(rows.map((r) => r.lexical_metrics), 'ndcg'),
  },
  rows,
  sources: [...new Set(corpus.map((doc) => doc.source_url))],
}

const outDir = new URL('../artifacts/benchmark/', import.meta.url)
await fs.mkdir(outDir, { recursive: true })
await fs.writeFile(new URL('nip-financial-retrieval.json', outDir), JSON.stringify({ corpus, queries, ...summary }, null, 2) + '\n')
const md = `# NIP financial retrieval benchmark\n\nGenerated: ${summary.generated_at}\n\nCorpus: ${summary.corpus_documents} SEC filing excerpts from five issuers. Queries: ${summary.query_count}. Metrics are averaged over queries at k=${summary.k}.\n\n| System | Recall@5 | Precision@5 | MRR | nDCG@5 |\n|---|---:|---:|---:|---:|\n| Qdrant hybrid dense + lexical | ${(summary.hybrid.recall_at_5 * 100).toFixed(1)}% | ${(summary.hybrid.precision_at_5 * 100).toFixed(1)}% | ${summary.hybrid.mrr.toFixed(3)} | ${summary.hybrid.ndcg_at_5.toFixed(3)} |\n| Token-overlap lexical baseline | ${(summary.lexical_baseline.recall_at_5 * 100).toFixed(1)}% | ${(summary.lexical_baseline.precision_at_5 * 100).toFixed(1)}% | ${summary.lexical_baseline.mrr.toFixed(3)} | ${summary.lexical_baseline.ndcg_at_5.toFixed(3)} |\n\nThe Qdrant run used model identity \`${summary.embedding_model}\` with ${summary.embedding_dimensions} dimensions and a deterministic local embedding fixture. This is an integration and ranking-regression benchmark, not evidence of BGE-M3 quality; a production-quality model endpoint must be benchmarked separately before enabling quality claims.\n\n## Per-query results\n\n${rows.map((row) => `- **${row.id} — ${row.text}**\n  - Relevant: ${row.relevant.join(', ')}\n  - Hybrid top-5: ${row.semantic_ids.slice(0, 5).join(', ')}\n  - Lexical top-5: ${row.lexical_ids.join(', ')}\n  - Hybrid metrics: Recall ${row.semantic_metrics.recall.toFixed(3)}, MRR ${row.semantic_metrics.mrr.toFixed(3)}, nDCG ${row.semantic_metrics.ndcg.toFixed(3)}`).join('\n')}\n\n## Sources\n\n${summary.sources.map((url, i) => `${i + 1}. ${url}`).join('\n')}\n`
await fs.writeFile(new URL('nip-financial-retrieval.md', outDir), md)
console.log(JSON.stringify(summary, null, 2))
