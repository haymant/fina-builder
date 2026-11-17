---
name: comfyui
description: Detect ComfyUI Desktop, check its local workflows, and run the image/video/ASR graphs in modules/comfy through the API before wiring them into Tauri.
---

# ComfyUI local workflows

`modules/comfy/` is a standalone workflow pack. Test a workflow through the
ComfyUI HTTP API first; only then add a Tauri surface. The same rule applies to
NIP transcription: expose/test the MCP or API call before building UI around it.

## Detect the installation

```bash
bash modules/comfy/scripts/setup_desktop.sh --check
```

The script now finds ComfyUI Desktop on Linux and macOS, including the running
port. If it cannot find an unusual install:

```bash
COMFY_ROOT="/path/to/ComfyUI" bash modules/comfy/scripts/setup_desktop.sh --check
```

Use the reported `server` URL in the commands below. Do not assume `8188`; the
Desktop app commonly uses another loopback port.

## Check the ASR workflow

The optional Qwen3-ASR graph needs the `ComfyUI-Qwen3-ASR` custom node and the
`Qwen/Qwen3-ASR-0.6B` model. Check the server before installing anything:

```bash
curl -fsS http://127.0.0.1:8189/object_info | python3 -c '
import json, sys
nodes = json.load(sys.stdin)
print("\n".join(f"{n}: {n in nodes}" for n in ("LoadAudio", "Qwen3ASRLoader", "Qwen3ASRTranscribe")))'
```

`Qwen3ASRLoader: False` means the node pack is not loaded. Install it into
ComfyUI Desktop with the user's approval, restart Desktop, and re-run the check:

- custom node: `ComfyUI-Qwen3-ASR` (loads the Qwen3-ASR model)
- model: `Qwen/Qwen3-ASR-0.6B` under the Desktop `models/Qwen3-ASR` dir

Do not download multi-GB video models or change the Desktop venv without asking.

## Run ASR through the API

```bash
python3 modules/comfy/scripts/render.py asr \
  --server http://127.0.0.1:8190 \
  --audio speech.flac \
  --language English \
  --output out/speech.txt
```

`render.py asr` uploads the audio to ComfyUI's input, submits
`workflows/api/qwen3_asr_local.api.json`, polls `/history/{prompt_id}`, and reads
the transcript from `outputs`. The live round-trip test is:

```bash
(cd modules/comfy && COMFY_ROUNDTRIP=1 COMFYUI_SERVER=http://127.0.0.1:8190 \
  python3 -m unittest tests.test_tts_asr_roundtrip -v)
```

Image/video/TTS workflows use the same CLI:

```bash
python3 modules/comfy/scripts/render.py t2i "a reading corner" --output out/room.png
python3 modules/comfy/scripts/render.py tts "The quick brown fox." --speaker Ryan --output out/speech.flac
python3 modules/comfy/scripts/render.py --list
```

## Wire local ASR into NIP

NIP accepts a loopback ComfyUI with the Qwen3-ASR graph:

```bash
# .env next to the repo, or the host environment
NIP_COMFYUI_URL=http://127.0.0.1:8190
```

Restart the desktop app. `capabilities.features.local_audio_transcription`
becomes `true` and the Narrative **Discovered episodes** card offers
**Transcribe locally**. If the URL is unset, NIP reports
`transcription_unavailable` and the UI says so instead of pretending to work.

Boundary: loopback only, no remote ASR upload, no credential in the URL, and
rights confirmation still precedes every feed fetch. See the
`nip-transcription` skill for the MCP-level test.
