// ADR-0027: the "grok" ImageBackend — a verbatim lift of the original
// generateImage logic and its whole safety cage. Grok Build is a full agentic
// *coding* assistant, not a bare image endpoint (issue #60), so every generation
// runs in a throwaway temp dir with the mutating tools `--deny`d, is SIGKILLed on
// timeout, and its output image is located from Grok's own ~/.grok session layout
// (with a salvage scan when a timeout robs us of the stdout sessionId). All of
// that exists to cage Grok and stays here, for this backend only. Never throws.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sanitizeImagePrompt, saveGeneratedImage } from "../image-generator.js";
import type { ImageBackend, ImageBackendArgs, ImageGenResult } from "./types.js";
import { disableInheritedServers, grokGenerationArgs, grokLockdownEnv } from "../grok-lockdown.js";

const execFileAsync = promisify(execFile);
export type GrokExec = typeof execFileAsync;

/** Generous but bounded. Early testing saw ~4-6s, but real generations under
 * load exceed the old 90s ceiling (issue #52), so this is raised — and, more
 * importantly, a timeout no longer discards a finished image: the salvage step
 * below harvests whatever Grok actually wrote before it was killed. */
const GROK_TIMEOUT_MS = 180_000;

/** Grok Build doesn't print the generated file's path to stdout — it only
 * appears in the per-session chat_history.jsonl it writes under
 * ~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/, as a GenerateImage
 * tool_result whose JSON content has a "path" field. Confirmed empirically
 * (see Slice 9 validation) rather than documented anywhere, so this is the
 * one place that assumption lives if Grok Build's session layout changes. */
function findGeneratedImagePath(campaignDir: string, sessionId: string): string | undefined {
  const chatHistoryPath = path.join(
    os.homedir(),
    ".grok",
    "sessions",
    encodeURIComponent(campaignDir),
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
      if (typeof parsed.path === "string" && fs.existsSync(parsed.path)) {
        // Last match wins — if this call somehow triggered more than one
        // image, keep the most recent.
        found = parsed.path;
      }
    } catch {
      continue;
    }
  }
  return found;
}

/** Timeout/fallback salvage (issue #52): Grok Build writes each generated image
 * under ~/.grok/sessions/<encodeURIComponent(cwd)>/<sessionId>/images/, and on
 * a timeout we no longer have the stdout sessionId — but the file may already
 * exist. Scan every session dir for this campaign's cwd and return the newest
 * image file written at/after `sinceMs` (this invocation), so a run that
 * finished just after we killed it still yields its image instead of a hard
 * failure. The `sinceMs` floor keeps us from resurrecting a stale image from an
 * earlier call. */
function findLatestGeneratedImage(campaignDir: string, sinceMs: number): string | undefined {
  const base = path.join(os.homedir(), ".grok", "sessions", encodeURIComponent(campaignDir));
  return newestImageUnder(base, sinceMs);
}

/** Newest image file under `<sessionsBase>/<sessionId>/images/`, written at or
 * after `sinceMs`, or undefined if none. Split out (and exported) so the
 * salvage logic is unit-testable without a real ~/.grok tree. Re-exported from
 * image-generator.ts so tests/image-salvage.test.ts keeps its import path. */
export function newestImageUnder(sessionsBase: string, sinceMs: number): string | undefined {
  if (!fs.existsSync(sessionsBase)) return undefined;
  let best: string | undefined;
  let bestMtime = -1;
  for (const sessionId of fs.readdirSync(sessionsBase)) {
    const imagesDir = path.join(sessionsBase, sessionId, "images");
    if (!fs.existsSync(imagesDir)) continue;
    for (const name of fs.readdirSync(imagesDir)) {
      const full = path.join(imagesDir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      // 1s slack for coarse filesystem mtime resolution vs. Date.now().
      if (!stat.isFile() || stat.mtimeMs + 1000 < sinceMs) continue;
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        best = full;
      }
    }
  }
  return best;
}

/** Shells out to `grok -p "/imagine ..."` headlessly (design doc §2.2), locates
 * the resulting image file, and copies it into this campaign's own images/ dir.
 * Never throws — every failure mode (Grok Build not installed/authenticated,
 * timeout, unparseable output, no locatable image file) is caught and returned
 * as a clear failure result, since an image is best-effort per §8 and must never
 * block a turn from completing.
 *
 * Issue #60 (the real fix): Grok Build is a full agentic *coding* assistant, not
 * a bare image endpoint. Run before with `--cwd <campaignDir>` — which lives
 * INSIDE this git repo — it would read a stray prompt (e.g. leaked DM planning
 * chatter like "let me read the campaign files") as a coding task, explore src/,
 * edit files, and even `git commit`/`git push` to master on its own (that is how
 * rogue commit 0982eb6 landed). The prompt was also polluted with that same
 * meta-chatter instead of a scene description. So we now:
 *   1. run Grok in a throwaway temp dir with NO repo to touch (isolation is the
 *      real safety boundary — Grok can't wreck a repo that isn't there);
 *   2. `--deny` the mutating tools as defense-in-depth;
 *   3. strip meta-chatter from the description so the prompt is a scene, not an
 *      instruction — which also cuts latency (issue #58): a clean prompt in an
 *      empty dir generates in ~15-20s vs. minutes spent "exploring" the repo.
 * Do NOT restore `--cwd campaignDir`, and do NOT add `--effort` (it maps to
 * reasoningEffort, which grok-composer-2.5-fast rejects with a 400).
 *
 * `execFn` is injectable (default = real execFile) so tests drive it with a stub
 * and no subprocess, mirroring runGrokTurn(args, execFn) in src/backends/. */
export async function generateGrokImage(
  args: ImageBackendArgs,
  execFn: GrokExec = execFileAsync
): Promise<ImageGenResult> {
  const { campaignDir, entityType, name, description, settings } = args;
  let prompt = sanitizeImagePrompt(description, settings);
  // #154: grok's /imagine has no separate negative field, so fold the user's
  // "things to avoid" into the prose. Appended AFTER sanitizeImagePrompt's char cap
  // — like the LoRA trigger on the local backend — so it only lengthens the prompt
  // and never displaces the scene-grounding budget (ADR-0031). Seed/model overrides
  // are local-only and have no grok analog, so they're ignored here.
  if (settings.negativePrompt?.trim()) {
    prompt = `${prompt} Avoid: ${settings.negativePrompt.trim()}.`;
  }
  // ADR-0038: a full-prompt override from the editor replaces the prose grok renders.
  if (args.promptOverride?.trim()) {
    prompt = args.promptOverride.trim();
  }
  // ADR-0038: preview — return the prompt WITHOUT shelling out to grok (no render, no
  // file). Keeps the preview contract uniform across backends so a preview request can
  // never accidentally trigger a real grok generation.
  if (args.preview) {
    return { ok: true, previewPrompt: prompt };
  }

  // Isolated, empty, non-repo working directory: Grok is keyed to this cwd for
  // both its tool sandbox and where it records the session/image, so locating
  // the result below uses `workDir`, not `campaignDir`.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-img-"));
  // Marks which images belong to THIS call for the timeout-salvage path below.
  const startedAt = Date.now();
  try {
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
          `/imagine ${prompt}`,
          "--output-format",
          "json",
          // Trim the agentic scaffolding a one-shot image call doesn't need.
          "--no-plan",
          "--no-subagents",
          "--disable-web-search",
          // ADR-0042: the scene description is untrusted (the DM model writes it from
          // player text), and grok is a coding agent — so remove its other tools, refuse
          // anything not allowed, and give it none of the host's own config.
          ...grokGenerationArgs(workDir),
        ],
        { timeout: GROK_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 10 * 1024 * 1024, env: grokLockdownEnv() }
      );
      stdout = result.stdout;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
      if (e.code === "ENOENT") {
        console.error(`[image-generator] grok CLI not found on PATH for "${name}"`);
        return { ok: false, error: "Grok Build invocation failed: grok CLI not found on PATH" };
      }
      // A timeout (killed) is NOT terminal: Grok may have already written the
      // image before we killed it (issue #52). Fall through to the salvage scan.
      if (e.killed) {
        timedOut = true;
        console.error(`[image-generator] grok timed out after ${GROK_TIMEOUT_MS}ms for "${name}" — attempting to salvage`);
      } else {
        const reason = e.stderr?.trim() || e.message || String(err);
        console.error(`[image-generator] grok invocation failed for "${name}": ${reason}`);
        return { ok: false, error: `Grok Build invocation failed: ${reason}` };
      }
    }

    // Preferred: the exact path Grok recorded in this session's chat history.
    // Fallback/salvage: the newest image file written during this call (works
    // even when we have no sessionId because Grok was killed on timeout). Both
    // are keyed to workDir, the cwd Grok actually ran under.
    let sourcePath: string | undefined;
    if (stdout) {
      try {
        const parsed = JSON.parse(stdout);
        if (typeof parsed.sessionId === "string") {
          sourcePath = findGeneratedImagePath(workDir, parsed.sessionId);
        }
      } catch {
        // Unparseable stdout just means we lean on the salvage scan below.
      }
    }
    if (!sourcePath) {
      sourcePath = findLatestGeneratedImage(workDir, startedAt);
    }
    if (!sourcePath) {
      console.error(`[image-generator] no image file located for "${name}"${timedOut ? " (timed out)" : ""}`);
      return {
        ok: false,
        error: timedOut
          ? `Grok Build timed out after ${GROK_TIMEOUT_MS}ms and produced no image`
          : "Grok Build did not produce a locatable image file",
      };
    }

    const ext = path.extname(sourcePath) || ".jpg";
    return saveGeneratedImage(campaignDir, entityType, name, sourcePath, ext);
  } finally {
    // Best-effort cleanup — the image is already copied into the campaign, and
    // Grok's own copy persists under ~/.grok/sessions, so removing the empty
    // cwd is safe and never affects the result.
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export const grokImageBackend: ImageBackend = {
  provider: "grok",
  generate: (args) => generateGrokImage(args),
};
