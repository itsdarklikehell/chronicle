import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGrokTurn, type GrokExec } from "../src/backends/grok-backend.js";
import type { RunTurnArgs } from "../src/dm-backend.js";
import type { CampaignSettings } from "../src/campaign-store.js";
import {
  GROK_DISALLOWED_TOOLS,
  GROK_MCP_GATEWAY_TOOLS,
  dmPermissionRules,
  grokGenerationArgs,
  grokLockdownEnv,
  lockdownConfigToml,
} from "../src/grok-lockdown.js";

// ADR-0042: every headless grok call is locked down. These pin the pieces that were
// measured to matter, so a refactor can't quietly reopen the shell, the outside write
// or the host's own tool servers.

const flagValues = (args: string[], flag: string): string[] =>
  args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

test("env: stand-in HOME, sign-in folder kept, every Claude/Cursor cell off, PATH carried", () => {
  const env = grokLockdownEnv({ HOME: "/home/someone", PATH: "/usr/bin" });
  assert.notEqual(env.HOME, "/home/someone");
  // grok keeps its own bundled assets here; what matters is that none of Claude Code's or Cursor's is.
  for (const theirs of [".claude", ".claude.json", ".cursor"]) assert.ok(!fs.existsSync(path.join(env.HOME!, theirs)));
  assert.equal(env.GROK_HOME, "/home/someone/.grok");
  assert.equal(env.PATH, "/usr/bin");
  for (const vendor of ["CLAUDE", "CURSOR"]) {
    for (const surface of ["MCPS", "HOOKS", "SKILLS", "AGENTS", "RULES"]) {
      assert.equal(env[`GROK_${vendor}_${surface}_ENABLED`], "false");
    }
  }
});

test("env: a GROK_HOME the host already set is honoured", () => {
  assert.equal(grokLockdownEnv({ HOME: "/h", GROK_HOME: "/elsewhere/grok" }).GROK_HOME, "/elsewhere/grok");
});

test("tools removed by name include the shell that ran commands, not only run_terminal_cmd", () => {
  const removed = GROK_DISALLOWED_TOOLS.split(",");
  for (const tool of ["run_terminal_cmd", "monitor", "spawn_subagent", "scheduler_create", "x_keyword_search"]) {
    assert.ok(removed.includes(tool), `${tool} should be removed`);
  }
  // The DM's own MCP tools are reached through these two; removing them silently disables dice/images.
  for (const tool of GROK_MCP_GATEWAY_TOOLS) assert.ok(!removed.includes(tool));
});

test("permission rules: write only inside the campaign, SRD read-only, sensitive reads denied", () => {
  const rules = dmPermissionRules("/data/campaigns/kris/c1", "/app/reference/srd", "/home/kris");
  assert.ok(rules.allow.includes("Write(/data/campaigns/kris/c1/**)"));
  assert.ok(rules.allow.includes("Edit(/data/campaigns/kris/c1/**)"));
  assert.ok(rules.allow.includes("Read(/app/reference/srd/**)"));
  assert.ok(!rules.allow.some((r) => r.startsWith("Write(/app")), "SRD is read-only");
  assert.ok(rules.deny.includes("Read(/home/kris/.ssh/**)"));
  assert.ok(rules.deny.includes("Read(/home/kris/.claude/**)"));
  assert.ok(rules.deny.includes("Read(/etc/**)"));
  // Single leading slash: grok ignores the `//` spelling Claude Code uses.
  assert.ok(rules.deny.every((r) => !r.startsWith("Read(//")));
});

test("permission rules: never deny a root the campaign lives inside (a deny beats an allow)", () => {
  const rules = dmPermissionRules("/tmp/x/campaign", "/app/reference/srd", "/home/kris");
  assert.ok(!rules.deny.includes("Read(/tmp/**)"));
  assert.ok(rules.deny.includes("Read(/etc/**)"));
});

test("config toml: each inherited server named disabled with a command; ours left alone", () => {
  const toml = lockdownConfigToml(["runpod", "dice", "runpod"], ["dice"]);
  assert.equal(toml.match(/\[mcp_servers\./g)?.length, 1);
  assert.match(toml, /\[mcp_servers\."runpod"\]\nenabled = false\ncommand = "true"/);
  assert.equal(lockdownConfigToml([]), "");
});

test("generation args: no shell, no writes, refuse-by-default; read_file only when a still is staged", () => {
  const image = grokGenerationArgs("/tmp/chronicle-img-x");
  assert.deepEqual(flagValues(image, "--permission-mode"), ["dontAsk"]);
  assert.ok(!image.includes("--always-approve") && !image.includes("--sandbox") && !image.includes("--tools"));
  const removedImage = flagValues(image, "--disallowed-tools")[0].split(",");
  for (const tool of ["monitor", "run_terminal_cmd", "write", "search_replace", "read_file"]) {
    assert.ok(removedImage.includes(tool), `${tool} removed for an image call`);
  }
  assert.ok(!flagValues(grokGenerationArgs("/tmp/w", true), "--disallowed-tools")[0].split(",").includes("read_file"));
  // The call's own folder lives under /tmp, so /tmp must not be denied for it.
  assert.ok(!flagValues(image, "--deny").includes("Read(/tmp/**)"));
});

function tempCampaign(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-lockdown-"));
  fs.writeFileSync(path.join(dir, "character-sheet.json"), JSON.stringify({ name: "Kira", race: "Elf", class: "Ranger", level: 1 }));
  fs.writeFileSync(path.join(dir, "world-state.md"), "## Current Situation\n\nAt the inn.\n");
  fs.writeFileSync(path.join(dir, "npc-roster.md"), "# NPCs\n");
  fs.writeFileSync(path.join(dir, "quest-log.md"), "# Quests\n");
  fs.mkdirSync(path.join(dir, "session-log"));
  return dir;
}

test("DM turn: allowlist + dontAsk + path-scoped rules, no sandbox/always-approve, locked env", async () => {
  const dir = tempCampaign();
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const exec: GrokExec = async (_f, args, options) => {
    calls.push({ args: [...args], env: options.env });
    return { stdout: JSON.stringify({ text: "Narration.", sessionId: "s1", stopReason: "EndTurn" }), stderr: "" };
  };
  const args: RunTurnArgs = {
    campaignDir: dir,
    sessionLogPath: path.join(dir, "session-log", "s.md"),
    userInput: "Begin.",
    resumeSessionId: undefined,
    model: "grok-4.7",
    settings: { provider: "grok", model: "grok-4.7", autoRollDice: true, generateImages: true } as CampaignSettings,
    onText: () => {},
  };
  await runGrokTurn(args, exec);
  const { args: argv, env } = calls[0];
  assert.ok(!argv.includes("--sandbox") && !argv.includes("--always-approve"));
  assert.deepEqual(flagValues(argv, "--permission-mode"), ["dontAsk"]);
  const tools = flagValues(argv, "--tools")[0].split(",");
  for (const t of ["read_file", "search_replace", "search_tool", "use_tool", "dice__roll_dice", "image-tools__generate_image"]) {
    assert.ok(tools.includes(t), `${t} allowed`);
  }
  for (const banned of ["monitor", "run_terminal_cmd", "spawn_subagent"]) assert.ok(!tools.includes(banned));
  assert.ok(flagValues(argv, "--disallowed-tools")[0].split(",").includes("monitor"));
  assert.ok(flagValues(argv, "--allow").includes(`Write(${dir}/**)`));
  assert.ok(flagValues(argv, "--deny").includes("Read(/etc/**)"));
  assert.equal(env?.GROK_CLAUDE_MCPS_ENABLED, "false");
  assert.notEqual(env?.HOME, os.homedir());
  const config = fs.readFileSync(path.join(dir, ".grok", "config.toml"), "utf8");
  assert.match(config, /\[mcp_servers\.dice\]/);
  fs.rmSync(dir, { recursive: true, force: true });
});
