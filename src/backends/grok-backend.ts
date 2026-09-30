import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import type { DmBackend, RunTurnArgs } from "../dm-backend.js";
import { systemPrompt, GROK_TOOL_NAMES, SRD_DIR, type TurnResult } from "../dm-engine.js";
import {
  GROK_DISALLOWED_TOOLS,
  GROK_DM_FILE_TOOLS,
  GROK_MCP_GATEWAY_TOOLS,
  dmPermissionRules,
  grokLockdownEnv,
  listInheritedMcpServers,
  lockdownConfigToml,
} from "../grok-lockdown.js";
import { readCharacterIdentity, type CampaignSettings } from "../campaign-store.js";
import { stripMetaChatter } from "../narration.js";

const execFileAsync = promisify(execFile);

/** The single grok invocation, narrowed to what this backend passes and reads.
 * Injectable so the retry logic can be unit-tested without spawning `grok`. */
export type GrokExec = (
  file: "grok",
  args: string[],
  options: { timeout: number; killSignal: NodeJS.Signals; maxBuffer: number; env?: NodeJS.ProcessEnv }
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec = execFileAsync as unknown as GrokExec;

/** DM turns run a full agentic loop (read state, narrate, update several files),
 * which on grok-build measured ~2-2.5 min in the Slice 0 spike. Give generous
 * headroom; SIGKILL on overrun so a stuck turn can't hold the socket forever. */
const GROK_TURN_TIMEOUT_MS = 600_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // src/backends
const MCP_SERVERS_DIR = path.resolve(__dirname, "../mcp-servers");
// The tsx launcher by absolute path: it resolves the target file's imports
// relative to the FILE, so the MCP servers run correctly no matter what cwd
// grok spawns them in (campaignDir has no node_modules of its own).
const TSX_BIN = path.resolve(__dirname, "../../node_modules/.bin/tsx");

/** Write the per-turn `<campaignDir>/.grok/config.toml` declaring the stdio MCP
 * servers this campaign's settings enable (ADR-0018). Because cwd is campaignDir,
 * this is grok's highest-priority config. `.grok/` is gitignored, and each server
 * gets the campaign dir as its first CLI argument (ADR-0033 — runtime IPC via argv,
 * not env or file config) — so there's no cross-campaign bleed (ADR-0004). Only the
 * servers the settings turn on are declared, mirroring how the Claude path
 * conditionally wires dice/image per turn. */
async function writeGrokConfig(campaignDir: string, settings: CampaignSettings): Promise<void> {
  const grokDir = path.join(campaignDir, ".grok");
  fs.mkdirSync(grokDir, { recursive: true });

  const blocks: string[] = [];
  const ownServers: string[] = [];
  const addServer = (name: string, file: string): void => {
    ownServers.push(name);
    const serverPath = path.join(MCP_SERVERS_DIR, file);
    // campaignDir is a discrete args element (not string-concatenated) so paths
    // containing spaces stay a single argv entry.
    blocks.push(
      `[mcp_servers.${name}]\n` +
        `command = ${JSON.stringify(TSX_BIN)}\n` +
        `args = [${JSON.stringify(serverPath)}, ${JSON.stringify(campaignDir)}]\n`
    );
  };

  // Seed + texture are always available (like the Claude path). Dice and image
  // are gated on the same settings dm-engine gates its in-process tools on.
  addServer("seed-tables", "seed-server.ts");
  addServer("texture-tables", "texture-server.ts");
  if (settings.autoRollDice !== false) addServer("dice", "dice-server.ts");
  if (settings.generateImages) addServer("image-tools", "image-server.ts");

  // ADR-0042: grok would also start whatever tool servers the host user has set up
  // for Claude Code/Cursor; name each one `enabled = false`. `grok inspect` stops
  // listing a server this file already disables, so ask it against a config that
  // holds only our own servers — otherwise every second turn would forget the
  // disable and the server would start again.
  const configPath = path.join(grokDir, "config.toml");
  fs.writeFileSync(configPath, blocks.join("\n") + "\n");
  const inherited = await listInheritedMcpServers(campaignDir);
  blocks.push(lockdownConfigToml(inherited, ownServers));
  fs.writeFileSync(configPath, blocks.join("\n") + "\n");
}

/** The tools a DM turn may use: the file tools, plus this campaign's own MCP tools
 * (the same ones `writeGrokConfig` declares, gated on the same settings). */
function dmToolAllowlist(settings: CampaignSettings): string[] {
  const tools = [...GROK_DM_FILE_TOOLS, ...GROK_MCP_GATEWAY_TOOLS, GROK_TOOL_NAMES.seed, GROK_TOOL_NAMES.texture];
  if (settings.autoRollDice !== false) tools.push(GROK_TOOL_NAMES.dice);
  if (settings.generateImages) tools.push(GROK_TOOL_NAMES.image);
  return tools;
}

/** The outcome of a single grok invocation, classified so the caller can decide
 * whether a retry is warranted. `retryable` marks the intermittent
 * silent-turn/garbled-output case (issue #100) — as opposed to a terminal
 * spawn/timeout/non-zero failure, which retrying wouldn't help. */
interface GrokAttempt {
  text: string;
  sessionId: string | undefined;
  /** No usable narration came back (empty `.text` or unparseable output). */
  retryable: boolean;
  /** The exec itself failed (ENOENT/timeout/non-zero); not the same as a
   * successful-but-silent turn, and never retried. */
  terminal: boolean;
}

/** Run one headless grok turn and parse its single JSON blob
 * ({ text, stopReason, sessionId, ... }). `.text` is the clean narration; file
 * edits are disk side effects. Classifies the result but does not decide policy
 * — the caller owns retry/error handling. */
async function attemptGrokTurn(
  grokArgs: string[],
  campaignDir: string,
  model: string,
  fallbackSessionId: string | undefined,
  execFn: GrokExec
): Promise<GrokAttempt> {
  let stdout: string;
  try {
    const result = await execFn("grok", grokArgs, {
      timeout: GROK_TURN_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 20 * 1024 * 1024,
      env: grokLockdownEnv(),
    });
    stdout = result.stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    const reason =
      e.code === "ENOENT"
        ? "grok CLI not found on PATH"
        : e.killed
          ? `grok timed out after ${GROK_TURN_TIMEOUT_MS}ms`
          : e.stderr?.trim() || e.message || String(err);
    console.error(`[grok-backend] turn failed for ${campaignDir}: ${reason}`);
    return {
      text: `[DM engine error: ${reason}]`,
      // Keep the resume id on failure so the next attempt can continue the session.
      sessionId: fallbackSessionId,
      retryable: false,
      terminal: true,
    };
  }

  let sessionId = fallbackSessionId;
  try {
    const parsed = JSON.parse(stdout) as { text?: unknown; sessionId?: unknown; stopReason?: unknown };
    const text = typeof parsed.text === "string" ? parsed.text : "";
    if (typeof parsed.sessionId === "string" && parsed.sessionId) {
      sessionId = parsed.sessionId;
    }
    if (!text.trim()) {
      return {
        text: `[DM engine error: grok returned no narration (stopReason=${String(parsed.stopReason)})]`,
        sessionId,
        retryable: true,
        terminal: false,
      };
    }
    return { text, sessionId, retryable: false, terminal: false };
  } catch {
    return {
      text: `[DM engine error: could not parse grok output]\n${stdout.slice(0, 500)}`,
      sessionId,
      retryable: true,
      terminal: false,
    };
  }
}

/** Grok's headless flags, finalized in the Slice 0 spike (see ADR-0018) and
 * locked down in ADR-0042: --system-prompt-override carries the full DM prompt (no
 * 10K cap); --tools/--disallowed-tools/--permission-mode dontAsk/--allow confine it
 * to the campaign's files (+ read-only SRD) and Chronicle's own MCP tools, with no
 * shell and none of the host's Claude Code/Cursor config. No --effort (both grok
 * models reject it).
 *
 * `execFn` is injectable for testing; production uses the real `grok` CLI. */
export async function runGrokTurn(args: RunTurnArgs, execFn: GrokExec = defaultExec): Promise<TurnResult> {
  const { campaignDir, sessionLogPath, userInput, resumeSessionId, model, settings } = args;
  const character = readCharacterIdentity(campaignDir);
  const sysPrompt = systemPrompt(campaignDir, sessionLogPath, settings, character, GROK_TOOL_NAMES);

  await writeGrokConfig(campaignDir, settings);
  const tools = dmToolAllowlist(settings);
  // MCP tools are named in the allowlist, and `dontAsk` refuses anything not allowed,
  // so each is allowed by name too; file tools are allowed only inside the campaign
  // (and the SRD, read-only).
  const rules = dmPermissionRules(campaignDir, SRD_DIR);
  const allowRules = [...rules.allow, ...tools.filter((t) => t.includes("__"))];

  // Reuse the persisted session on resume; otherwise mint a UUID grok will
  // create the session under, and hand it back so the server persists it.
  const newSessionId = randomUUID();
  const buildArgs = (input: string, resume: string | undefined): string[] => {
    const a = [
      "-p", input,
      "--cwd", campaignDir,
      "-m", model,
      "--output-format", "json",
      "--system-prompt-override", sysPrompt,
      // ADR-0042: an allowlist, the same tools removed by name, and refuse-by-default
      // permissions with path-scoped allow rules. Not `--sandbox` (never applies
      // headless) and not `--always-approve` (approved a write outside the campaign).
      "--tools", tools.join(","),
      "--disallowed-tools", GROK_DISALLOWED_TOOLS,
      "--permission-mode", "dontAsk",
      ...allowRules.flatMap((rule) => ["--allow", rule]),
      ...rules.deny.flatMap((rule) => ["--deny", rule]),
      "--no-plan",
      "--no-subagents",
      "--disable-web-search",
      "--no-memory",
    ];
    if (resume) a.push("--resume", resume);
    else a.push("--session-id", newSessionId);
    return a;
  };

  let attempt = await attemptGrokTurn(
    buildArgs(userInput, resumeSessionId),
    campaignDir,
    model,
    resumeSessionId ?? newSessionId,
    execFn
  );

  // Issue #100: grok-build (and, less often, composer) intermittently completes
  // a DM turn through tool/file edits alone — reading state, generating images —
  // and ends with no narration in `.text`, which would strand the campaign at 0
  // turns. Retry ONCE, resuming the session this attempt just created so it
  // continues the same context, with a nudge that forces the scene into the
  // reply text. Terminal exec failures are not retried.
  if (attempt.retryable) {
    console.error(`[grok-backend] no narration for ${campaignDir}; retrying once with a prose-forcing nudge`);
    const nudge =
      `${userInput}\n\n(Write the scene now as narrated prose in your reply text. ` +
      `Do not answer only through tool calls or file edits.)`;
    const retry = await attemptGrokTurn(
      buildArgs(nudge, attempt.sessionId),
      campaignDir,
      model,
      attempt.sessionId ?? newSessionId,
      execFn
    );
    console.error(
      `[grok-backend] retry for ${campaignDir} ${retry.retryable || retry.terminal ? "still produced no narration" : "succeeded"}`
    );
    attempt = retry;
  }

  const isError = attempt.retryable || attempt.terminal;
  const cleaned = isError
    ? attempt.text
    : stripMetaChatter(attempt.text, { autoRoll: settings.autoRollDice !== false });

  // Grok's JSON carries no per-message model echo like Claude's, so requested
  // and actual collapse (ADR-0018).
  return { text: cleaned, sessionId: attempt.sessionId, isError, model, requestedModel: model };
}

export const grokBackend: DmBackend = {
  provider: "grok",
  runTurn(args: RunTurnArgs): Promise<TurnResult> {
    return runGrokTurn(args);
  },
};
