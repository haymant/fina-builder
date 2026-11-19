# 74 — Video Workspace UI quick-start

This guide describes the evidence-first UI path from a retained transcript to a commentary-video draft. Video records are production projections; NIP remains the source of truth for events, transcripts and claims.

## Fastest path: start from a claim

1. In **Narrative Intelligence**, retain a transcript-backed event and extract or review its claims. A claim must have at least one exact quote/offset match against a retained event before it can drive a video.
2. Open the claim in **Claim Explorer** and choose **Create video episode**.
3. In the dialog, keep **Create a new project…** selected or choose an existing Video project. The dialog starts at a new project to avoid silently adding production to an existing one.
4. Select one of the claim’s cited events. The dialog shows the source/native ID, a transcript preview, and the matching quote/offsets. Ineligible or mismatched evidence is explained and cannot be selected.
5. Choose **Create video episode**. The app saves a draft project if needed, creates the episode, links the immutable event and exact claim spans, then opens that saved episode in Video Workspace with the source claim preselected.

The shortcut does not copy the full transcript into Video, and you do not need to copy or paste an event ID.

## Create from the Video Projects page

You can also start from **Video Workspace**:

1. Create a project or open an existing project.
2. Create a draft episode if one is not already open.
3. In **Search retained events**, type a distinctive phrase from the transcript, the source name, or a source/native ID. Choose a result from the accessible list; it shows source IDs and a transcript preview. Keyboard users can move through results with the arrow keys, select with Enter, or close the list with Escape.
4. Choose **Load and link event**. The app loads the canonical NIP event; it does not require a manually copied event ID.
5. Filter the retained claims and check every claim you want to use. The picker is multi-select. Each selectable claim is shown separately from its supporting quote and source offsets; claims without a verified exact span are disabled or omitted.
6. Choose **Build from selected claims**. Each selected claim creates a separate storyboard beat. The saved storyboard, visual specs and evidence links carry the claim/event IDs and exact supporting offsets. No generic transcript-based beat is silently substituted when nothing is selected.

The storyboard preview can be inspected in the workspace. Treat it as a reviewable candidate: extraction and an exact quote match do not independently verify the claim’s truth.

## Render and review

The Video Workspace defaults to **Flash** for a quick preview. Switch to **Full** when deterministic, frame-seeked capture and reproducibility matter more than speed. Start rendering from the episode workspace and follow the durable job banner for progress, cancellation, retry and the registered asset.

If TTS is not configured, audio cues remain visible as text and the render is labeled silent; the app must not imply narration audio was generated. A missing local/remote provider remains unavailable rather than silently switching providers. Run the available QA/export steps and review warnings before treating an asset as publishable.

## Delete a Video project

From the Projects list, choose the red **Delete** action for that project. The destructive button stays disabled until the exact project title—including capitalization—is entered. Deletion is blocked while a Video job is queued or running. It removes project-owned Video records, but preserves canonical NIP events/transcripts/claims, global media assets/binaries and job history whose project ownership is ambiguous.

## Local model settings and remaining limits

In the desktop app, the Direct Local settings panel lets you configure the loopback model endpoint and model name, save the settings for the next launch, and check that the exact model is available. It is independent of RIGA. A browser session cannot configure the desktop host and will explain that the host runtime is required. The packaged model/runtime installer, consent-bound remote profiles, and direct Comfy TTS/image/video adapters are still separate roadmap work; see [the Mode 1 parity plan](./69-agent-native-modes-and-full-journey-plan.md).
