"""Embed text via the self-hosted infinity embedding API (used by tac_qlib.trace).

Mirrors the standalone `embed.py` in the tac-qlib-custom skill lib so the trace
MCP tools can embed rational/details without shelling out.
"""

from __future__ import annotations

import base64
import json
import os
import urllib.request

EMBEDDING_MODEL = "michaelfeil/bge-small-en-v1.5"
MAX_TOKENS = 512
CHARS_PER_TOKEN = 4


def estimate_tokens(text: str) -> int:
    return max(1, -(-len(text) // CHARS_PER_TOKEN))


def embed(text: str, timeout: int = 40) -> list[float] | None:
    base_url = (os.environ.get("EMBEDDING_API_BASE_URL") or "").strip()
    api_key = (os.environ.get("EMBEDDING_API_KEY") or "").strip()
    if not base_url or not api_key:
        return None

    if estimate_tokens(text) > MAX_TOKENS:
        raise ValueError(
            f"text is ~{estimate_tokens(text)} tokens, exceeding the {MAX_TOKENS}-token embedding "
            "context. Write a <=512-token summary of the experiment and embed that instead."
        )

    body = json.dumps({"model": EMBEDDING_MODEL, "input": text}).encode("utf-8")
    req = urllib.request.Request(
        base_url,
        data=body,
        headers={
            "accept": "application/json",
            "Content-Type": "application/json",
        },
    )
    user, _, password = api_key.partition(":")
    cred = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
    req.add_header("Authorization", f"Basic {cred}")

    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))

    data = payload.get("data") if isinstance(payload, dict) else None
    if isinstance(data, list) and data and isinstance(data[0], dict):
        emb = data[0].get("embedding")
        if isinstance(emb, list) and emb:
            return [float(v) for v in emb]
    embeddings = payload.get("embeddings") if isinstance(payload, dict) else None
    if isinstance(embeddings, list) and embeddings and isinstance(embeddings[0], list):
        return [float(v) for v in embeddings[0]]
    raise RuntimeError(f"unexpected embedding response shape: {str(payload)[:300]}")
