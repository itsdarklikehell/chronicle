# Chronicle — Development Assessment (2026-09-21)

## Project Health
- **Sync**: 0 commits behind origin/master, 0 ahead — fully up to date.
- **CI**: Green (last run 2026-09-21, `docs: add For developers section to README`).
- **Gource workflow**: Pinned to nbprojekt/gource-action@v1.3.0 (SHA 57256d30), checkout@v4, upload-artifact@v4 — all immutable.
- **Local gource**: Successfully rendered 38.7s preview @ 1920×1080, 21MB H.264.
- **Issues**: Disabled on the repository — can't open issues directly. Contribution must go through PRs or external coordination with Kris.

## Verified State
- npm setup: ✓
- typecheck (tsc --noEmit): ✓
- test:unit (291 tests): ✓
- build:web (Vite → public/): ✓
- AGENTS.md written: ✓ (complements CLAUDE.md with verification gates + ADR routing)
- Gource preview: ✓ (gource/gource-preview.mp4)

## Codebase Size
- **src/** (backend TS): 10,211 lines across 35 files
- **web/** (frontend React+TS): 211,035 lines (includes generated/bundled)
- **Tests**: 35 test files
- **ADRs**: 42 decisions (0001–0041)
- **Seams ready for extension**:
  - DM backends: `src/backends/` (claude + grok, seam in `dm-backend.ts`)
  - Image backends: `src/image-backends/` (grok + local ComfyUI, seam in `types.ts`)
  - Video backends: `src/video-backends/` (grok + local, seam in `types.ts`)
  - MCP servers: `src/mcp-servers/` (dice, image, seed, texture)
  - Art styles: `src/image-backends/style-loras.ts` (18 LoRA references)

## 5 Contribution Opportunities

### 1. Add a third DM backend (e.g., OpenAI-compatible / Ollama local)
- **Effort**: Medium (2-3 days)
- **Seam**: `src/dm-backend.ts` `DmBackend` interface + `src/backends/index.ts` registry
- **What**: Implement `runTurn(args: RunTurnArgs): Promise<TurnResult>` for a new provider, register in `BACKENDS` map
- **Why interesting**: The seam is clean and provider-agnostic. A local LLM backend would let Chronicle run fully offline — significant for the "private AI DM" value prop.
- **Risk**: Need to match the `RunTurnArgs`/`TurnResult` contract exactly; test via `verify:grok-parity` pattern

### 2. Add a new MCP tool (e.g., inventory search, spell lookup, condition tracker)
- **Effort**: Small (half day per tool)
- **Seam**: `src/mcp-servers/` — copy `dice-server.ts` pattern
- **What**: New `*.ts` in `mcp-servers/` exporting a tool definition + handler; wire into `src/server.ts` MCP route
- **Why interesting**: Low-risk, high-value extension. Each tool is independently testable. Dice/seed/texture/image already exist — inventory or spell tools would deepen the DM's capabilities.
- **Risk**: Minimal — follows established pattern

### 3. Add a new art style LoRA recipe (local ComfyUI backend)
- **Effort**: Small (hours)
- **Seam**: `src/image-backends/style-loras.ts` + `src/workflows/*.json`
- **What**: Add a new `StyleLora` entry with trigger word, recipe file reference, quality-tier interaction
- **Why interesting**: Extends the visual vocabulary without touching core logic. Requires a ComfyUI LoRA checkpoint to exist on the host, but the code side is pure config.
- **Risk**: Needs a real LoRA file on a ComfyUI host to verify end-to-end

### 4. Extend the local video backend (new model or workflow)
- **Effort**: Medium (1-2 days)
- **Seam**: `src/video-backends/local.ts` + `src/video-backends/video-models.ts` + `src/workflows/`
- **What**: Add support for a new local video model (e.g., a newer Wan version, or a CogVideoX variant), define its workflow graph
- **Why interesting**: Video is the newest subsystem (ADR-0026/0034/0035) — still evolving. The `VideoBackend` seam mirrors the image backend exactly, so the pattern is well-understood.
- **Risk**: Needs a ComfyUI host with the model checkpoint; workflow graph must be correct

### 5. Improve session rotation automation (ADR-0040/0041 follow-up)
- **Effort**: Medium (1-2 days)
- **Context**: ADR-0040 introduced session rotation; ADR-0041 added auto-rotation + systemd service. The rotation triggers on transcript size / turn count thresholds.
- **What**: Tune the rotation heuristics, add rotation-event logging, possibly expose a manual "rotate now" button in the UI
- **Why interesting**: Session rotation is the key anti-drift mechanism for long campaigns. Fine-tuning when it fires directly affects play quality.
- **Risk**: Must not rotate too aggressively (loses conversation continuity) or too rarely (drift returns)

## Skills This Work Suggests

### 1. `gource-local` — local Gource video generation skill
- **Trigger**: "Render a gource video locally" / "gource preview"
- **What it knows**: Xvfb setup for headless render, gource CLI params matching the CI workflow (viewport, fps, hide items, auto-skip, seconds-per-day), ffmpeg encoding from PPM to MP4, file size expectations
- **Why real**: The CI workflow pins the params; a local skill that mirrors them lets developers preview what CI will produce before pushing. Useful across ALL the itsdarklikehell repos that have gource workflows.
- **Reuses**: The existing `gource-action` skill as the CI-side reference; this is the local-complement.

### 2. `adr-scaffold` — ADR creation workflow for Chronicle-style projects
- **Trigger**: "Add an ADR" / "write an architecture decision record"
- **What it knows**: Chronicle's ADR format (status, context, decision, alternatives, consequences), numbering convention (next free number, contiguous), the ADR index in `docs/adr/README.md`, the rule that ADR wins over design doc
- **Why real**: 42 ADRs with a consistent structure — a skill that scaffolds a new ADR with the right frontmatter, picks the next number, updates the index, and prompts for each section would speed up disciplined decision records.
- **Scope**: Specific to Chronicle's format; could generalize to any project that uses numbered ADRs.
