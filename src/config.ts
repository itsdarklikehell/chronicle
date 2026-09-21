import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Like structuredClone but typed for record-shaped config objects. Uses JSON
 * round-trip under the hood so it stays cheap for config-sized objects, and
 * returns a plain Record<string, unknown> so `deepMerge` never sees frozen
 * or exotic objects.
 */
function cloneRecord(obj: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * File-based configuration (ADR-0033). Two JSON files at the repo root, each with a
 * committed `*.example.json` sibling:
 *   - config.json  (git-ignored)  — real non-secret settings
 *   - secrets.json (git-ignored)  — secrets only (bootstrap + Navidrome credentials)
 * The examples hold the real defaults / empty placeholders and are self-documenting
 * via `_comment*` keys (JSON has no comments; the loader ignores unknown keys).
 *
 * This module reads both files ONCE at import into a typed, deep-frozen object.
 * Every consumer imports `config` / `secrets` from here — nothing in src/ reads
 * environment variables. Missing config.json falls back to config.example.json; missing
 * secrets.json degrades gracefully (features needing a secret just stay off);
 * malformed JSON is warned about and ignored rather than crashing the app.
 */

export interface ConfigDefaults {
  provider: string;
  model: string;
  imageProvider: string;
  imageQuality: string;
  artStyle: string;
  /** #154: a default "things to avoid" clause; "" for none. */
  negativePrompt: string;
  /** #154: a default ComfyUI checkpoint (`ckpt_name`) for the local backend; "" = template default. */
  imageModel: string;
  /** #174: the refiner checkpoint (`ckpt_name`) for High quality's base→refiner ensemble
   * (node "11"); "" = the template default (`sd_xl_refiner_1.0.safetensors`). Set this when
   * the refiner lives in a ComfyUI subfolder (e.g. "s/sd_xl_refiner_1.0.safetensors").
   * When the resolved refiner isn't installed, High degrades to base high-steps. */
  imageRefinerModel: string;
  /** #154: a default SDXL seed override, or null for the deterministic per-entity seed. */
  imageSeed: number | null;
  worldSetting: string;
  contentIntensity: string;
  responseLength: string;
  /** 0..1, or null for "no forced default" (field stays unset for new users). */
  toneWhimsy: number | null;
  autoIllustrate: boolean;
  generateImages: boolean;
  generateVideos: boolean;
  /** ADR-0034: which engine animates stills ("grok" | "local"). */
  videoProvider: string;
  /** ADR-0035: the local video model ("wan-5b" | "ltxv"). */
  videoModel: string;
  autoRollDice: boolean;
  musicEnabled: boolean;
  musicSource: string;
  videoDuration: number;
  videoResolution: string;
  videoAspect: string;
  seedWildcardChance: number;
}

export interface ChronicleConfig {
  server: { host: string; port: number };
  comfyui: { url: string };
  navidrome: { url: string; playlist: string };
  defaults: ConfigDefaults;
}

export interface ChronicleSecrets {
  bootstrap: { username: string; password: string };
  navidrome: { username: string; password: string };
}

/** Built-in defaults — the last-resort values if neither config.json nor
 * config.example.json is present. Kept identical to config.example.json and to the
 * pre-ADR-0033 `.env` defaults so behavior is unchanged. */
export const CONFIG_DEFAULTS: ChronicleConfig = {
  server: { host: "127.0.0.1", port: 4317 },
  comfyui: { url: "http://localhost:8188" },
  navidrome: { url: "", playlist: "" },
  defaults: {
    provider: "claude",
    model: "claude-sonnet-5",
    imageProvider: "grok",
    imageQuality: "standard",
    artStyle: "",
    negativePrompt: "",
    imageModel: "",
    imageRefinerModel: "",
    imageSeed: null,
    worldSetting: "",
    contentIntensity: "",
    responseLength: "detailed",
    toneWhimsy: null,
    autoIllustrate: false,
    generateImages: false,
    generateVideos: false,
    videoProvider: "grok",
    videoModel: "ltxv",
    autoRollDice: true,
    musicEnabled: false,
    musicSource: "local",
    videoDuration: 5,
    videoResolution: "480p",
    videoAspect: "square",
    seedWildcardChance: 0.175,
  },
};

const SECRETS_DEFAULTS: ChronicleSecrets = {
  bootstrap: { username: "", password: "" },
  navidrome: { username: "", password: "" },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursively overlay `source` onto `target`, mutating and returning `target`.
 * Only nested plain objects are merged; scalars/arrays/null overwrite. */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      deepMerge(existing, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object") {
    for (const value of Object.values(obj)) deepFreeze(value);
    Object.freeze(obj);
  }
  return obj;
}

/** Parse a JSON file, or return undefined if it is absent or unreadable. A present
 * but malformed file logs a clear warning and is treated as absent (never throws). */
function readJsonIfPresent(file: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return isPlainObject(parsed) ? parsed : undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[config] ${path.basename(file)} is not valid JSON (${msg}); ignoring it.`);
    return undefined;
  }
}

export interface LoadedConfig {
  config: ChronicleConfig;
  secrets: ChronicleSecrets;
  /** Where each value came from — for a friendly startup log. */
  sources: {
    config: "config.json" | "config.example.json" | "built-in defaults";
    secrets: "secrets.json" | "none";
  };
}

/** Pure loader: read config + secrets from `dir`, merge over the built-in defaults,
 * and deep-freeze. Exported so tests can point it at a temp directory. */
export function loadConfigFrom(dir: string): LoadedConfig {
  const configFile = readJsonIfPresent(path.join(dir, "config.json"));
  const exampleFile = configFile ? undefined : readJsonIfPresent(path.join(dir, "config.example.json"));
  const rawConfig = configFile ?? exampleFile ?? {};
  const config = deepFreeze(
    deepMerge(cloneRecord(CONFIG_DEFAULTS as unknown as Record<string, unknown>), rawConfig) as unknown
  ) as ChronicleConfig;

  const rawSecrets = readJsonIfPresent(path.join(dir, "secrets.json"));
  const secrets = deepFreeze(
    deepMerge(cloneRecord(SECRETS_DEFAULTS as unknown as Record<string, unknown>), rawSecrets ?? {}) as unknown
  ) as ChronicleSecrets;

  return {
    config,
    secrets,
    sources: {
      config: configFile ? "config.json" : exampleFile ? "config.example.json" : "built-in defaults",
      secrets: rawSecrets ? "secrets.json" : "none",
    },
  };
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The process-wide singleton, loaded once from the repo root. Resolved via this
 * module's own location (not cwd), so it works identically in the spawned MCP
 * subprocesses. */
export const { config, secrets, sources: configSources } = loadConfigFrom(REPO_ROOT);
