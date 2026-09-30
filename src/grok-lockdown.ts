import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ADR-0042: what every headless `grok` call Chronicle makes is allowed to do.
//
// Measured against grok 0.2.93 (see the ADR for the runs): Grok Build is a coding
// agent, and headless it acts on the host unless every one of these is closed —
//   * `--disallowed-tools run_terminal_cmd` left its `monitor` tool, which runs a
//     shell command, so a shell was one prompt away;
//   * `--sandbox workspace` never applies without a terminal, so it confined
//     nothing (a file was written outside the campaign folder through it);
//   * it adopts Claude Code's and Cursor's tool servers, hooks, skills, agents,
//     rules and permission allow-list from the host user's own config, and starts
//     the servers (turning their tools "off" only hid them).
// The fix is an allowlist of the tools a call needs, `dontAsk`, and path-scoped
// allow rules — the one thing that did confine writes — plus turning the inherited
// surfaces off in the environment and naming each inherited server disabled in a
// project `.grok/config.toml`.

const execFileAsync = promisify(execFile);

const VENDORS = ["claude", "cursor"] as const;
const SURFACES = ["mcps", "hooks", "skills", "agents", "rules"] as const;

/** An empty directory standing in for the host user's home while grok runs. Grok
 * reads Claude Code's permission allow-list (`~/.claude/settings.json` — on this
 * host it includes `Read(//home/kb/**)`), tool servers (`~/.claude.json`), skills
 * and agents from `$HOME`, and the `GROK_{CLAUDE,CURSOR}_*_ENABLED` switches do not
 * turn the permission rules off (measured: 278 rules still loaded). A `$HOME` with
 * none of that in it does. */
function emptyHome(): string {
  const dir = path.join(os.tmpdir(), "chronicle-grok-home");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** The environment for every headless grok call: an empty `$HOME`, grok's own
 * folder (its sign-in and sessions) kept where it was, and
 * `GROK_{CLAUDE,CURSOR}_{MCPS,HOOKS,SKILLS,AGENTS,RULES}_ENABLED=false`, grok's
 * switches for taking up another tool's config as its own.
 *
 * This is the one place Chronicle touches `process.env`, and it is a pass-through
 * to a child process (`execFile`'s `env` replaces the environment, so `PATH` and
 * the rest have to be carried across), not configuration — ADR-0033 is about
 * settings, which still come only from `config.json`. `GROK_HOME` is honoured if
 * the host already set one, so that moving `$HOME` never moves the sign-in. */
export function grokLockdownEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  env.GROK_HOME = base.GROK_HOME ?? path.join(base.HOME ?? os.homedir(), ".grok");
  env.HOME = emptyHome();
  for (const vendor of VENDORS) {
    for (const surface of SURFACES) {
      env[`GROK_${vendor.toUpperCase()}_${surface.toUpperCase()}_ENABLED`] = "false";
    }
  }
  return env;
}

/** Every built-in grok tool seen in a headless session, removed by name as well as
 * left off the allowlist, so a tool grok adds to an allowlist-shaped default
 * still has to be named to come back. Defense in depth, not the boundary. */
export const GROK_DISALLOWED_TOOLS = [
  "run_terminal_cmd",
  "monitor",
  "kill_command_or_subagent",
  "get_command_or_subagent_output",
  "kill_task",
  "get_task_output",
  "spawn_subagent",
  "task",
  "Agent",
  "scheduler_list",
  "scheduler_create",
  "scheduler_delete",
  "web_search",
  "web_fetch",
  "x_user_search",
  "x_semantic_search",
  "x_keyword_search",
  "x_thread_fetch",
  "memory_search",
  "memory_get",
  "lsp",
  "update_goal",
  "enter_plan_mode",
  "exit_plan_mode",
  "ask_user_question",
].join(",");

/** The file tools a DM turn needs: read the state files and SRD, edit them. `write`
 * and `search_replace` both create/replace files, so both are named. */
export const GROK_DM_FILE_TOOLS = ["read_file", "search_replace", "write", "list_dir", "grep"];

/** Grok reaches MCP tools (dice, seed, texture, image) by looking them up with
 * `search_tool` and calling them through `use_tool` — measured: with both removed,
 * the model reports "no callable dice tool". They only ever see the servers
 * Chronicle declares, because every inherited server is disabled. */
export const GROK_MCP_GATEWAY_TOOLS = ["search_tool", "use_tool"];

/** Where grok keeps its sign-in and sessions: `GROK_HOME` if the host set one. */
function grokHomeDir(base: NodeJS.ProcessEnv = process.env): string {
  return base.GROK_HOME ?? path.join(base.HOME ?? os.homedir(), ".grok");
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Places a DM turn must not read: what signs the host user in (grok's own folder,
 * `~/.claude`, ssh/gpg/cloud credentials), Chronicle's own `config.json` and
 * `secrets.json`, and system paths. Absolute paths with a single leading `/` — grok
 * ignores the `//` spelling Claude Code uses (measured). */
function sensitiveReadRoots(home: string): string[] {
  const dotDirs = [".ssh", ".gnupg", ".aws", ".config", ".claude", ".docker", ".kube"];
  return [
    grokHomeDir(),
    ...dotDirs.map((d) => path.join(home, d)),
    path.join(home, ".claude.json"),
    path.join(home, ".netrc"),
    path.join(home, ".npmrc"),
    path.join(REPO_ROOT, "config.json"),
    path.join(REPO_ROOT, "secrets.json"),
    "/etc",
    "/root",
    "/proc",
    "/tmp",
  ];
}

/** Permission rules for a DM turn, mirroring `decidePermission` on the Claude path.
 * With `--permission-mode dontAsk`, writes and edits are refused unless allowed, so
 * `allow` confines them to the campaign. Reads are allowed everywhere by default and
 * a deny beats an allow (measured), so they cannot be confined to the campaign and
 * SRD — the campaign lives under the same home directory as the things to protect —
 * only kept out of the places in `sensitiveReadRoots`. ADR-0042 records that gap. */
export function dmPermissionRules(
  campaignDir: string,
  srdDir: string,
  home: string = os.homedir()
): { allow: string[]; deny: string[] } {
  const campaign = path.resolve(campaignDir);
  const srd = path.resolve(srdDir);
  return {
    allow: [`Read(${campaign}/**)`, `Edit(${campaign}/**)`, `Write(${campaign}/**)`, `Read(${srd}/**)`],
    deny: sensitiveReadDenyRules([campaign, srd], home),
  };
}

/** `Read(...)` deny rules for `sensitiveReadRoots`, skipping any root that one of
 * `keepReachable` lives inside: a deny beats an allow, so denying `/tmp` would also
 * deny a working directory under it. */
export function sensitiveReadDenyRules(keepReachable: string[], home: string = os.homedir()): string[] {
  const inside = (parent: string, child: string): boolean => {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  };
  const kept = keepReachable.map((d) => path.resolve(d));
  return sensitiveReadRoots(home)
    .filter((root) => !kept.some((dir) => inside(root, dir)))
    .map((root) => `Read(${root}/**)`);
}

/** The flags for a one-shot `/imagine` or `/imagine-video` call. The scene
 * description that reaches these calls is written by the DM model from player text,
 * so it is untrusted input, and grok is a coding agent.
 *
 * No `--tools` allowlist here, unlike the DM turn: measured, naming `image_gen`
 * hides grok's own image tool ("isn't in my current tool list") and nothing is
 * generated. Instead every other tool seen is removed by name and `dontAsk` refuses
 * anything not allowed — with nothing allowed, a write or a shell is refused (the
 * DM-turn runs showed the same) while the image tool, which is not a file or shell
 * tool, still saves into the call's own folder. `readsStagedFile` keeps `read_file`
 * for a video's staged base image, with the sensitive paths denied. */
export function grokGenerationArgs(workDir: string, readsStagedFile = false): string[] {
  const removed = [GROK_DISALLOWED_TOOLS, ...GROK_MCP_GATEWAY_TOOLS, "search_replace", "write", "list_dir", "grep"];
  if (!readsStagedFile) removed.push("read_file");
  return [
    "--disallowed-tools", removed.join(","),
    "--permission-mode", "dontAsk",
    ...sensitiveReadDenyRules([workDir]).flatMap((rule) => ["--deny", rule]),
    "--no-memory",
  ];
}

/** The names of tool servers grok would start on its own from this cwd (the host's
 * `~/.claude.json`, a repo `.mcp.json`, a plugin…). `grok inspect --json` starts
 * nothing and answers in a fraction of a second. Empty when it can't be asked:
 * the environment switches and the allowlist still hold. */
export async function listInheritedMcpServers(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("grok", ["inspect", "--json"], {
      cwd,
      env: grokLockdownEnv(),
      timeout: 20_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const found = JSON.parse(stdout) as { mcpServers?: Array<{ name?: unknown }> };
    return (found.mcpServers ?? [])
      .map((s) => s.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  } catch {
    return [];
  }
}

/** The lines to add to the project `.grok/config.toml`: every inherited tool server
 * named `enabled = false`. Turning a compatibility cell off only hides a server's
 * tools; it is naming the server, with a `command` of its own, that stops it
 * starting (measured: `enabled = false` alone does not). `ownServerNames` are the
 * servers Chronicle declares for itself and are left alone. The compatibility cells
 * themselves are switched off in the environment (`grokLockdownEnv`), because a
 * project config's `[compat.*]` is ignored — grok reads only `[mcp_servers]`,
 * `[plugins]` and `[permission]` from it. */
export function lockdownConfigToml(inheritedServers: string[], ownServerNames: string[] = []): string {
  const out: string[] = [];
  const own = new Set(ownServerNames);
  for (const name of new Set(inheritedServers)) {
    if (own.has(name)) continue;
    out.push(`[mcp_servers.${JSON.stringify(name)}]`, "enabled = false", 'command = "true"', "");
  }
  return out.join("\n");
}

/** Writes `<dir>/.grok/config.toml` naming every tool server grok would start from
 * `dir` as disabled. For a one-shot call's own empty folder, which has no config of
 * ours to preserve (the DM backend declares servers of its own and does this inline). */
export async function disableInheritedServers(dir: string): Promise<void> {
  const toml = lockdownConfigToml(await listInheritedMcpServers(dir));
  if (!toml) return;
  fs.mkdirSync(path.join(dir, ".grok"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".grok", "config.toml"), toml);
}
