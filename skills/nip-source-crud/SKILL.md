---
name: nip-source-crud
description: Create, read, update, pause/resume, remove and delete NIP sources of any kind (podcast, company meeting, filing, Reddit, X, web, local document) through the NIP MCP tools, and correct mistaken locators without losing retained evidence.
---

# NIP source CRUD

NIP keeps one **source registry** independent of the fetch adapters
(docs/64). A podcast is one kind; a company meeting, a filing, a Reddit
thread, an X post, a web page or a local document is another. Every kind has
the same lifecycle, rights record and scan policy, so use these tools instead
of `subscribe_podcast_feed` unless you specifically need the legacy podcast
path.

## Tools

| Tool | Use |
|---|---|
| `list_sources` | Read the registry. `include_removed: true` also returns soft-removed rows. |
| `create_source` | Create any kind after rights confirmation. `locator` is the feed URL, source URL or local reference. |
| `update_source` | Correct display name, locator/feed URL, rights statement, topics and scan caps. |
| `set_source_state` | `active` / `paused` / `removed`. |
| `delete_source` | Hard delete only for a source with **zero** retained events. |
| `list_podcast_episodes`, `refresh_podcast_feeds`, `transcribe_podcast_episode` | Podcast adapter read/fetch/transcribe. |

Kinds: `podcast`, `company_meeting`, `filing`, `reddit`, `x`, `web`,
`local_document`, `other`.

## Rules

1. **Never create a source without a rights statement.** `create_source`
   requires `user_confirmed_rights: true` and a non-empty
   `rights_statement`; only set it after the operator confirms authority to
   access, process and retain the source. Public reachability is not
   permission.
2. **A wrong podcast URL is corrected, not re-created.** Call
   `update_source` with the corrected `locator`. The engine rewrites
   `nip_sources.locator` and the subscription feed URL in one transaction and
   clears ETag, Last-Modified, next-poll, error code and backoff. Add
   `sync: true` to refresh immediately. Existing events keep their
   `source_id`, so retained evidence and claims survive.
3. **`removed` is the normal end of life.** It hides the source from scans and
   keeps the audit trail. `delete_source` is only for a source that never
   produced events; when events exist it returns
   `source has N retained event(s)` — do not try to work around that, and do
   not purge outside the retention path in doc 55 §4.1.
4. **Scan caps are part of the record.** `per_scan_limit` defaults to 3 and is
   clamped to 1–10. A source with a large `per_scan_limit` costs a large fetch;
   see `nip-source-radar`.
5. **Report state honestly.** If a tool returns an error, quote its message and
   the source id. Do not silently retry with a different kind or locator.

## Typical calls

```json
{"tool":"create_source","arguments":{
  "source_id":"meeting-acme-q3",
  "kind":"company_meeting",
  "display_name":"Acme Q3 earnings call",
  "locator":"https://example.invalid/acme/q3-transcript",
  "rights_statement":"Internal transcript cleared for local retention and analysis",
  "user_confirmed_rights":true,
  "topics":["guidance","capex"],
  "per_scan_limit":1
}}
```

```json
{"tool":"update_source","arguments":{
  "source_id":"feed-a",
  "locator":"https://feeds.example.invalid/correct-feed.xml",
  "sync":true
}}
```

```json
{"tool":"set_source_state","arguments":{"source_id":"meeting-acme-q3","state":"paused"}}
```

## Presentation

When summarising the registry, group by kind and show: display name, state,
locator, rights status, `per_scan_limit`, and `event_count` / `episode_count`.
Call out removed sources separately, and never describe a source as approved
just because an adapter entry exists.
