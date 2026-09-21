# Chronicle — Agent Instructions

## What this project is
Chronicle is a mobile-first solo D&D 5e app. A Claude Agent SDK–powered DM
engine runs each campaign with persistent, file-backed state (not just
conversation history) to eliminate state drift and content repetition — the two
failures of existing AI-DM apps. A separate, decoupled asset engine generates
and caches images at key story moments via a pluggable backend (ADR-0027) —
Grok Build headless, or a local ComfyUI/SDXL engine.

Architecturally significant decisions live in `docs/adr/`, numbered
sequentially — read `0001-core-architecture.md` first, and `docs/adr/README.md`
for the full index. Original design context lives in
`docs/design/chronicle-design-doc.md`, but note it is a **v0.1 planning
artifact**: where it and an ADR disagree, the ADR wins.

## Roles
- **Product owner / strategist / D&D domain advisor:** browser Claude
  (Kris's human collaborator drives via prompts written in that thread).
- **Executor:** Claude Code (you), working in this repo.
- Kris is a solo developer under Twelve Rocks LLC. He does not know D&D rules
  in depth — rules-accuracy decisions should be flagged for review rather than
  assumed correct, and cited against the SRD text once that slice is in scope.

## Commit discipline
- **Every slice ends with its own commit(s), pushed, before the slice is
  reported done.** Uncommitted work is not "done" — it's a liability sitting in
  a working tree, one crash or accidental `git checkout` away from gone (see the
  test-data-hygiene incident this rule exists because of).
- Do not let multiple slices' work accumulate uncommitted "to batch later" —
  each slice's changes get committed and pushed at the end of that slice,
  closing that slice's own issue at that point, not in a retroactive bulk commit
  spanning several issues.
- If a slice is interrupted or spans more than one session, commit incremental
  progress rather than leaving it all uncommitted until the slice fully wraps.

## Test data hygiene
- **Never run destructive git operations** (`checkout`, `reset`, `clean`) against
  anything under `campaigns/` without first checking `git status`/`git diff` for
  uncommitted changes — no exceptions, regardless of how confident the change
  looks like "just my own test pollution."
- **All experimental/disposable validation uses a freshly created scratch
  campaign directory**, created and destroyed by `scripts/scratch-campaign.ts`
  (create/delete in one command) — never `test-campaign` or any other named
  fixture. This removes any reason to hand-roll a git-checkout cleanup dance
  again.
- `test-campaign` (or any deliberately-maintained fixture) must be left in a
  **clean, committed git state at the end of every slice** — either commit
  meaningful changes or revert to clean before calling the slice done. Dirty
  fixture state is never inherited silently across slices.

## Tech stack
- TypeScript/Node across backend and frontend — single language for a
  solo-maintained project.
- `@anthropic-ai/claude-agent-sdk` for the DM engine, pinned in `package.json`.
  The DM backend itself is **pluggable** (ADR-0018) — Claude or Grok, selected
  per campaign.
- Image generation via a **pluggable backend** (ADR-0027): Grok Build CLI
  (headless; `XAI_API_KEY` or `~/.grok`, do not commit keys) or a local
  ComfyUI/SDXL engine on the host GPU — the local path adds per-style LoRA
  recipes (ADR-0032), img2img "change amount" (ADR-0036), and IP-Adapter
  reference likeness (ADR-0037).
- Video generation is **pluggable** too (ADR-0034): Grok Imagine (ADR-0026) or
  a local ComfyUI Wan 2.2 / LTX-Video backend (ADR-0035).
- Campaign state stored as plain files (JSON/Markdown) per campaign, per the
  schema in the design doc §3.

## How it runs
- **Configuration is file-based** (ADR-0033): `config.json` for settings and
  `secrets.json` for passwords — both git-ignored, both seeded from their
  committed `.example` twins. **The loader ignores environment variables**: there
  is no `.env`, and `PORT`/`HOST` do nothing. Every key is documented in
  `docs/configuration.md`.
- `npm start` runs `tsx src/server.ts` directly. No build step for backend
  changes — but **no hot-reload either**. After editing `src/`, restart the
  server or you'll sit there testing stale code wondering why the fix didn't take.
- The web UI is served from the **committed `public/` bundle**, so a front-end
  change isn't done until `npm run build:web` has run and the regenerated
  `public/` is committed alongside the `web/src/` change in the same PR. Two PRs
  that both touch the bundle will collide — rebuild the second one against the
  merged base rather than hand-resolving the conflict.
- **Multi-user** (ADR-0019): users register their own accounts — no shared secret
  — and campaigns nest at `campaigns/<user>/<campaign>/`.
- Install guides: `SETUP.md` (technical/LAN hosting) and
  `docs/user-guide/install/{linux,mac,windows}.md` (end-user).

## Repo conventions
- Public repo, MIT licensed — with SRD 5.2 rules text as the CC-BY-4.0
  exception (see `NOTICE`; surfaced to players at the foot of Settings).
- No API keys, tokens, or `.grok`/`.claude` auth state committed.
  `config.json` and `secrets.json` are git-ignored (ADR-0033).

## What NOT to do yet
> **Historical (kickoff sequencing).** All three gates below have since been
> passed — images (ADR-0009/0027), SRD grounding (ADR-0006), and the desktop
> layout (ADR-0021/0022) are all shipped, as is the original Slice 1 goal of
> proving the file-backed state loop removes drift. Kept for the record of the
> original slice ordering.
- No image generation wiring until the DM engine's state-file loop is proven
  (Slice 1 complete).
- No SRD rules-grounding until its own dedicated slice.
- No desktop dockable-panel UI until mobile-first UI is working — it's explicitly
  lower priority.

## Verification gates (run before committing)
- `npm run typecheck` — `tsc --noEmit`, must pass clean.
- `npm run test:unit` — Node built-in test runner via `tsx`, 291 tests, all pass.
- `npm run build:web` — Vite production build of the React UI into `public/`.
- `npm run lint` — ESLint, must pass.
- After any `src/` change: restart the server; after any `web/src/` change:
  rebuild `public/` and commit both together.

## ADR index by area (quick routing)
| Working on… | Read |
|---|---|
| Core engine & state files | 0001, 0007, 0016, 0039 |
| Agent permissions & safety | 0002, 0008 |
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

## Good extension points
Additional DM backends (`src/backends/`) or image backends
(`src/image-backends/`), new MCP tools (`src/mcp-servers/`), art styles — both
prompt shaping (`src/image-prompt.ts`) and LoRA recipes
(`src/image-backends/style-loras.ts`, ADR-0032), music sources
(`src/music-store.ts`), and the desktop layout (ADR-0021/0022).

## Before you start a session
1. Re-read `docs/adr/0001-core-architecture.md` — it's the foundation everything
   else builds on.
2. Skim `docs/adr/README.md` for the area you're touching.
3. If touching the UI: read `docs/design/chronicle-design-doc.md` §4 (screens),
   §5 (character sheet), §6 (play flow).
4. Run the verification gates above before committing.
