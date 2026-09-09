import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMusicBlock, type UserMusic } from "./music-store.js";
import { parseVideoBlock, type UserVideo } from "./video-store.js";
import {
  isValidImageProvider,
  isValidImageQuality,
  type ImageProvider,
  type ImageQuality,
} from "./image-backends/types.js";
import { isValidVideoProvider, type VideoProvider } from "./video-backends/types.js";
import { isAnimateModel, type AnimateModel } from "./video-backends/video-models.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CAMPAIGNS_ROOT = path.resolve(__dirname, "../campaigns");

const CAMPAIGN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** ADR-0019: campaigns nest under a per-user dir. A user id has the same shape
 * as a campaign id; the shared `_registry` helper starts with `_` and so fails
 * this pattern (it can never be mistaken for a user or campaign). */
const USER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export class InvalidCampaignIdError extends Error {}
export class CampaignNotFoundError extends Error {}
export class CampaignExistsError extends Error {}
export class CampaignProtectedError extends Error {}

/** Maintained fixtures the delete endpoint refuses to remove, so the app can
 * never nuke tracked test data (CLAUDE.md test-data hygiene / ADR-0005). The
 * `_registry` helper dir already fails CAMPAIGN_ID_PATTERN, so only the
 * deliberately-tracked test-campaign needs naming here. */
const PROTECTED_CAMPAIGN_IDS = new Set(["test-campaign"]);

/** ADR-0019: the campaigns root for one user, `campaigns/<userId>`. Validates
 * the user id can't traverse out of CAMPAIGNS_ROOT. */
export function userCampaignsRoot(userId: string): string {
  if (!USER_ID_PATTERN.test(userId)) {
    throw new InvalidCampaignIdError(`invalid user id: ${userId}`);
  }
  const dir = path.resolve(CAMPAIGNS_ROOT, userId);
  if (path.dirname(dir) !== CAMPAIGNS_ROOT) {
    throw new InvalidCampaignIdError(`invalid user id: ${userId}`);
  }
  return dir;
}

/** Resolves a (userId, campaignId) pair to its working directory, rejecting
 * anything that isn't a plain directory name directly under the user's own
 * campaigns dir (no path traversal, no absolute paths). ADR-0019: the userId
 * always comes from the caller's session, never the URL, so a user can only
 * ever resolve their own campaigns. */
export function resolveCampaignDir(userId: string, campaignId: string): string {
  const root = userCampaignsRoot(userId);
  if (!CAMPAIGN_ID_PATTERN.test(campaignId)) {
    throw new InvalidCampaignIdError(`invalid campaign id: ${campaignId}`);
  }
  const dir = path.resolve(root, campaignId);
  if (path.dirname(dir) !== root) {
    throw new InvalidCampaignIdError(`invalid campaign id: ${campaignId}`);
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new CampaignNotFoundError(`campaign not found: ${campaignId}`);
  }
  return dir;
}

/** ADR-0019/ADR-0027: campaigns nest at campaigns/<userId>/<campaignId>, so the
 * owning user id is the parent dir's name. Used at the image-generation seam,
 * which sits below the route (and in a separate stdio subprocess) where only
 * `campaignDir` is in scope, to recover the user and read their provider default.
 * Returns undefined when campaignDir isn't a direct child of a user dir under
 * CAMPAIGNS_ROOT (e.g. a stray temp dir), so callers fall back to env/code
 * defaults rather than a bogus user. */
export function campaignDirUserId(campaignDir: string): string | undefined {
  const parent = path.dirname(path.resolve(campaignDir)); // campaigns/<userId>
  if (path.dirname(parent) !== CAMPAIGNS_ROOT) return undefined;
  const id = path.basename(parent);
  return USER_ID_PATTERN.test(id) ? id : undefined;
}

/** Issue #50: permanently removes a campaign's directory. resolveCampaignDir
 * enforces the id is a plain name that exists directly under CAMPAIGNS_ROOT
 * (no traversal), and the maintained fixtures are refused up front — so a
 * delete can neither escape campaigns/ nor destroy tracked test data. */
export function deleteCampaign(userId: string, campaignId: string): void {
  if (PROTECTED_CAMPAIGN_IDS.has(campaignId)) {
    throw new CampaignProtectedError(`campaign '${campaignId}' is protected and cannot be deleted`);
  }
  const dir = resolveCampaignDir(userId, campaignId);
  fs.rmSync(dir, { recursive: true, force: true });
}

// The blank state-file templates a new campaign starts from — moved here from
// scripts/scratch-campaign.ts so scratch and real (character-creation)
// campaigns are scaffolded by one primitive (ADR-0010). The headings/bullet
// shapes must match web/src/lib/state-headings.ts (checked by
// web/tests/heading-consistency.spec.ts).
export const EMPTY_WORLD_STATE = `# World State

## Current Situation
_(not yet started)_

## Locations Visited
_(none yet)_

## Factions
_(none established yet)_
`;

export const EMPTY_NPC_ROSTER = `# NPC Roster

_(No named NPCs met yet. Add an entry per NPC on first meaningful
introduction, in this format:)_

<!--
## <Name>
- **Description:** appearance, role
- **Disposition:** attitude toward the player, current relationship
- **Knows:** information they can share
- **Portrait asset ID:** (none yet)
-->
`;

export const EMPTY_QUEST_LOG = `# Quest Log

## Active
_(none yet)_

## Completed
_(none yet)_
`;

/** Creates a new campaign directory and its blank state files. Rejects an id
 * that fails the pattern or already exists — this is the one primitive used by
 * both scripts/scratch-campaign.ts and POST /campaigns (ADR-0010). */
export function scaffoldCampaign(
  userId: string,
  campaignId: string,
  characterSheet: unknown,
  settings: Record<string, unknown> = { model: DEFAULT_MODEL, autoRollDice: true }
): string {
  const root = userCampaignsRoot(userId);
  if (!CAMPAIGN_ID_PATTERN.test(campaignId)) {
    throw new InvalidCampaignIdError(`invalid campaign id: ${campaignId}`);
  }
  const dir = path.resolve(root, campaignId);
  if (path.dirname(dir) !== root) {
    throw new InvalidCampaignIdError(`invalid campaign id: ${campaignId}`);
  }
  if (fs.existsSync(dir)) {
    throw new CampaignExistsError(`campaign already exists: ${campaignId}`);
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "session-log"));
  fs.writeFileSync(path.join(dir, "session-log", ".gitkeep"), "");
  fs.writeFileSync(path.join(dir, "character-sheet.json"), JSON.stringify(characterSheet, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "world-state.md"), EMPTY_WORLD_STATE);
  fs.writeFileSync(path.join(dir, "npc-roster.md"), EMPTY_NPC_ROSTER);
  fs.writeFileSync(path.join(dir, "quest-log.md"), EMPTY_QUEST_LOG);
  fs.writeFileSync(path.join(dir, "campaign-settings.json"), JSON.stringify(settings, null, 2) + "\n");
  return dir;
}

export interface CampaignSummary {
  id: string;
  name: string;
  race: string;
  class: string;
  level: number;
  situation: string;
}

/** Hard cap (chars) on the flattened "Current Situation" summary (ADR-0039).
 * The DM prompt asks for a short, rewritten-each-turn summary; this
 * deterministic backstop guarantees the Home menu can never render a wall of
 * text even if the model misbehaves and lets the section grow. Mirrored in the
 * web bundle (web/src/lib/state-headings.ts) because src/ and web/src/ share no
 * module — the ADR is the authoritative budget for both. */
export const SITUATION_SUMMARY_MAX_CHARS = 280;

/** Truncate to the summary budget at a word boundary, adding an ellipsis when
 * cut. Shares its shape with web/src/lib/markdown.ts's summarizeSituation. */
function capSituation(text: string): string {
  if (text.length <= SITUATION_SUMMARY_MAX_CHARS) return text;
  const slice = text.slice(0, SITUATION_SUMMARY_MAX_CHARS);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[\s.,;:!?-]+$/, "") + "…";
}

/** Pulls the trimmed body of the "## Current Situation" section out of a
 * world-state.md, for the Home campaign list — a tiny standalone extractor so
 * the server needn't carry the client's full markdown parser. Bounded to
 * SITUATION_SUMMARY_MAX_CHARS (ADR-0039) so the list endpoint can never ship a
 * wall of text. Exported for tests/current-situation.test.ts. */
export function currentSituation(worldStateMd: string): string {
  const lines = worldStateMd.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Current Situation\s*$/i.test(l));
  if (start === -1) return "";
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  const text = body.join(" ").replace(/\s+/g, " ").trim();
  if (!text || /^_\(.*\)_$/.test(text)) return "";
  return capSituation(text);
}

export interface CharacterIdentity {
  name: string;
  race: string;
  class: string;
  /** Issue #71: free-text physical description, when the sheet carries one.
   * Woven into the DM system prompt so narration and auto-generated portraits
   * reflect the player's intent (e.g. a female Goliath, not a generic hulk). */
  appearance?: string;
}

/** The player character's name/race/class straight off character-sheet.json,
 * for the DM system prompt (issues #51/#48 — the prompt used to hardcode
 * "Kira Emberfall", so every other campaign was addressed by the wrong name
 * and the model would drift into "this isn't my campaign" refusals). Falls
 * back to a neutral identity if the sheet is missing/unreadable rather than
 * throwing — a turn must still run. */
export function readCharacterIdentity(campaignDir: string): CharacterIdentity {
  const fallback: CharacterIdentity = { name: "the player character", race: "", class: "" };
  const sheetPath = path.join(campaignDir, "character-sheet.json");
  if (!fs.existsSync(sheetPath)) return fallback;
  try {
    const sheet = JSON.parse(fs.readFileSync(sheetPath, "utf8")) as Record<string, unknown>;
    const appearance =
      typeof sheet.appearance === "string" && sheet.appearance.trim()
        ? sheet.appearance.trim()
        : undefined;
    return {
      name: typeof sheet.name === "string" && sheet.name.trim() ? sheet.name.trim() : fallback.name,
      race: typeof sheet.race === "string" ? sheet.race : "",
      class: typeof sheet.class === "string" ? sheet.class : "",
      ...(appearance ? { appearance } : {}),
    };
  } catch {
    return fallback;
  }
}

/** Every campaign under one user's campaigns dir (skipping any dir without a
 * character-sheet.json), for that user's Home list (ADR-0010 / ADR-0019). */
export function listCampaigns(userId: string): CampaignSummary[] {
  const root = userCampaignsRoot(userId);
  if (!fs.existsSync(root)) return [];
  const out: CampaignSummary[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "_registry") continue;
    if (!CAMPAIGN_ID_PATTERN.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const sheetPath = path.join(dir, "character-sheet.json");
    if (!fs.existsSync(sheetPath)) continue;
    let sheet: Record<string, unknown> = {};
    try {
      sheet = JSON.parse(fs.readFileSync(sheetPath, "utf8"));
    } catch {
      continue;
    }
    let situation = "";
    const worldPath = path.join(dir, "world-state.md");
    if (fs.existsSync(worldPath)) situation = currentSituation(fs.readFileSync(worldPath, "utf8"));
    out.push({
      id: entry.name,
      name: typeof sheet.name === "string" ? sheet.name : "",
      race: typeof sheet.race === "string" ? sheet.race : "",
      class: typeof sheet.class === "string" ? sheet.class : "",
      level: typeof sheet.level === "number" ? sheet.level : 1,
      situation,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const SLIDESHOW_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export interface CampaignImageRef {
  campaignId: string;
  filename: string;
}

/** Issue #105: every generated image across this user's own campaigns, for the
 * new-game loading slideshow. One readdir per campaign's images/ dir — cheap,
 * no full state loads. `exclude` skips a campaign (e.g. the just-created one,
 * which has no images yet anyway). Only ever reads under the user's own
 * campaigns root (ADR-0019), so it can't surface another user's art. */
export function listCampaignImages(userId: string, exclude?: string): CampaignImageRef[] {
  const root = userCampaignsRoot(userId);
  if (!fs.existsSync(root)) return [];
  const out: CampaignImageRef[] = [];
  for (const campaign of fs.readdirSync(root, { withFileTypes: true })) {
    if (!campaign.isDirectory() || campaign.name === "_registry") continue;
    if (!CAMPAIGN_ID_PATTERN.test(campaign.name)) continue;
    if (exclude && campaign.name === exclude) continue;
    const imagesDir = path.join(root, campaign.name, "images");
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(imagesDir, { withFileTypes: true });
    } catch {
      continue; // no images/ dir for this campaign
    }
    for (const file of entries) {
      if (!file.isFile()) continue;
      if (!SLIDESHOW_IMAGE_EXTS.has(path.extname(file.name).toLowerCase())) continue;
      out.push({ campaignId: campaign.name, filename: file.name });
    }
  }
  return out;
}

/** Per design doc §8: player-facing model choices, each labeled with its
 * fidelity/cost tradeoff rather than just the raw model id. Stored
 * per-campaign, not globally — a long-running campaign shouldn't
 * silently change adjudication quality mid-story. */
export const MODEL_OPTIONS_CLAUDE = [
  {
    id: "claude-sonnet-5",
    label:
      "Claude Sonnet 5 (recommended) — matched to this workload (narrative + rules-following state management), not a cost compromise.",
  },
  {
    id: "claude-opus-4-8",
    label:
      "Claude Opus 4.8 — maximum rules/narrative fidelity, for players who don't mind a higher per-session cost.",
  },
  {
    id: "claude-haiku-4-5",
    label:
      "Claude Haiku 4.5 — faster and cheaper, less precise on rules. A testing/casual-session option, not the recommended default.",
  },
] as const;

/** ADR-0018: Grok as an alternate DM brain. Both models validated in Slice 0. */
export const MODEL_OPTIONS_GROK = [
  {
    id: "grok-build",
    label:
      "Grok Build (512K context) — xAI's general agent model. The recommended Grok DM.",
  },
  {
    id: "grok-composer-2.5-fast",
    label:
      "Grok Composer 2.5 Fast (200K) — faster and cheaper, but tuned for coding, so prose may read plainer.",
  },
] as const;

/** Flat union kept for `isValidModelId` and the legacy GET /models `{ models }`
 * shape. Provider-scoped lists live in `PROVIDERS` below. */
export const MODEL_OPTIONS = [...MODEL_OPTIONS_CLAUDE, ...MODEL_OPTIONS_GROK] as const;

export type ModelId = (typeof MODEL_OPTIONS)[number]["id"];
export const DEFAULT_MODEL: ModelId = "claude-sonnet-5";

export function isValidModelId(value: string): value is ModelId {
  return MODEL_OPTIONS.some((m) => m.id === value);
}

/** ADR-0018: which engine runs the DM. A per-campaign, session-resetting choice
 * like model — each provider carries its own model list and default. */
export type ProviderId = "claude" | "grok";
export const DEFAULT_PROVIDER: ProviderId = "claude";

export const PROVIDERS = [
  {
    id: "claude",
    label: "Claude — Anthropic. The recommended default DM engine.",
    models: MODEL_OPTIONS_CLAUDE,
    default: "claude-sonnet-5",
  },
  {
    id: "grok",
    label: "Grok — xAI. An alternate DM brain (ADR-0018).",
    models: MODEL_OPTIONS_GROK,
    default: "grok-build",
  },
] as const;

export function isValidProviderId(value: string): value is ProviderId {
  return PROVIDERS.some((p) => p.id === value);
}

export function modelsForProvider(provider: ProviderId): readonly { id: string; label: string }[] {
  return PROVIDERS.find((p) => p.id === provider)?.models ?? [];
}

export function isModelValidForProvider(provider: ProviderId, model: string): boolean {
  return modelsForProvider(provider).some((m) => m.id === model);
}

export function defaultModelForProvider(provider: ProviderId): ModelId {
  return (PROVIDERS.find((p) => p.id === provider)?.default ?? DEFAULT_MODEL) as ModelId;
}

const campaignSettingsFile = (campaignDir: string) =>
  path.join(campaignDir, "campaign-settings.json");

function readRawSettings(campaignDir: string): Record<string, unknown> {
  const file = campaignSettingsFile(campaignDir);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeRawSettings(campaignDir: string, raw: Record<string, unknown>): void {
  fs.writeFileSync(campaignSettingsFile(campaignDir), JSON.stringify(raw, null, 2) + "\n");
}

/** Existing campaigns with no stored preference default to DEFAULT_MODEL
 * rather than erroring — the setting is optional, not required. */
export function readCampaignModel(campaignDir: string): ModelId {
  const raw = readRawSettings(campaignDir);
  return typeof raw.model === "string" && isValidModelId(raw.model) ? raw.model : DEFAULT_MODEL;
}

/** Merges onto the existing file rather than overwriting it — this file
 * also holds the ADR-0004 reskin/tone/intensity fields below, and a plain
 * model-only write would silently wipe them out. */
export function persistCampaignModel(campaignDir: string, model: ModelId): void {
  writeRawSettings(campaignDir, { ...readRawSettings(campaignDir), model });
}

/** ADR-0018: which engine runs the DM. Every existing campaign with no stored
 * value defaults to Claude, so this is backward-compatible with no migration. */
export function readCampaignProvider(campaignDir: string): ProviderId {
  const raw = readRawSettings(campaignDir);
  return typeof raw.provider === "string" && isValidProviderId(raw.provider)
    ? raw.provider
    : DEFAULT_PROVIDER;
}

/** Merge-write like persistCampaignModel — never clobber the other settings. */
export function persistCampaignProvider(campaignDir: string, provider: ProviderId): void {
  writeRawSettings(campaignDir, { ...readRawSettings(campaignDir), provider });
}

/** Issue #114: the engine (provider) and model are set-once — chosen at
 * game creation and locked once play has begun. A mid-campaign switch left a
 * stale, provider-agnostic `.session-id` that later got resumed by the wrong
 * backend (a Grok UUID handed to the Claude SDK's `query({ resume })` → crash;
 * ADR-0018, #57). Rather than reconcile session identity across engines, we
 * forbid the change once a session exists.
 *
 * Pure predicate so the route stays thin and this is unit-testable. Returns
 * true only when the caller EXPLICITLY requested a provider/model, the resolved
 * value DIFFERS from what's stored, AND the game has started. A no-arg
 * session/start (the entry-flow re-start on continue / new-game create) never
 * requests a value, so it's always allowed; and before the first session is
 * persisted nothing is locked, so the new-game form can pick the engine. */
export function isEngineChangeLocked(args: {
  started: boolean;
  requestedProvider: boolean;
  resolvedProvider: ProviderId;
  priorProvider: ProviderId;
  requestedModel: boolean;
  resolvedModel: ModelId;
  priorModel: ModelId;
}): boolean {
  if (!args.started) return false;
  const providerChanged = args.requestedProvider && args.resolvedProvider !== args.priorProvider;
  const modelChanged = args.requestedModel && args.resolvedModel !== args.priorModel;
  return providerChanged || modelChanged;
}

/** Per ADR-0004: optional per-campaign narration-layer dials, stored
 * alongside model selection. All absent = standard fantasy defaults,
 * existing WILDCARD_CHANCE, no content bounding — this feature is opt-in. */
export type ContentIntensity = "standard" | "low";
export const CONTENT_INTENSITIES: ContentIntensity[] = ["standard", "low"];

/** Issue #69: how long/detailed the DM's narration should run. Absent is
 * deliberately treated as "detailed" (see readCampaignSettings) — the field
 * was added because players reported replies were too short, so the fix has
 * to apply to campaigns that predate the setting without needing them to
 * change anything. A player who wants the old terse behavior sets "concise". */
export type ResponseLength = "concise" | "standard" | "detailed";
export const RESPONSE_LENGTHS: ResponseLength[] = ["concise", "standard", "detailed"];
export const DEFAULT_RESPONSE_LENGTH: ResponseLength = "detailed";

/** Issue #184 / ADR-0040: turns between automatic fresh sessions when
 * `autoRotateSession` is on but `autoRotateTurns` is unset. */
export const DEFAULT_AUTO_ROTATE_TURNS = 5;

export interface CampaignSettings {
  model: ModelId;
  /** ADR-0018: which engine runs the DM. Like `model`, this is read-only via
   * GET and only changes through POST /session/start (session reset). */
  provider: ProviderId;
  artStyle?: string;
  worldSetting?: string;
  /** 0-1. Overrides seed-selector's WILDCARD_CHANCE when set (per ADR-0004,
   * this is a UI surface on that existing config, not new machinery). */
  toneWhimsy?: number;
  contentIntensity?: ContentIntensity;
  /** Issue #69: narration length/detail. Absent is treated as "detailed"
   * (DEFAULT_RESPONSE_LENGTH) at read time, so existing campaigns get the
   * richer prose the field was introduced to deliver. */
  responseLength?: ResponseLength;
  /** Per Slice 9 / design doc §2.2: defaults to false (absent) since it
   * depends on Grok Build/SuperGrok access being configured on the host —
   * opt-in, never assumed. */
  generateImages?: boolean;
  /** ADR-0027: which engine draws this game's images — "grok" (the Grok Build
   * CLI, default) or "local" (self-hosted ComfyUI). Absent means the game tracks
   * the user's account default (which falls back to `.env` DEFAULT_IMAGE_PROVIDER,
   * then "grok"), resolved live via resolveImageProvider. Unlike `provider`
   * (the DM engine), this is freely switchable mid-campaign — there's no session
   * state to reset; it only changes who draws the NEXT image. */
  imageProvider?: ImageProvider;
  /** ADR-0029: the local backend's quality tier ("fast" | "standard" | "high") —
   * time-for-quality at a fixed resolution. Absent means the game tracks the user's
   * account default (which falls back to `.env` DEFAULT_IMAGE_QUALITY, then
   * "standard"), resolved live via resolveImageQuality. Like `imageProvider`, freely
   * switchable mid-campaign — it only affects the NEXT image. Local-only; grok
   * ignores it. */
  imageQuality?: ImageQuality;
  /** Issue #154: a user-supplied "things to avoid" clause appended to the image
   * backend's own negatives (nodes 7/13 on the local backend; folded into the
   * prose on grok). Absent/empty means only the built-in anti-drift negatives
   * apply. Empty-string clears it back to absent. */
  negativePrompt?: string;
  /** Issue #154: override the deterministic per-entity SDXL seed
   * (deriveCampaignSeed). A finite non-negative integer pins the seed; absent or
   * `null` keeps today's deterministic derivation. Local-only; grok ignores it. */
  imageSeed?: number | null;
  /** Issue #154: the ComfyUI checkpoint (`ckpt_name`) the local backend should
   * load, chosen from GET /image-models. Absent/empty means the workflow
   * template's baked-in checkpoint. Local-only; grok ignores it. */
  imageModel?: string;
  /** Issue #44: when on (the default — treat absent as ON), the engine rolls
   * dice itself via the roll_dice tool and narrates the result. When
   * explicitly false, it reverts to asking the player to supply the value. */
  autoRollDice?: boolean;
  /** Issue #56: when on, the app auto-illustrates every DM response (the same
   * on-demand moment illustration a player can trigger by hand). Defaults to
   * false (absent) and is only meaningful when `generateImages` is on — it
   * needs Grok Build configured just the same. */
  autoIllustrateTurns?: boolean;
  /** Issue #184 / ADR-0040: when on (the default — treat absent as ON), the DM
   * engine automatically starts a fresh SDK session every `autoRotateTurns`
   * turns, re-priming from the state files via catchUpDirective. This is the
   * automatic counterpart to the manual "Start a fresh session" control; it
   * cures long-campaign drift from an unbounded resumed transcript. Explicit
   * false disables auto-rotation (manual rotation still available). */
  autoRotateSession?: boolean;
  /** Issue #184 / ADR-0040: how many turns between automatic fresh sessions when
   * `autoRotateSession` is on. Absent is treated as DEFAULT_AUTO_ROTATE_TURNS
   * (5) at consumption time. A finite integer >= 1. */
  autoRotateTurns?: number;
  /** Issue #109 / ADR-0020: an optional per-game music override. Absent means the
   * game tracks the user's account default (which itself falls back to `.env`);
   * present fields win over the user default via resolveMusicConfig. Credentials
   * are never stored here — only enabled/source/URL/playlist. */
  music?: UserMusic;
  /** Issue #118: when on (opt-in, default absent/false — like generateImages,
   * it needs Grok Build configured), the app offers on-demand "Animate" actions
   * that turn a still into a short clip. Video is never auto-generated. */
  generateVideos?: boolean;
  /** Issue #118: an optional per-game override of the video params
   * (duration/resolution/aspectRatio). Absent means the game tracks the user's
   * account default (which itself falls back to `.env`, then code defaults);
   * present fields win over the user default via resolveVideoConfig — same
   * two-level model as `music`. */
  video?: UserVideo;
  /** ADR-0034: which engine animates this game's stills ("grok" | "local").
   * Absent === tracks the account default (→ config.defaults.videoProvider → "grok"),
   * resolved live via resolveVideoProvider. Freely switchable mid-game like
   * imageProvider — it only affects the NEXT clip. */
  videoProvider?: VideoProvider;
  /** ADR-0035: the local video model ("wan-5b" | "ltxv"). Absent === tracks the
   * account default (→ config.defaults.videoModel → "ltxv"), resolved live via
   * resolveVideoModel. Local-only; grok ignores it. */
  videoModel?: AnimateModel;
}

export function readCampaignSettings(campaignDir: string): CampaignSettings {
  const raw = readRawSettings(campaignDir);
  const settings: CampaignSettings = {
    model: readCampaignModel(campaignDir),
    provider: readCampaignProvider(campaignDir),
  };
  if (typeof raw.artStyle === "string" && raw.artStyle.trim()) {
    settings.artStyle = raw.artStyle.trim();
  }
  if (typeof raw.worldSetting === "string" && raw.worldSetting.trim()) {
    settings.worldSetting = raw.worldSetting.trim();
  }
  if (typeof raw.toneWhimsy === "number" && raw.toneWhimsy >= 0 && raw.toneWhimsy <= 1) {
    settings.toneWhimsy = raw.toneWhimsy;
  }
  if (
    typeof raw.contentIntensity === "string" &&
    CONTENT_INTENSITIES.includes(raw.contentIntensity as ContentIntensity)
  ) {
    settings.contentIntensity = raw.contentIntensity as ContentIntensity;
  }
  if (
    typeof raw.responseLength === "string" &&
    RESPONSE_LENGTHS.includes(raw.responseLength as ResponseLength)
  ) {
    settings.responseLength = raw.responseLength as ResponseLength;
  }
  if (typeof raw.generateImages === "boolean") {
    settings.generateImages = raw.generateImages;
  }
  // ADR-0027: only attach a valid provider; a bad/absent value falls through to
  // the user default → .env → "grok" at resolve time.
  if (isValidImageProvider(raw.imageProvider)) {
    settings.imageProvider = raw.imageProvider;
  }
  // ADR-0029: same rule for the quality tier — a bad/absent value falls through to
  // the user default → .env → "standard" at resolve time.
  if (isValidImageQuality(raw.imageQuality)) {
    settings.imageQuality = raw.imageQuality;
  }
  // #154: a non-empty avoid clause; trimmed, else fall through to built-in negatives only.
  if (typeof raw.negativePrompt === "string" && raw.negativePrompt.trim()) {
    settings.negativePrompt = raw.negativePrompt.trim();
  }
  // #154: only attach a finite, non-negative seed override; anything else keeps the
  // deterministic per-entity seed at generation time.
  if (typeof raw.imageSeed === "number" && Number.isFinite(raw.imageSeed) && raw.imageSeed >= 0) {
    settings.imageSeed = Math.floor(raw.imageSeed);
  }
  // #154: a non-empty checkpoint name; absent falls through to the workflow default.
  if (typeof raw.imageModel === "string" && raw.imageModel.trim()) {
    settings.imageModel = raw.imageModel.trim();
  }
  if (typeof raw.autoRollDice === "boolean") {
    settings.autoRollDice = raw.autoRollDice;
  }
  if (typeof raw.autoIllustrateTurns === "boolean") {
    settings.autoIllustrateTurns = raw.autoIllustrateTurns;
  }
  // #184: absent === ON (default-on convention, like autoRollDice); only an
  // explicit boolean is stored, consumers treat absent as ON.
  if (typeof raw.autoRotateSession === "boolean") {
    settings.autoRotateSession = raw.autoRotateSession;
  }
  // #184: only attach a finite integer >= 1; anything else falls through to
  // DEFAULT_AUTO_ROTATE_TURNS at consumption time.
  if (
    typeof raw.autoRotateTurns === "number" &&
    Number.isFinite(raw.autoRotateTurns) &&
    raw.autoRotateTurns >= 1
  ) {
    settings.autoRotateTurns = Math.floor(raw.autoRotateTurns);
  }
  if (typeof raw.generateVideos === "boolean") {
    settings.generateVideos = raw.generateVideos;
  }
  // ADR-0034/0035: only attach a valid video provider/model; a bad/absent value falls
  // through to the user default → config default at resolve time.
  if (isValidVideoProvider(raw.videoProvider)) {
    settings.videoProvider = raw.videoProvider;
  }
  if (isAnimateModel(raw.videoModel)) {
    settings.videoModel = raw.videoModel;
  }
  // #109: only attach a music override when the stored block has at least one
  // valid field — an absent/empty override falls back to user default → .env.
  if (raw.music !== undefined) {
    const parsed = parseMusicBlock(raw.music);
    if ("value" in parsed && Object.keys(parsed.value).length > 0) {
      settings.music = parsed.value;
    }
  }
  // #118: same rule as music — attach a video-params override only when the
  // stored block has at least one valid field, else fall back to user → .env.
  if (raw.video !== undefined) {
    const parsed = parseVideoBlock(raw.video);
    if ("value" in parsed && Object.keys(parsed.value).length > 0) {
      settings.video = parsed.value;
    }
  }
  return settings;
}

/** Issue #184 / ADR-0040: given the campaign's TOTAL completed turn count and its
 * settings, decide whether the DM session should rotate to a fresh one now.
 *
 * Auto-rotation is ON unless `autoRotateSession` is explicitly false (absent ===
 * ON). It fires every `autoRotateTurns` turns (default DEFAULT_AUTO_ROTATE_TURNS),
 * i.e. whenever `totalTurns` is a positive multiple of the interval. Turn 0 never
 * rotates. Because the campaign's transcript is continuous across rotations, this
 * keys off the running total — a manual rotation between multiples is harmless.
 * Pure and side-effect-free so it can be unit-tested without the HTTP layer. */
export function shouldAutoRotate(
  totalTurns: number,
  settings: Pick<CampaignSettings, "autoRotateSession" | "autoRotateTurns">
): boolean {
  if (settings.autoRotateSession === false) return false;
  const everyN =
    typeof settings.autoRotateTurns === "number" && settings.autoRotateTurns >= 1
      ? Math.floor(settings.autoRotateTurns)
      : DEFAULT_AUTO_ROTATE_TURNS;
  return totalTurns > 0 && totalTurns % everyN === 0;
}

/** Merges the given updates onto existing settings. An empty-string
 * artStyle/worldSetting clears that field back to "absent" (i.e. default)
 * rather than being stored as a literal empty string. */
export function persistCampaignSettings(
  campaignDir: string,
  // #109: `music: null` is an explicit "reset to account default" — it drops the
  // whole per-game override (the only way to clear a stored boolean `enabled`,
  // which can't be cleared via the empty-string path below).
  updates: Partial<
    Omit<
      CampaignSettings,
      "model" | "provider" | "music" | "video" | "imageProvider" | "imageQuality" | "videoProvider" | "videoModel"
    >
  > & {
    music?: UserMusic | null;
    // #118: `video: null` is an explicit "reset to account default" — it drops
    // the whole per-game params override (mirrors `music`).
    video?: UserVideo | null;
    // ADR-0027: `imageProvider: null` resets the game to the account default (the
    // only way to un-pin a stored provider — a flat enum has no empty-string path).
    imageProvider?: ImageProvider | null;
    // ADR-0029: `imageQuality: null` resets the tier to the account default, mirroring
    // imageProvider (a flat enum has no empty-string path).
    imageQuality?: ImageQuality | null;
    // ADR-0034/0035: `null` resets the video provider/model to the account default,
    // mirroring imageProvider.
    videoProvider?: VideoProvider | null;
    videoModel?: AnimateModel | null;
  }
): CampaignSettings {
  const raw = readRawSettings(campaignDir);
  const merged: Record<string, unknown> = { ...raw, ...updates };
  if (merged.artStyle === "") delete merged.artStyle;
  if (merged.worldSetting === "") delete merged.worldSetting;
  // #154: empty-string clears the avoid clause / checkpoint back to absent (default).
  if (merged.negativePrompt === "") delete merged.negativePrompt;
  if (merged.imageModel === "") delete merged.imageModel;
  // #154: `imageSeed: null` un-pins the seed so the game reverts to the deterministic
  // per-entity derivation (a number has no empty-string path).
  if (updates.imageSeed === null) delete merged.imageSeed;
  // ADR-0027: `imageProvider: null` drops the per-game override so the game
  // tracks the account default again; a valid value pins it.
  if (updates.imageProvider === null) delete merged.imageProvider;
  // ADR-0029: `imageQuality: null` drops the per-game override so the game tracks the
  // account default again; a valid value pins it.
  if (updates.imageQuality === null) delete merged.imageQuality;
  // ADR-0034/0035: `null` drops the per-game video provider/model override.
  if (updates.videoProvider === null) delete merged.videoProvider;
  if (updates.videoModel === null) delete merged.videoModel;
  // #109: music is a nested object — one-level-deep merge (mirrors the #95 fix in
  // writeUserSettings) so patching one field (e.g. just the playlist) doesn't
  // wipe the siblings. Empty-string subfields clear that override back to absent
  // (→ user default → .env); an override with no fields left is dropped entirely.
  // `null` drops the whole override outright (reset to account default).
  if (updates.music === null) {
    delete merged.music;
  } else if (updates.music !== undefined) {
    const prev = raw.music && typeof raw.music === "object" ? (raw.music as Record<string, unknown>) : {};
    const mergedMusic: Record<string, unknown> = { ...prev, ...updates.music };
    for (const key of Object.keys(mergedMusic)) {
      if (mergedMusic[key] === "") delete mergedMusic[key];
    }
    if (Object.keys(mergedMusic).length > 0) merged.music = mergedMusic;
    else delete merged.music;
  }
  // #118: the video params override mirrors music exactly — `null` drops the
  // whole override (reset to account default); otherwise a one-level-deep merge
  // so patching one param doesn't wipe its siblings, dropping the block if empty.
  if (updates.video === null) {
    delete merged.video;
  } else if (updates.video !== undefined) {
    const prev = raw.video && typeof raw.video === "object" ? (raw.video as Record<string, unknown>) : {};
    const mergedVideo: Record<string, unknown> = { ...prev, ...updates.video };
    if (Object.keys(mergedVideo).length > 0) merged.video = mergedVideo;
    else delete merged.video;
  }
  writeRawSettings(campaignDir, merged);
  return readCampaignSettings(campaignDir);
}

/** Recency signal for "most recently played" — the newest mtime among a
 * campaign's turn transcripts (actual play), falling back to its settings file,
 * then the directory itself. Turn transcripts are the truest "last played"
 * marker; a campaign that was only ever configured (no turns) still ranks by
 * when its settings were last written. */
function campaignRecencyMs(campaignDir: string): number {
  const logDir = path.join(campaignDir, "session-log");
  let newest = 0;
  if (fs.existsSync(logDir)) {
    for (const f of fs.readdirSync(logDir)) {
      if (!f.endsWith(".transcript.jsonl")) continue;
      try {
        newest = Math.max(newest, fs.statSync(path.join(logDir, f)).mtimeMs);
      } catch {
        // ignore an unreadable log — recency is best-effort ranking, not a hard read
      }
    }
  }
  if (newest > 0) return newest;
  for (const rel of ["campaign-settings.json", ""]) {
    try {
      return fs.statSync(path.join(campaignDir, rel)).mtimeMs;
    } catch {
      // fall through to the next candidate
    }
  }
  return 0;
}

/** Issue #64: the look/play/model settings a NEW game inherits — copied from the
 * most recently *played* campaign so a new game starts like the last one, rather
 * than reverting to the raw scaffold defaults (images off, auto-roll on, Sonnet).
 * This replaces #60's per-device localStorage seeding, which only remembered
 * fields the player happened to re-toggle after that fix shipped. `worldSetting`
 * is deliberately excluded — it's the premise of each specific game, typed fresh
 * on the New Chronicle screen. Returns {} when no eligible campaign exists yet,
 * so the create screen falls back to neutral defaults. */
export function newGameDefaultSettings(userId: string): Partial<CampaignSettings> {
  const root = userCampaignsRoot(userId);
  if (!fs.existsSync(root)) return {};
  let best: { dir: string; recency: number } | undefined;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "_registry") continue;
    if (!CAMPAIGN_ID_PATTERN.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    if (!fs.existsSync(path.join(dir, "character-sheet.json"))) continue;
    const recency = campaignRecencyMs(dir);
    if (!best || recency > best.recency) best = { dir, recency };
  }
  if (!best) return {};
  const { worldSetting: _worldSetting, ...inheritable } = readCampaignSettings(best.dir);
  return inheritable;
}

const sessionIdFile = (campaignDir: string) => path.join(campaignDir, ".session-id");

export function readPersistedSessionId(campaignDir: string): string | undefined {
  const file = sessionIdFile(campaignDir);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : undefined;
}

export function persistSessionId(campaignDir: string, sessionId: string): void {
  fs.writeFileSync(sessionIdFile(campaignDir), sessionId);
}

/** ADR-0040: drop the persisted SDK session id so the next turn starts a fresh
 * conversation (manual session rotation). Game state is untouched — it lives in
 * the state files, not the SDK conversation. A missing file is a no-op. */
export function clearPersistedSessionId(campaignDir: string): void {
  fs.rmSync(sessionIdFile(campaignDir), { force: true });
}

/** Creates a new append-only session-log file and returns its path,
 * relative to the campaign directory (this is what dm-engine's system
 * prompt tells the model to append to). */
export function startSessionLog(campaignDir: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const relPath = `session-log/session-${timestamp}.md`;
  fs.writeFileSync(path.join(campaignDir, relPath), `# Session ${timestamp}\n\n`);
  return relPath;
}

function latestSessionLogPath(campaignDir: string): string | undefined {
  const dir = path.join(campaignDir, "session-log");
  if (!fs.existsSync(dir)) return undefined;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  return files.length > 0 ? `session-log/${files[files.length - 1]}` : undefined;
}

/** Most recent session log that actually holds turns (a non-empty
 * .transcript.jsonl), or undefined if none do yet. Resume and the /state
 * fallback both want "the log holding the story," not merely the newest .md:
 * a stray empty log from an earlier session/start would otherwise shadow the
 * real one and surface as "the tale hasn't begun" even for a campaign with
 * rich history (issue #49). */
function latestSessionLogWithTurns(campaignDir: string): string | undefined {
  const dir = path.join(campaignDir, "session-log");
  if (!fs.existsSync(dir)) return undefined;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const rel = `session-log/${files[i]}`;
    if (readTurnTranscript(campaignDir, rel).length > 0) return rel;
  }
  return undefined;
}

/** One log file per session-log/§3's actual "session," not per API call:
 * reuses the most recent log file when resuming an existing Agent SDK
 * conversation, and only starts a fresh one for a genuinely new
 * conversation. Calling startSessionLog() on every resume (e.g. once per
 * page load, once per settings change) fragmented the log across mostly
 * empty files — the model kept writing to whichever file it remembered
 * from earlier in the resumed conversation, not the newest one. */
export function resolveSessionLog(campaignDir: string, resuming: boolean): string {
  // Continue the existing story whenever the campaign already has one — append
  // to the log that actually holds turns, not merely the newest .md — regardless
  // of whether the SDK session is being resumed. ADR-0040/0041 session rotation
  // deliberately drops the persisted SDK session id (so `resuming` is false on the
  // next /session/start) while keeping the on-disk transcript continuous. Forking
  // a fresh log here on that non-resume start stranded the story's turns in the
  // old log: the /state view falls back to the log-with-turns for DISPLAY, but the
  // active session pointed at the new empty log, so the moment seams
  // (illustrate/animate) reported "no turn N in the active session" for turns the
  // player could plainly see. Keying continuity off the log-with-turns rather than
  // the `resuming` flag keeps both in sync. The `resuming` parameter is retained
  // for the call sites and intent, but no longer changes which log we land on.
  void resuming;
  const withTurns = latestSessionLogWithTurns(campaignDir);
  if (withTurns) return withTurns;
  // No turns yet (a genuinely new campaign, or only empty logs). Reuse the newest
  // empty log rather than piling up another empty file — the empty-.md
  // accumulation seen in real campaign data (#49).
  const existing = latestSessionLogPath(campaignDir);
  if (existing) return existing;
  return startSessionLog(campaignDir);
}

/** Per ADR-0007: the server's own deterministic record of who said what,
 * written at the moment both strings are already in hand — never
 * inferred from the model's prose. One JSONL file per session, alongside
 * (not replacing) that session's prose log. */
export interface TurnTranscriptRecord {
  turnIndex: number;
  timestamp: string;
  /** The player's action for this turn. ADR-0013: an **empty string** marks a
   * DM-initiated turn with no player action — specifically the opening scene
   * (turn-zero) generated when a campaign begins. Consumers must treat "" as
   * "the DM spoke unprompted" (the UI omits the "YOU" block), not as missing
   * data. Every ordinary turn carries a non-empty player message. */
  playerMessage: string;
  narration: string;
  /** ADR-0009 addendum (additive): a user-triggered "illustrate this moment"
   * records the generated scene image's relative path here. Absent on every
   * record predating that action and on turns never illustrated — the field
   * being missing means exactly "no image," same as an entity with no
   * portrait. */
  image?: string;
  /** Issue #118 (additive, same shape as `image`): a user-triggered "animate
   * this moment" records the generated clip's relative path here. Absent means
   * "no video," identical to the image field's absent semantics. */
  video?: string;
  /** ADR-0030 (Issue #128, additive): the DM-emitted `[SCENE: ...]` visual
   * caption for this turn, parsed off the narration and used to illustrate/
   * animate the moment instead of the raw prose. Absent on every record
   * predating the feature and on any turn where the model omitted the line —
   * the moment seams fall back to `narration` when it's missing. Never
   * player-facing. */
  sceneCaption?: string;
  /** Issue #134 (additive): the DM-emitted [PRESENT: ...] list of KNOWN entities
   * visibly in frame this turn (canonical names, focal subject first). Used to
   * ground scene images in each entity's established appearance. Absent on every
   * record predating the feature and on turns the DM emitted no tag for — the
   * moment seams simply skip grounding when it's missing. Never player-facing. */
  presentEntities?: string[];
}

/** session-log/session-<ts>.md -> session-log/session-<ts>.transcript.jsonl */
function transcriptPathFor(sessionLogRelPath: string): string {
  return sessionLogRelPath.replace(/\.md$/, ".transcript.jsonl");
}

export function readTurnTranscript(campaignDir: string, sessionLogRelPath: string): TurnTranscriptRecord[] {
  const abs = path.join(campaignDir, transcriptPathFor(sessionLogRelPath));
  if (!fs.existsSync(abs)) return [];
  return fs
    .readFileSync(abs, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TurnTranscriptRecord);
}

/** Appends one record and returns it. turnIndex is derived from how many
 * records already exist for this session — fine for a single-process,
 * single-household app where turns are submitted strictly one at a time
 * (ADR-0003's trust boundary), not a concern requiring a lock file. */
export function appendTurnTranscript(
  campaignDir: string,
  sessionLogRelPath: string,
  playerMessage: string,
  narration: string,
  sceneCaption?: string,
  presentEntities?: string[]
): TurnTranscriptRecord {
  const abs = path.join(campaignDir, transcriptPathFor(sessionLogRelPath));
  const turnIndex = readTurnTranscript(campaignDir, sessionLogRelPath).length;
  const record: TurnTranscriptRecord = {
    turnIndex,
    timestamp: new Date().toISOString(),
    playerMessage,
    narration,
  };
  // ADR-0030: known at append time (parsed off result.text at the server), so
  // it's set on the record directly — no separate read-modify-rewrite setter
  // like image/video, which are attached after the fact. Omit the key entirely
  // when absent to keep parity with the image/video absent-means-unset shape.
  if (sceneCaption && sceneCaption.trim()) record.sceneCaption = sceneCaption.trim();
  // Issue #134: same append-time, omit-when-absent contract as sceneCaption.
  if (presentEntities && presentEntities.length) record.presentEntities = presentEntities;
  fs.appendFileSync(abs, JSON.stringify(record) + "\n");
  return record;
}

/** ADR-0009: attach a generated scene image to one already-recorded turn.
 * Rewrites the JSONL (rather than appending) because it's mutating an
 * existing record's `image` field — safe under the same single-turn-at-a-time
 * assumption appendTurnTranscript relies on. Throws if the turn isn't found. */
export function setTranscriptRecordImage(
  campaignDir: string,
  sessionLogRelPath: string,
  turnIndex: number,
  image: string
): TurnTranscriptRecord {
  const records = readTurnTranscript(campaignDir, sessionLogRelPath);
  const record = records.find((r) => r.turnIndex === turnIndex);
  if (!record) {
    throw new Error(`no transcript record at turn ${turnIndex} for ${sessionLogRelPath}`);
  }
  record.image = image;
  const abs = path.join(campaignDir, transcriptPathFor(sessionLogRelPath));
  fs.writeFileSync(abs, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return record;
}

/** Issue #118: attach a generated clip to one already-recorded turn. Exact
 * analog of setTranscriptRecordImage (rewrites the JSONL to mutate the record's
 * `video` field). Throws if the turn isn't found. */
export function setTranscriptRecordVideo(
  campaignDir: string,
  sessionLogRelPath: string,
  turnIndex: number,
  video: string
): TurnTranscriptRecord {
  const records = readTurnTranscript(campaignDir, sessionLogRelPath);
  const record = records.find((r) => r.turnIndex === turnIndex);
  if (!record) {
    throw new Error(`no transcript record at turn ${turnIndex} for ${sessionLogRelPath}`);
  }
  record.video = video;
  const abs = path.join(campaignDir, transcriptPathFor(sessionLogRelPath));
  fs.writeFileSync(abs, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return record;
}

/** ADR-0030 (Issue #130): attach a scene caption to an already-recorded turn.
 * Exact analog of setTranscriptRecordImage/Video. Unlike the caption set at
 * append time by appendTurnTranscript, this patches a record whose turn emitted
 * NO [SCENE:] line — the caption arrives afterward from the one-shot same-session
 * retry (server.ts), which runs after the narration response is already sent.
 * A blank caption is a no-op (leaves the record captionless → narration
 * fallback). Throws if the turn isn't found. */
export function setTranscriptRecordSceneCaption(
  campaignDir: string,
  sessionLogRelPath: string,
  turnIndex: number,
  sceneCaption: string
): TurnTranscriptRecord {
  const records = readTurnTranscript(campaignDir, sessionLogRelPath);
  const record = records.find((r) => r.turnIndex === turnIndex);
  if (!record) {
    throw new Error(`no transcript record at turn ${turnIndex} for ${sessionLogRelPath}`);
  }
  if (!sceneCaption || !sceneCaption.trim()) return record;
  record.sceneCaption = sceneCaption.trim();
  const abs = path.join(campaignDir, transcriptPathFor(sessionLogRelPath));
  fs.writeFileSync(abs, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return record;
}

// ── Issue #68 (ADR-0016): editable history via pre-turn state snapshots ──
// Before every turn/opening the server snapshots the campaign's mutable state
// (the four state files + the active prose session log). Editing a past turn
// restores its pre-turn snapshot, truncates the transcript, and re-runs from
// the edited message on a fresh SDK session (the SDK conversation is linear;
// files are the source of truth per ADR-0001).

/** The mutable per-turn state files the DM engine rewrites. The prose session
 * log is snapshotted separately (it's the active .md, path varies per session). */
const SNAPSHOT_STATE_FILES = [
  "character-sheet.json",
  "world-state.md",
  "npc-roster.md",
  "quest-log.md",
];

function sessionBaseOf(sessionLogRelPath: string): string {
  return path.basename(sessionLogRelPath).replace(/\.md$/, "");
}

function snapshotTurnDir(campaignDir: string, sessionLogRelPath: string, turnIndex: number): string {
  const base = sessionBaseOf(sessionLogRelPath);
  const padded = String(turnIndex).padStart(4, "0");
  return path.join(campaignDir, "session-log", "snapshots", base, `turn-${padded}`);
}

export interface SnapshotManifest {
  turnIndex: number;
  sessionLogRelPath: string;
  timestamp: string;
}

/** Snapshot the campaign's state as it is right now — i.e. BEFORE turn
 * `turnIndex` runs — so an edit of that turn can restore this exact point.
 * Copies the four state files and the active prose log into
 * session-log/snapshots/<sessionBase>/turn-<NNNN>/. Cheap (small text files);
 * failures are swallowed so a snapshot problem never blocks actual play. */
export function writePreTurnSnapshot(
  campaignDir: string,
  sessionLogRelPath: string,
  turnIndex: number
): void {
  try {
    const dir = snapshotTurnDir(campaignDir, sessionLogRelPath, turnIndex);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of SNAPSHOT_STATE_FILES) {
      const src = path.join(campaignDir, name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
    }
    // The active prose log, by its own basename (append-only, so restoring an
    // earlier copy drops the discarded turns' summaries cleanly).
    const proseSrc = path.join(campaignDir, sessionLogRelPath);
    if (fs.existsSync(proseSrc)) {
      fs.copyFileSync(proseSrc, path.join(dir, path.basename(sessionLogRelPath)));
    }
    const manifest: SnapshotManifest = {
      turnIndex,
      sessionLogRelPath,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  } catch (err) {
    console.error(`[campaign-store] pre-turn snapshot failed for turn ${turnIndex}: ${String(err)}`);
  }
}

export function hasPreTurnSnapshot(
  campaignDir: string,
  sessionLogRelPath: string,
  turnIndex: number
): boolean {
  return fs.existsSync(path.join(snapshotTurnDir(campaignDir, sessionLogRelPath, turnIndex), "manifest.json"));
}

/** Restore the pre-turn snapshot for `turnIndex`, overwriting the live state
 * files and prose log. Reads every snapshot file into memory FIRST, then writes
 * them all, so a mid-restore failure can't leave a half-rewound campaign.
 * Throws if the snapshot is missing. */
export function restorePreTurnSnapshot(
  campaignDir: string,
  sessionLogRelPath: string,
  turnIndex: number
): void {
  const dir = snapshotTurnDir(campaignDir, sessionLogRelPath, turnIndex);
  if (!fs.existsSync(path.join(dir, "manifest.json"))) {
    throw new Error(`no pre-turn snapshot for turn ${turnIndex}`);
  }
  const writes: Array<{ dest: string; data: Buffer }> = [];
  for (const name of SNAPSHOT_STATE_FILES) {
    const snap = path.join(dir, name);
    if (fs.existsSync(snap)) writes.push({ dest: path.join(campaignDir, name), data: fs.readFileSync(snap) });
  }
  const proseSnap = path.join(dir, path.basename(sessionLogRelPath));
  if (fs.existsSync(proseSnap)) {
    writes.push({ dest: path.join(campaignDir, sessionLogRelPath), data: fs.readFileSync(proseSnap) });
  }
  for (const w of writes) fs.writeFileSync(w.dest, w.data);
}

/** Keep only the first `keepCount` transcript records for a session, dropping
 * the rest (an edit re-runs from turn `keepCount`). keepCount 0 empties it. */
export function truncateTranscript(
  campaignDir: string,
  sessionLogRelPath: string,
  keepCount: number
): void {
  const abs = path.join(campaignDir, transcriptPathFor(sessionLogRelPath));
  const kept = readTurnTranscript(campaignDir, sessionLogRelPath).slice(0, Math.max(0, keepCount));
  fs.writeFileSync(abs, kept.length ? kept.map((r) => JSON.stringify(r)).join("\n") + "\n" : "");
}

/** Remove snapshots for turns strictly after `turnIndex` — they described a
 * timeline that the edit just discarded. The snapshot for `turnIndex` itself is
 * kept (it's the pre-state we restored, still valid if the turn is re-edited). */
export function pruneSnapshotsAfter(
  campaignDir: string,
  sessionLogRelPath: string,
  turnIndex: number
): void {
  const base = sessionBaseOf(sessionLogRelPath);
  const dir = path.join(campaignDir, "session-log", "snapshots", base);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    const m = /^turn-(\d+)$/.exec(entry);
    if (m && Number(m[1]) > turnIndex) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }
}

// The literal field/heading names the frontend parser reads back (mirrored
// from web/src/lib/state-headings.ts, cross-checked in
// web/tests/heading-consistency.spec.ts). A server-side image write must
// produce exactly these so buildGallery/parseNpcRoster pick it up.
const NPC_PORTRAIT_FIELD = "Portrait asset ID";
/** Issue #118: the video analog of the portrait bullet. A distinct field so a
 * clip never overwrites the still — the gallery can show both. */
const NPC_PORTRAIT_VIDEO_FIELD = "Portrait video ID";
const LOCATIONS_VISITED_HEADING = "Locations Visited";
const HEADING_LINE_RE = /^(#{1,6})\s+(.*\S)\s*$/;

/** Insert or replace the `- **Portrait asset ID:** <relPath>` bullet under the
 * given NPC's `## <name>` heading in npc-roster.md — the same bullet the model
 * is told to write (image-generator.ts). Pure string transform; unit-tested. */
export function withNpcPortrait(rosterMd: string, npcName: string, relPath: string): string {
  return withNpcField(rosterMd, npcName, NPC_PORTRAIT_FIELD, relPath);
}

/** Issue #118: the `- **Portrait video ID:** <relPath>` analog of
 * withNpcPortrait — same section logic, different field label. */
export function withNpcPortraitVideo(rosterMd: string, npcName: string, relPath: string): string {
  return withNpcField(rosterMd, npcName, NPC_PORTRAIT_VIDEO_FIELD, relPath);
}

/** Shared body for withNpcPortrait/withNpcPortraitVideo: insert or replace a
 * `- **<field>:** <relPath>` bullet under the given NPC's `## <name>` heading. */
function withNpcField(rosterMd: string, npcName: string, field: string, relPath: string): string {
  const bullet = `- **${field}:** ${relPath}`;
  const lines = rosterMd.split(/\r?\n/);
  const target = npcName.trim().toLowerCase();

  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_LINE_RE.exec(lines[i]);
    if (m && m[1].length === 2 && m[2].trim().toLowerCase() === target) {
      headingIdx = i;
      break;
    }
  }

  if (headingIdx === -1) {
    const suffix = rosterMd.endsWith("\n") ? "" : "\n";
    return `${rosterMd}${suffix}\n## ${npcName.trim()}\n${bullet}\n`;
  }

  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (HEADING_LINE_RE.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  const portraitRe = new RegExp(`^-\\s*\\*\\*${field}:\\*\\*`, "i");
  for (let i = headingIdx + 1; i < sectionEnd; i++) {
    if (portraitRe.test(lines[i].trim())) {
      lines[i] = bullet;
      return lines.join("\n");
    }
  }
  lines.splice(headingIdx + 1, 0, bullet);
  return lines.join("\n");
}

/** Issue #134: read the `- **Description:** ...` bullet value from the given
 * NPC's `## <name>` section in npc-roster.md — the server-side counterpart to
 * the web `parseNpcRoster`'s Description field, reusing the same level-2
 * HEADING_LINE_RE section scan as withNpcField. NPC entries carry no dedicated
 * appearance field; appearance is folded into the freeform Description bullet,
 * so that bullet is what grounds a scene image in the NPC's established look.
 * Returns undefined when the campaign has no roster, no such NPC section, or the
 * section carries no (non-empty) Description bullet. Never throws. */
export function readNpcAppearance(campaignDir: string, npcName: string): string | undefined {
  let rosterMd: string;
  try {
    rosterMd = fs.readFileSync(path.join(campaignDir, "npc-roster.md"), "utf8");
  } catch {
    return undefined;
  }
  const lines = rosterMd.split(/\r?\n/);
  const target = npcName.trim().toLowerCase();

  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_LINE_RE.exec(lines[i]);
    if (m && m[1].length === 2 && m[2].trim().toLowerCase() === target) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) return undefined;

  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (HEADING_LINE_RE.test(lines[i])) {
      sectionEnd = i;
      break;
    }
  }
  const descRe = /^-\s*\*\*Description:\*\*\s*(.*)$/i;
  for (let i = headingIdx + 1; i < sectionEnd; i++) {
    const m = descRe.exec(lines[i].trim());
    if (m) {
      const val = m[1].trim();
      return val || undefined;
    }
  }
  return undefined;
}

/** Insert or replace an indented `- Image: <relPath>` line under the named
 * location's bullet in world-state.md's "## Locations Visited" section —
 * matching gallery.ts's IMAGE_LINE_RE. Pure string transform; unit-tested. */
export function withLocationImage(worldStateMd: string, locationName: string, relPath: string): string {
  return withLocationAsset(worldStateMd, locationName, "Image", relPath);
}

/** Issue #118: the `  - Video: <relPath>` analog of withLocationImage — same
 * section logic, different label so a clip never overwrites the still. */
export function withLocationVideo(worldStateMd: string, locationName: string, relPath: string): string {
  return withLocationAsset(worldStateMd, locationName, "Video", relPath);
}

/** Shared body for withLocationImage/withLocationVideo: insert or replace an
 * indented `  - <label>: <relPath>` line under the named location's bullet. */
function withLocationAsset(worldStateMd: string, locationName: string, label: string, relPath: string): string {
  const imageLine = `  - ${label}: ${relPath}`;
  const lines = worldStateMd.split(/\r?\n/);
  const target = locationName.trim().toLowerCase();

  let secStart = -1;
  let secEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_LINE_RE.exec(lines[i]);
    if (m && m[2].trim().toLowerCase() === LOCATIONS_VISITED_HEADING.toLowerCase()) {
      secStart = i + 1;
      for (let j = i + 1; j < lines.length; j++) {
        if (HEADING_LINE_RE.test(lines[j])) {
          secEnd = j;
          break;
        }
      }
      break;
    }
  }
  if (secStart === -1) return worldStateMd; // no section to attach to — leave untouched

  const topBulletRe = /^-\s*\*\*([^*]+)\*\*\s*(?:[—-]\s*)?(.*)$/;
  let bulletIdx = -1;
  for (let i = secStart; i < secEnd; i++) {
    const raw = lines[i];
    if (/^[ \t]/.test(raw)) continue; // indented continuation, not a top bullet
    const line = raw.trim();
    if (!line.startsWith("-")) continue;
    const mm = topBulletRe.exec(line);
    const name = mm ? mm[1].trim() : line.replace(/^-\s*/, "").trim();
    if (name.toLowerCase() === target) {
      bulletIdx = i;
      break;
    }
  }

  if (bulletIdx === -1) {
    lines.splice(secEnd, 0, `- **${locationName.trim()}**`, imageLine);
    return lines.join("\n");
  }

  let blockEnd = secEnd;
  for (let i = bulletIdx + 1; i < secEnd; i++) {
    const raw = lines[i];
    if (HEADING_LINE_RE.test(raw)) {
      blockEnd = i;
      break;
    }
    if (!/^[ \t]/.test(raw) && raw.trim().startsWith("-")) {
      blockEnd = i;
      break;
    }
  }
  const imageRe = new RegExp(`^-?\\s*\\*{0,2}${label}\\*{0,2}:\\s*(.+)$`, "i");
  for (let i = bulletIdx + 1; i < blockEnd; i++) {
    if (imageRe.test(lines[i].trim())) {
      lines[i] = imageLine;
      return lines.join("\n");
    }
  }
  lines.splice(bulletIdx + 1, 0, imageLine);
  return lines.join("\n");
}

/** ADR-0009: record an on-demand entity image into its state file, so the
 * gallery/portrait code (which reads images out of state files) shows it with
 * no other change. item/scene aren't recorded here — an item has no gallery
 * entry and a scene lives on the transcript record instead. */
export function recordEntityImage(
  campaignDir: string,
  entityType: "character" | "npc" | "boss" | "location",
  name: string,
  relPath: string
): void {
  if (entityType === "character") {
    const p = path.join(campaignDir, "character-sheet.json");
    const sheet = JSON.parse(fs.readFileSync(p, "utf8"));
    sheet.portraitImage = relPath;
    fs.writeFileSync(p, JSON.stringify(sheet, null, 2) + "\n");
  } else if (entityType === "npc" || entityType === "boss") {
    const p = path.join(campaignDir, "npc-roster.md");
    fs.writeFileSync(p, withNpcPortrait(fs.readFileSync(p, "utf8"), name, relPath));
  } else if (entityType === "location") {
    const p = path.join(campaignDir, "world-state.md");
    fs.writeFileSync(p, withLocationImage(fs.readFileSync(p, "utf8"), name, relPath));
  }
}

/** Issue #118: record an on-demand entity clip into its state file, alongside
 * (never replacing) the still. Exact analog of recordEntityImage —
 * `portraitVideo` on character-sheet.json, a "Portrait video ID" bullet for
 * NPCs/bosses, a "Video" line for locations. */
export function recordEntityVideo(
  campaignDir: string,
  entityType: "character" | "npc" | "boss" | "location",
  name: string,
  relPath: string
): void {
  if (entityType === "character") {
    const p = path.join(campaignDir, "character-sheet.json");
    const sheet = JSON.parse(fs.readFileSync(p, "utf8"));
    sheet.portraitVideo = relPath;
    fs.writeFileSync(p, JSON.stringify(sheet, null, 2) + "\n");
  } else if (entityType === "npc" || entityType === "boss") {
    const p = path.join(campaignDir, "npc-roster.md");
    fs.writeFileSync(p, withNpcPortraitVideo(fs.readFileSync(p, "utf8"), name, relPath));
  } else if (entityType === "location") {
    const p = path.join(campaignDir, "world-state.md");
    fs.writeFileSync(p, withLocationVideo(fs.readFileSync(p, "utf8"), name, relPath));
  }
}

/** Issue #71: set (or clear) the player character's free-text appearance on
 * character-sheet.json, so an already-created character can be fixed without
 * remaking the campaign. Mirrors recordEntityImage's character-sheet write.
 * An empty string clears the field back to absent. Returns the stored value. */
export function setCharacterAppearance(campaignDir: string, appearance: string): string | undefined {
  const p = path.join(campaignDir, "character-sheet.json");
  const sheet = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  const trimmed = appearance.trim();
  if (trimmed) {
    sheet.appearance = trimmed;
  } else {
    delete sheet.appearance;
  }
  fs.writeFileSync(p, JSON.stringify(sheet, null, 2) + "\n");
  return trimmed || undefined;
}

export interface StateSnapshot {
  characterSheet: unknown;
  worldState: string;
  npcRoster: string;
  questLog: string;
  model: ModelId;
  currentSessionLog?: { path: string; content: string; transcript: TurnTranscriptRecord[] };
}

export function readStateSnapshot(
  campaignDir: string,
  currentSessionLogRelPath?: string
): StateSnapshot {
  const read = (name: string) => fs.readFileSync(path.join(campaignDir, name), "utf8");

  const snapshot: StateSnapshot = {
    characterSheet: JSON.parse(read("character-sheet.json")),
    worldState: read("world-state.md"),
    npcRoster: read("npc-roster.md"),
    questLog: read("quest-log.md"),
    model: readCampaignModel(campaignDir),
  };

  // Prefer the caller's active session log, but fall back to the latest log
  // that has turns when there's no active session (server restart / deep link
  // into Play) or when the active log is still empty — otherwise a resumed
  // campaign with real history renders as "the tale hasn't begun" (#49).
  let logRel = currentSessionLogRelPath;
  if (!logRel || readTurnTranscript(campaignDir, logRel).length === 0) {
    logRel = latestSessionLogWithTurns(campaignDir) ?? logRel;
  }
  if (logRel) {
    const abs = path.join(campaignDir, logRel);
    if (fs.existsSync(abs)) {
      snapshot.currentSessionLog = {
        path: logRel,
        content: fs.readFileSync(abs, "utf8"),
        transcript: readTurnTranscript(campaignDir, logRel),
      };
    }
  }

  return snapshot;
}
