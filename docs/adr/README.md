# Architecture Decision Records

Every architecturally significant decision in Chronicle gets an ADR here,
numbered sequentially, written before or alongside the implementation rather
than after it. **Read [`0001-core-architecture.md`](0001-core-architecture.md)
first** — it establishes the file-backed DM engine and decoupled asset worker
that everything else builds on.

Where an ADR and `docs/design/chronicle-design-doc.md` disagree, **the ADR
wins**: the design doc is the original v0.1 planning artifact, while these
record what was actually decided and built.

## Where to start, by topic

| If you're working on… | Read |
|---|---|
| Core engine & state files | 0001, 0007, 0016, 0039 |
| Agent permissions & safety | 0002, 0008, 0042 |
| Rules fidelity (SRD, dice) | 0006, 0011 |
| Campaign lifecycle | 0010, 0012, 0013, 0014 |
| DM-engine backends (Claude/Grok) | 0018, 0025 |
| Session quality & drift | 0039, 0040, 0041 |
| Image generation | 0009, 0027, 0028, 0029, 0030, 0031, 0032, 0036, 0037, 0038 |
| Video generation | 0026, 0034, 0035 |
| Auth & multi-user | 0003, 0019, 0023 |
| UI & layout | 0015, 0021, 0022, 0024 |
| Config, deployment, hosting | 0017, 0033, 0041 |
| Data & git policy | 0005 |

## All ADRs

| # | Title | Status |
|---|---|---|
| 0001 | [File-Backed Agent SDK DM Engine + Decoupled Asset Worker](0001-core-architecture.md) | Accepted |
| 0002 | [Agent SDK Permission Scope Beyond the CLI Prototype](0002-agent-permission-scope.md) | Accepted · implemented |
| 0003 | [LAN Exposure and Minimal Auth](0003-lan-exposure-auth.md) | Superseded in part (ADR-0019) |
| 0004 | [Setting Reskin as a Narration-Layer Instruction, Not a Content Fork](0004-setting-reskin.md) | Accepted |
| 0005 | [Campaign Data Git Policy](0005-campaign-data-git-policy.md) | Accepted (retroactive) |
| 0006 | [SRD-Grounded Rules Adjudication (Core Resolution Mechanics)](0006-srd-grounded-rules-adjudication.md) | Accepted |
| 0007 | [Deterministic Turn Transcripts, Not Reconstructed-From-Prose History](0007-deterministic-turn-transcripts.md) | Accepted |
| 0008 | [Deterministic Host-Side Permission Enforcement (PreToolUse Gate)](0008-deterministic-host-side-permission-enforcement.md) | Accepted · implemented |
| 0009 | [User-triggered on-demand image generation](0009-on-demand-image-generation.md) | Accepted |
| 0010 | [Campaign creation & character generation](0010-campaign-creation-and-character-gen.md) | Accepted |
| 0011 | [Deterministic host-side dice mechanic](0011-deterministic-dice-mechanic.md) | Accepted |
| 0012 | [Campaign deletion](0012-campaign-deletion.md) | Accepted |
| 0013 | [Opening scene (turn-zero)](0013-opening-scene-turn-zero.md) | Accepted |
| 0014 | [New-game settings inherit from the last-played campaign](0014-new-game-settings-inheritance.md) | Accepted |
| 0015 | [Full character sheet: authored vs derived fields](0015-full-character-sheet.md) | Accepted |
| 0016 | [Editable history via pre-turn state snapshots](0016-editable-history-snapshots.md) | Accepted |
| 0017 | [Deployment & Packaging — Native-First, Docker Deferred](0017-deployment-and-packaging.md) | Accepted |
| 0018 | [Pluggable DM-Engine Backend (Claude + Grok)](0018-pluggable-dm-backend.md) | Accepted · implemented |
| 0019 | [Multi-User Accounts](0019-multi-user-accounts.md) | Accepted · implemented |
| 0020 | [Music Playback (local files + Navidrome LAN stream)](0020-music-playback.md) | Accepted · implemented |
| 0021 | [Desktop responsive layout](0021-desktop-responsive-layout.md) | Accepted |
| 0022 | [Official character-sheet view (desktop)](0022-official-character-sheet-view.md) | Accepted |
| 0023 | [Ensure the bootstrap user on server startup](0023-ensure-bootstrap-user-on-startup.md) | Accepted |
| 0024 | [New-game loading slideshow of past-game art](0024-new-game-loading-slideshow.md) | Accepted |
| 0025 | [Settings-tier separation and set-once engine](0025-settings-tier-separation.md) | Accepted |
| 0026 | [On-demand video-clip generation (Grok Imagine)](0026-on-demand-video-generation.md) | Accepted |
| 0027 | [Pluggable image-generation backend (Grok + local ComfyUI)](0027-pluggable-image-backend.md) | Accepted |
| 0028 | [Holding the art style on scene/location images (local backend)](0028-scene-style-adherence-local.md) | Accepted |
| 0029 | [Per-tier image quality (fast / standard / high) — local backend](0029-image-quality-tiers-local.md) | Accepted |
| 0030 | [DM-emitted inline scene caption for moment images](0030-dm-emitted-scene-caption.md) | Accepted · amended |
| 0031 | [Ground scene/moment images in known entities' canonical appearance](0031-scene-entity-grounding.md) | Accepted |
| 0032 | [LoRA-backed art-style recipes (local backend)](0032-lora-backed-style-recipes-local.md) | Accepted |
| 0033 | [File-based configuration (config.json + secrets.json)](0033-file-based-config.md) | Accepted · supersedes `.env` |
| 0034 | [Pluggable video-generation backend (Grok Imagine + local ComfyUI)](0034-pluggable-video-backend.md) | Accepted |
| 0035 | [Local ComfyUI video backend (Wan 2.2 5B + LTX-Video 2B)](0035-local-comfyui-video-backend.md) | Accepted |
| 0036 | [img2img "change amount" (local backend)](0036-image-to-image-change-amount.md) | Accepted |
| 0037 | [IP-Adapter reference likeness (local backend)](0037-ip-adapter-reference-likeness.md) | Accepted |
| 0038 | [Editable full prompt + no-render prompt preview](0038-editable-full-prompt.md) | Accepted |
| 0039 | [Bounded, rewritten-each-turn "Current Situation" summary](0039-bounded-current-situation-summary.md) | Accepted |
| 0040 | [Session rotation — fresh-session catch-up to cure long-campaign drift](0040-session-rotation.md) | Accepted |
| 0041 | [Automatic session rotation + always-on local service](0041-auto-session-rotation-and-local-service.md) | Accepted |
| 0042 | [Lock down what Grok and Claude can do on the host](0042-lock-down-grok-and-claude.md) | Accepted |

## Conventions

- **Numbering is contiguous.** Take the next free number; don't reuse one and
  don't leave gaps. (This index is generated by reading the files, so a new ADR
  shows up here once it exists — but the table above is committed text, so
  regenerate or hand-add the row when you add one.)
- An ADR is **immutable once Accepted**. To change a decision, write a new ADR
  that supersedes it and update the old one's status to point forward.
  ADR-0003 → ADR-0019 is the worked example.
- Small clarifications that don't reverse the decision can go in-place, in a
  clearly labelled amendment section — see ADR-0030's reliability amendment.
- Two status formats exist, for no better reason than history: 0001–0033 use a
  `## Status` heading block, 0034 onward use an inline `Status:` / `Date:` pair.
  Either is fine; match the neighbours.
