# Direct local NIP claim extraction (Mode 1 first slice)

## What this implements

NIP can call a user-configured OpenAI-compatible local model directly for claim extraction. The request does not pass through an external agent or the RIGA bridge. This first route is intentionally local-only: it accepts no API key, requires a literal loopback IP (`127.0.0.0/8` or `::1`) rather than a DNS hostname, disables environment-provided HTTP proxies, follows no redirects, and caps response bodies at 4 MiB.

A direct-local model must expose `GET /models` and `POST /chat/completions` below its configured base URL. NIP checks that the exact configured model ID is advertised before marking extraction available. Example for a compatible local server:

```dotenv
NIP_CLAIM_PROVIDER=direct_local
NIP_LOCAL_LLM_URL=http://127.0.0.1:1234/v1
NIP_LOCAL_LLM_MODEL=<exact model id returned by GET /v1/models>
```

Set these values in the desktop host environment or the app-data `.env`, then restart the app. With `NIP_CLAIM_PROVIDER=auto` (the default), a complete local URL/model pair selects direct local; if the server is down or the model is missing, extraction stays blocked. It never silently falls back to RIGA or a deterministic fake provider. Set `NIP_CLAIM_PROVIDER=riga` to select the RIGA bridge explicitly when both routes are configured. `NIP_CLAIM_PROVIDER=direct_local` explicitly chooses the local route and remains unavailable if its model settings are missing.

## Evidence and provenance

Model output is untrusted. Each non-empty claim must include an exact, contiguous transcript quote and zero-based, half-open Unicode-scalar offsets. NIP verifies that those offsets select exactly the supplied quote from the retained event; one invalid claim rejects the extraction before any claim is committed. This validates citation alignment only—it does not prove that the quote entails or supports the generated claim. Claims stay labeled as candidates, and an editor must review support before rendering. Provider, exact model ID, prompt version, run ID and evidence span are stored with accepted claims. A valid empty `claims` array returns zero claims; it does not fabricate a placeholder.

Provider status exposes the active provider ID, model, local/remote boundary, readiness and safe warning codes. It does not expose endpoint paths, credentials or transcript text. Direct-local status checks only the configured model list; transcript text is sent only on an explicit extraction action.

## Scope still open

This is a backend/provider route configured through host environment, not a complete Mode 1 implementation or a packaged model installer. A desktop settings UI for choosing/configuring local providers remains open. This route covers NIP claim extraction only; remote LLM profiles, consented remote execution, direct Comfy ASR/TTS/image/video adapters, model installation/readiness management, and the complete project-to-final-video desktop journey remain separate work. The existing Mode 3 external-agent workflow remains a parity guardrail, not a substitute for those Mode 1 capabilities.
