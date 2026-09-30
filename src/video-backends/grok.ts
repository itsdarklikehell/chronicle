// ADR-0034: the "grok" VideoBackend — a verbatim lift of the original
// generateVideo logic (ADR-0026) and its whole safety cage. Grok Build is a full
// agentic *coding* assistant, not a bare video endpoint (#60), so every generation
// runs in a throwaway temp dir with the mutating tools `--deny`d, is SIGKILLed on
// timeout, and its output clip is located from Grok's own ~/.grok session layout
// (with a salvage scan when a timeout robs us of the stdout sessionId). Read is NOT
// denied so it can load a staged base still. All of that stays here, this backend
// only. Never throws.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CampaignSettings } from "../campaign-store.js";
import { sanitizeImagePrompt, mergeCharacterAppearance } from "../image-generator.js";
import { aspectPhrase, type VideoConfig } from "../video-store.js";
import type { VideoBackend, VideoBackendArgs, VideoGenResult } from "./types.js";
import { disableInheritedServers, grokGenerationArgs, grokLockdownEnv } from "../grok-lockdown.js";

const execFileAsync = promisify(execFile);
export type GrokVideoExec = typeof execFileAsync;

/** Video generation is markedly slower than a still (#118: up to ~15s clips).
 * Generous headroom over the 180s image ceiling; a timeout no longer discards a
 * finished clip — the salvage scan harvests whatever Grok wrote before the kill. */
const GROK_VIDEO_TIMEOUT_MS = 420_000;

/** A copied-in video below this many bytes is treated as a truncated/partial
 * write (e.g. Grok killed mid-write on timeout) and not used. */
const MIN_VIDEO_BYTES = 4096;

/** File extensions Grok Imagine may emit for a clip (undocumented; observed). */
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov"]);

/** Grok may write clips under either a `videos/` or the same `images/` session
 * subdir it uses for stills — scan both (undocumented, confirmed by observation). */
const VIDEO_SESSION_SUBDIRS = ["videos", "images"];

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return slug || "entity";
}

/** Turns a scene/entity description + resolved params into the `/imagine-video`
 * prompt. Reuses the image pipeline for the styled, sanitized, length-capped
 * description, then appends a prompt-driven parameter clause and, when animating an
 * existing still, prepends the base image's filename (Option B in the #118 notes).
 * Exported for unit testing without a live Grok, and re-exported by video-generator. */
export function buildVideoPrompt(
  description: string,
  settings: CampaignSettings,
  video: VideoConfig,
  baseImageFilename?: string
): string {
  const styled = sanitizeImagePrompt(description, settings);
  const params = `${video.durationSeconds} second video, ${video.resolution} resolution, ${aspectPhrase(
    video.aspectRatio
  )}`;
  const body = `${styled}, ${params}`;
  return baseImageFilename ? `${baseImageFilename} ${body}` : body;
}

/** Grok Build records the generated file's path in the per-session
 * chat_history.jsonl under ~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/,
 * as a tool_result whose JSON content has a "path" field (same layout the image
 * generator relies on). Keep only paths with a video extension — an /imagine-video
 * call may also leave an intermediate still. Last match wins. */
function findGeneratedVideoPath(workDir: string, sessionId: string): string | undefined {
  const chatHistoryPath = path.join(
    os.homedir(),
    ".grok",
    "sessions",
    encodeURIComponent(workDir),
    sessionId,
    "chat_history.jsonl"
  );
  if (!fs.existsSync(chatHistoryPath)) return undefined;

  let found: string | undefined;
  for (const line of fs.readFileSync(chatHistoryPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof entry !== "object" ||
      entry === null ||
      (entry as { type?: unknown }).type !== "tool_result" ||
      typeof (entry as { content?: unknown }).content !== "string"
    ) {
      continue;
    }
    try {
      const parsed = JSON.parse((entry as { content: string }).content);
      if (
        typeof parsed.path === "string" &&
        VIDEO_EXTS.has(path.extname(parsed.path).toLowerCase()) &&
        fs.existsSync(parsed.path)
      ) {
        found = parsed.path;
      }
    } catch {
      continue;
    }
  }
  return found;
}

/** Timeout/fallback salvage (mirrors the image path): the newest video file
 * written at/after `sinceMs` under any of this cwd's session subdirs, or undefined.
 * Split out and exported so the salvage logic is unit-testable without a real
 * ~/.grok tree. Re-exported by video-generator.ts for import-path stability. */
export function newestVideoUnder(sessionsBase: string, sinceMs: number): string | undefined {
  if (!fs.existsSync(sessionsBase)) return undefined;
  let best: string | undefined;
  let bestMtime = -1;
  for (const sessionId of fs.readdirSync(sessionsBase)) {
    for (const sub of VIDEO_SESSION_SUBDIRS) {
      const dir = path.join(sessionsBase, sessionId, sub);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!VIDEO_EXTS.has(path.extname(name).toLowerCase())) continue;
        const full = path.join(dir, name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.mtimeMs + 1000 < sinceMs) continue;
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          best = full;
        }
      }
    }
  }
  return best;
}

function findLatestGeneratedVideo(workDir: string, sinceMs: number): string | undefined {
  const base = path.join(os.homedir(), ".grok", "sessions", encodeURIComponent(workDir));
  return newestVideoUnder(base, sinceMs);
}

/** Shells out to `grok -p "/imagine-video ..."` headlessly and copies the
 * resulting clip into this campaign's own videos/ directory. A direct analog of
 * the grok image backend (same isolated-temp-dir + `--deny` safety model from #60,
 * same never-throw contract). `execFn` is injectable so tests drive it with a stub. */
export async function generateGrokVideo(
  args: VideoBackendArgs,
  execFn: GrokVideoExec = execFileAsync
): Promise<VideoGenResult> {
  const { campaignDir, entityType, name, description, settings, video } = args;
  const effectiveDescription =
    entityType === "character" ? mergeCharacterAppearance(campaignDir, description) : description;
  const slug = slugify(name);

  // Isolated, empty, non-repo working directory (#60): Grok is keyed to this cwd
  // for both its tool sandbox and where it records the session/clip.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-vid-"));
  const startedAt = Date.now();
  try {
    // Two-step workflow: stage the existing still inside workDir so the prompt can
    // reference it by a plain filename (cwd IS workDir; Read is not denied).
    let baseImageFilename: string | undefined;
    if (args.baseImageRelPath) {
      const srcPath = path.join(campaignDir, args.baseImageRelPath);
      if (fs.existsSync(srcPath)) {
        baseImageFilename = `base${path.extname(srcPath) || ".jpg"}`;
        try {
          fs.copyFileSync(srcPath, path.join(workDir, baseImageFilename));
        } catch {
          baseImageFilename = undefined;
        }
      }
    }

    const prompt = buildVideoPrompt(effectiveDescription, settings, video, baseImageFilename);

    await disableInheritedServers(workDir);
    let stdout: string | undefined;
    let timedOut = false;
    try {
      const result = await execFn(
        "grok",
        [
          "--cwd",
          workDir,
          "-p",
          `/imagine-video ${prompt}`,
          "--output-format",
          "json",
          "--no-plan",
          "--no-subagents",
          "--disable-web-search",
          // ADR-0042: the scene description is untrusted (the DM model writes it from
          // player text), and grok is a coding agent — so remove its other tools, refuse
          // anything not allowed, and give it none of the host's own config. `read_file`
          // stays for the staged base image.
          ...grokGenerationArgs(workDir, true),
        ],
        { timeout: GROK_VIDEO_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 10 * 1024 * 1024, env: grokLockdownEnv() }
      );
      stdout = result.stdout;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
      if (e.code === "ENOENT") {
        console.error(`[video-generator] grok CLI not found on PATH for "${name}"`);
        return { ok: false, error: "Grok Build invocation failed: grok CLI not found on PATH" };
      }
      if (e.killed) {
        timedOut = true;
        console.error(
          `[video-generator] grok timed out after ${GROK_VIDEO_TIMEOUT_MS}ms for "${name}" — attempting to salvage`
        );
      } else {
        const reason = e.stderr?.trim() || e.message || String(err);
        console.error(`[video-generator] grok invocation failed for "${name}": ${reason}`);
        return { ok: false, error: `Grok Build invocation failed: ${reason}` };
      }
    }

    let sourcePath: string | undefined;
    if (stdout) {
      try {
        const parsed = JSON.parse(stdout);
        if (typeof parsed.sessionId === "string") {
          sourcePath = findGeneratedVideoPath(workDir, parsed.sessionId);
        }
      } catch {
        // Unparseable stdout just means we lean on the salvage scan below.
      }
    }
    if (!sourcePath) {
      sourcePath = findLatestGeneratedVideo(workDir, startedAt);
    }
    if (!sourcePath) {
      console.error(`[video-generator] no video file located for "${name}"${timedOut ? " (timed out)" : ""}`);
      return {
        ok: false,
        error: timedOut
          ? `Grok Build timed out after ${GROK_VIDEO_TIMEOUT_MS}ms and produced no video`
          : "Grok Build did not produce a locatable video file",
      };
    }

    const ext = path.extname(sourcePath) || ".mp4";
    const videosDir = path.join(campaignDir, "videos");
    const filename = `${entityType}-${slug}${ext}`;
    const destPath = path.join(videosDir, filename);
    try {
      fs.mkdirSync(videosDir, { recursive: true });
      fs.copyFileSync(sourcePath, destPath);
      if (fs.statSync(destPath).size < MIN_VIDEO_BYTES) {
        fs.rmSync(destPath, { force: true });
        return { ok: false, error: "Grok Build produced an incomplete video file" };
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[video-generator] failed to save video for "${name}": ${reason}`);
      return { ok: false, error: `Failed to save generated video: ${reason}` };
    }

    return { ok: true, relPath: path.join("videos", filename) };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export const grokVideoBackend: VideoBackend = {
  provider: "grok",
  generate: (args) => generateGrokVideo(args),
};
