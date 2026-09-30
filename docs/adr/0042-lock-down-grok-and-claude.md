# ADR-0042: Lock down what Grok and Claude can do on the host

## Status

Accepted. Implemented in `src/grok-lockdown.ts` and the three Grok call sites, plus a
smaller change to the Claude call in `src/dm-engine.ts`.

## Context

Grok Build is a coding agent, and Chronicle runs it headless in three places: the DM
turn (ADR-0018), image generation (ADR-0027) and video (ADR-0034). skyrim-author ran
into the same CLI and measured three ways it acts on the machine even after you
"block" it. We checked Chronicle against each one, on grok 0.2.93, using scratch
campaigns and canary files.

What Chronicle's calls could do before this change:

- **Run a shell command.** The DM call removed `run_terminal_cmd`. Grok used its
  `monitor` tool instead, and the command ran (`echo SHELL-RAN > <canary>` produced
  the file). The image call did the same when its scene description said to.
- **Write outside the campaign.** The DM call used `--sandbox workspace`. That sandbox
  never applies without a terminal, so it confined nothing: a file was written
  outside the campaign folder with the `write` tool.
- **Start the host's tool servers.** Grok adopts the MCP servers in `~/.claude.json`.
  A server planted there started during a DM turn. Switching the compatibility cells
  off (`GROK_CLAUDE_MCPS_ENABLED=false` and friends) only hides its tools; the
  process still starts.
- **Inherit the host's permission rules.** Grok loaded 278 allow rules from
  `~/.claude/settings.json`, including `Read(//home/kb/**)`. The env switches do not
  turn these off.

The scene description that reaches `/imagine` is written by the DM model from player
text, so an image or video call is reachable by prompt injection. It is untrusted.

The Claude call was already stronger: `disallowedTools: ["Bash"]`, `dontAsk`, and a
PreToolUse hook (`decidePermission`) that denies anything not on a short list. We
attacked it the same way (shell, write outside, "any other tool"): every attempt was
denied and no canary appeared. So Claude could not act on the host before this
change. It was still offered `Agent`, `Workflow`, `Cron*`, `RemoteTrigger` and
`WebFetch`, was wiring in the user's claude.ai connectors (Gmail, Drive, Vercel),
and read the user's own settings, with the hook as the only barrier.

## Decision

**Grok, DM turn.** Name what it may use, refuse the rest, and scope writes by path:

- `--tools` allowlist: `read_file, search_replace, write, list_dir, grep`, the
  `search_tool`/`use_tool` gateway, and this campaign's own MCP tools.
- `--disallowed-tools` lists every other tool seen, by name (defense in depth).
- `--permission-mode dontAsk` instead of `--always-approve`, with `--allow` rules for
  writes and edits inside the campaign only, and reads of the campaign and SRD.
- No `--sandbox`. It looked like safety and wasn't.
- `--no-memory`.

`search_tool` and `use_tool` stay allowed. Grok reaches every MCP tool (dice, seed,
texture, image) through them. The first version of this change removed them and the
model reported "no callable dice tool"; a positive control caught it.

**Grok, image and video.** No `--tools` allowlist here: naming `image_gen` hides
grok's own image tool and nothing is generated. Instead the file, shell, scheduling
and search tools are removed by name and `dontAsk` refuses anything not allowed.
Video keeps `read_file` for its staged base image.

**Grok, all three.** `execFile` gets `grokLockdownEnv()`:

- `HOME` is an empty directory (`$TMPDIR/chronicle-grok-home`). This is what removes
  the inherited permission rules, skills and servers. `GROK_HOME` is pinned to the
  real folder (or the host's own `GROK_HOME`), so the sign-in still works.
- The ten `GROK_{CLAUDE,CURSOR}_{MCPS,HOOKS,SKILLS,AGENTS,RULES}_ENABLED=false`.
- Any server still discovered (a repo `.mcp.json`, say) is written into the call's
  `.grok/config.toml` as `enabled = false` with a `command`. Both fields are needed
  (measured). `grok inspect --json` is asked against a config holding only
  Chronicle's own servers, because it stops listing a server this file already
  disables and the next turn would otherwise forget it.
- A project config's `[compat.*]` section is ignored by grok, so it isn't written.

This is the one place Chronicle touches `process.env`. ADR-0033 is about
configuration; this is a pass-through to a child process, where `execFile`'s `env`
replaces the environment and `PATH` has to be carried over. Settings still come only
from `config.json`.

**Claude.** Add to the SDK options: `tools: ["Read","Write","Edit","Glob"]`,
`strictMcpConfig: true`, and `settingSources: ["project"]`. The DM's context is
unchanged (the project's own settings and CLAUDE.md still load); what goes is the
host user's personal allow-list and hooks, the connectors, and the tools the DM
never uses. The PreToolUse gate stays as the boundary.

## What we measured after

Same attacks, same canaries, real `runGrokTurn`/`generateGrokImage`/`generateGrokVideo`
and `runTurn`:

- Shell, outside write and the planted server: none happened, across three
  back-to-back DM turns on one campaign.
- A write inside the campaign, a dice roll and reads of the state files: all worked.
- A normal image generated; the injected image description produced no canary.
- A normal Claude turn read the state files and SRD, edited both, and rolled dice.

## Consequences

- **Reads are only partly confined on Grok.** Reads are allowed by default under
  `dontAsk`, and a deny beats an allow, so reads can't be limited to the campaign
  and SRD (the campaign lives under the same home directory as what we protect). We
  deny the places that hold sign-in and secrets (grok's folder, `~/.ssh`,
  `~/.claude`, `~/.config`, Chronicle's `config.json` and `secrets.json`, `/etc`,
  `/tmp`), and we did not test that every one of those denies bites. A DM turn can
  still read other files under the home directory. The Claude path has no such gap.
- The rules use grok's single-slash absolute spelling; the `//` Claude Code form has
  no effect there.
- Every DM turn now runs `grok inspect --json` first (about 0.2 s).
- The allowlist and disallow list name tools by the names grok 0.2.93 uses. A grok
  release that renames a tool needs the lists revisited; `dontAsk` still refuses
  writes and shell in the meantime.
- Unrelated, found on the way: grok 0.2.93 rejects Chronicle's built-in Grok model
  ids (`grok-build`, `grok-composer-2.5-fast`) with "unknown model id". It currently
  offers `grok-4.7`, `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`. Not changed here.
