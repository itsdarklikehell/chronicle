import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createSeedMcpServer, SEED_TOOL_NAME } from "./seed-selector.js";
import { createTextureMcpServer, TEXTURE_TOOL_NAME } from "./texture-selector.js";
import { createImageMcpServer, GENERATE_IMAGE_TOOL_NAME } from "./image-generator.js";
import { createDiceMcpServer, DICE_TOOL_NAME } from "./dice.js";
import { stripMetaChatter } from "./narration.js";
import type { CampaignSettings, ResponseLength } from "./campaign-store.js";
import {
  readCharacterIdentity,
  type CharacterIdentity,
  DEFAULT_RESPONSE_LENGTH,
} from "./campaign-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Per ADR-0006: static SRD reference content lives outside any campaign's
 * own cwd (it's shared across all campaigns, not per-campaign state), so it
 * needs its own allowedTools grant — the campaign-scoped `Read(./**)` rule
 * from ADR-0002 wouldn't otherwise reach it. */
export const SRD_DIR = path.resolve(__dirname, "../reference/srd");

const STATE_FILES = [
  "character-sheet.json",
  "world-state.md",
  "npc-roster.md",
  "quest-log.md",
];

/** A pure allow/deny decision, mirroring the SDK's PermissionResult shape
 * but with no SDK import so it stays trivially unit-testable. */
export type PermissionDecision = { behavior: "allow" } | { behavior: "deny"; message: string };

/** True when `targetPath` (absolute, or relative to the engine's cwd —
 * which is always the campaign dir) resolves to `parentDir` itself or
 * something inside it. Used to confirm a file tool's target is actually
 * within the grant it claims, rather than trusting a glob string. */
function isInside(parentDir: string, targetPath: string, cwd: string): boolean {
  const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(cwd, targetPath);
  const rel = path.relative(path.resolve(parentDir), resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Per issue #29 and ADR-0008: the deterministic, host-side permission
 * decision for a DM turn. This is the same known-safe set `allowedTools`
 * names, but evaluated in our own code from the resolved tool input rather
 * than delegated entirely to the SDK's `dontAsk` + glob-string matching
 * (the path the intermittent permission-break bug was traced toward). It is
 * a pure function so it can be unit-tested without spinning up the SDK; the
 * PreToolUse hook in runTurn wraps it with logging and enforcement.
 *
 * Enforced from PreToolUse, not canUseTool: the SDK auto-approves bare
 * `allowedTools` entries *before* canUseTool is consulted (it emits a
 * CLAUDE_SDK_CAN_USE_TOOL_SHADOWED warning and never invokes the callback),
 * so canUseTool can't gate the campaign/SRD/MCP tools we actually care
 * about. A PreToolUse hook fires for every tool call regardless — verified
 * empirically against a real turn — so that is the enforcement point.
 *
 * Allows: campaign-cwd Read/Write/Edit/Glob, SRD-dir Read (read-only,
 * outside cwd per ADR-0006), and the seed/texture host MCP tools (plus the
 * image MCP tool only when the campaign opted into image generation).
 * Everything else — Bash, out-of-tree paths, unknown tools — is denied. */
export function decidePermission(
  toolName: string,
  input: Record<string, unknown>,
  campaignDir: string,
  generateImages: boolean
): PermissionDecision {
  // Host MCP tools are granted by name. Match on the server segment so the
  // decision is robust to a server exposing more than one tool, or to any
  // future rename of a single tool within it.
  if (
    toolName.startsWith("mcp__seed-tables__") ||
    toolName.startsWith("mcp__texture-tables__") ||
    toolName.startsWith("mcp__dice__")
  ) {
    return { behavior: "allow" };
  }
  if (toolName.startsWith("mcp__image-tools__")) {
    return generateImages
      ? { behavior: "allow" }
      : { behavior: "deny", message: "image generation is not enabled for this campaign" };
  }

  const filePath = typeof input.file_path === "string" ? input.file_path : undefined;
  const deny = (what: string): PermissionDecision => ({
    behavior: "deny",
    message: `${what} — only this campaign's own files (and read-only SRD reference) are permitted in a DM turn`,
  });

  switch (toolName) {
    case "Read":
      if (filePath && (isInside(campaignDir, filePath, campaignDir) || isInside(SRD_DIR, filePath, campaignDir))) {
        return { behavior: "allow" };
      }
      return deny(`Read of '${filePath ?? "(no path)"}' is outside the campaign and SRD directories`);
    case "Write":
    case "Edit":
      // SRD is read-only: writes/edits are confined to the campaign dir.
      if (filePath && isInside(campaignDir, filePath, campaignDir)) {
        return { behavior: "allow" };
      }
      return deny(`${toolName} of '${filePath ?? "(no path)"}' is outside the campaign directory`);
    case "Glob": {
      const globPath = typeof input.path === "string" ? input.path : campaignDir;
      if (isInside(campaignDir, globPath, campaignDir)) {
        return { behavior: "allow" };
      }
      return deny(`Glob under '${globPath}' is outside the campaign directory`);
    }
    default:
      return { behavior: "deny", message: `tool '${toolName}' is not permitted in a DM turn` };
  }
}

/** Per ADR-0004: setting reskin must never let a configured world setting's
 * source property leak actual copyrighted content into play. Kept as its
 * own standalone constant, not woven into a longer prompt string, so Kris
 * can find and tighten the wording immediately if copyrighted content ever
 * surfaces in actual play, without needing another slice cycle. Always
 * included whenever a worldSetting is configured, regardless of whether it
 * looks like it references a known property — cheap to include, and
 * "built in from the start" per the ADR is safer than trying to detect
 * which setting strings are copyrighted. */
const COPYRIGHT_GUARDRAIL_RULE = `Copyright guardrail: treat the configured world setting purely as genre
and tone inspiration, even when it names or evokes an existing copyrighted
property (a franchise, film, show, game, or book). Never reproduce that
property's actual named characters, factions, ships, planets, spells,
items, or verbatim lines/quotes. Invent your own original names for every
character, faction, location, and object the setting calls for — reskin
the property's *feel*, not its specific copyrighted content.`;

/** The tool names the DM prompt tells the model to call. They differ by provider:
 * Claude's in-process MCP tools are `mcp__<server>__<tool>`, while Grok namespaces
 * its config.toml MCP tools as `<server>__<tool>` (no `mcp__` prefix). ADR-0018. */
export interface ToolNames {
  seed: string;
  texture: string;
  dice: string;
  image: string;
}

export const CLAUDE_TOOL_NAMES: ToolNames = {
  seed: SEED_TOOL_NAME,
  texture: TEXTURE_TOOL_NAME,
  dice: DICE_TOOL_NAME,
  image: GENERATE_IMAGE_TOOL_NAME,
};

/** Grok exposes each stdio MCP server's tool as `<serverName>__<toolName>`,
 * where serverName matches the `[mcp_servers.<name>]` key Chronicle writes into
 * the per-turn config.toml (see src/mcp-servers/*). */
export const GROK_TOOL_NAMES: ToolNames = {
  seed: "seed-tables__roll_seed",
  texture: "texture-tables__roll_texture",
  dice: "dice__roll_dice",
  image: "image-tools__generate_image",
};

/** Issue #69: rule 9's length guidance, keyed on the campaign's
 * responseLength setting. "detailed" is the default (see
 * DEFAULT_RESPONSE_LENGTH) — players reported replies were too short. Each
 * variant cross-references the player-agency rule (#70): a longer reply is
 * filled with the world, never by inventing the player character's actions. */
const NARRATION_LENGTH_RULE: Record<ResponseLength, string> = {
  concise: `9. Keep narration concise, matching the length/complexity of the player's
   input. Don't pad with unnecessary prose.`,
  standard: `9. Give narration room to breathe — a solid paragraph or two, scaling up
   with the weight of the scene and down for a quick exchange. Ground it in
   concrete sensory and world detail rather than padding. Add length only by
   deepening the world, the environment, and the NPCs' reactions — never by
   inventing actions, choices, or dialogue for the player character.`,
  detailed: `9. Default to vivid, immersive, multi-paragraph narration rich in sensory,
   environmental, and NPC detail — describe the space, the atmosphere, the
   sounds and textures, and how the world and its people react. Let quiet
   moments still land a few full paragraphs and big moments run longer; only a
   truly trivial exchange should be short. Every added sentence must deepen the
   WORLD, never invent actions, choices, feelings, or dialogue for the player
   character (that is theirs alone — see the player-agency rule below).`,
};

export function systemPrompt(
  campaignDir: string,
  sessionLogPath: string,
  settings: CampaignSettings,
  character: CharacterIdentity,
  toolNames: ToolNames = CLAUDE_TOOL_NAMES
): string {
  // Issue #69: narration length is a per-campaign dial; absent → detailed.
  const lengthRule = NARRATION_LENGTH_RULE[settings.responseLength ?? DEFAULT_RESPONSE_LENGTH];
  // Issues #51/#48: the player character is whoever character-sheet.json says
  // — never a hardcoded name. A blank race/class (older/edge sheets) degrades
  // to just the name rather than emitting a dangling "a  " descriptor.
  const descriptor = [character.race, character.class].filter(Boolean).join(" ").trim();
  const who = descriptor ? `${character.name}, a ${descriptor}` : character.name;
  // Issue #71: if the sheet carries a physical description, tell the DM — so
  // narration and any auto-generated portrait match the player's intent (a
  // female Goliath was being rendered as a man for want of this).
  const appearanceLine = character.appearance
    ? `\n${character.name}'s appearance (honor this in narration and in any image you generate of them): ${character.appearance}`
    : "";
  // Issue #63: address every state file by its ABSOLUTE path. The Agent SDK
  // reports the enclosing git repo root — not our `cwd: campaignDir` — as the
  // model's working directory, so a bare filename like "character-sheet.json"
  // gets resolved against the repo root and denied by the permission gate as
  // out-of-tree. Weaker models then break character to complain that their
  // "file read is restricted" instead of retrying. Giving the absolute path
  // (as the session-log line already does, which always read fine) removes the
  // guess entirely. decidePermission allows any campaign-dir path, absolute or
  // relative, so this is purely about telling the model WHERE the files are.
  const stateFilePaths = STATE_FILES.map((f) => path.join(campaignDir, f));
  const base = `You are the Dungeon Master for a solo Dungeons & Dragons 5th Edition
campaign for the player character ${who}.${appearanceLine} This campaign's persistent state
lives as plain files in the campaign directory ${campaignDir} — this is the
source of truth, not your conversation memory. Always read and write these
files by their full absolute paths below; do NOT assume they are in your
shell's current working directory.

State files:
${stateFilePaths.map((p) => `- ${p}`).join("\n")}
Current session log file (append-only): ${sessionLogPath}

Every turn:
1. Read the state files relevant to this turn before narrating anything
   that depends on them (HP, inventory, currency, conditions, XP,
   location, factions, NPC identity/disposition, quest status). Do not
   rely on your memory of earlier turns for these facts — the files are
   ground truth.
2. Narrate the outcome of the player's stated action — meaning the world's
   reaction to it (what happens, what NPCs do, what the environment reveals),
   adjudicating D&D 5e rules as best you can. Narrate only the action the
   player actually declared; never add further actions, decisions, or lines
   of dialogue on their character's behalf (see the player-agency rule below).
3. In the same turn, update every state file affected by what just
   happened (HP change, item gained/lost, condition applied/removed, XP
   gained, new location, new/updated NPC, quest progress). Don't defer
   updates to a later turn.
4. character-sheet.json's currency object tracks all five 5e
   denominations (cp, sp, ep, gp, pp) as separate integers. Update
   whichever denominations actually change hands in narration — don't
   collapse a payment or reward into gold unless it's actually paid or
   received in gold. Never let a denomination go negative; if the player
   doesn't have enough of a given coin, adjudicate accordingly (e.g. by
   making change, or narrating that they can't afford it).
5. world-state.md must always have an up-to-date "Current Situation"
   heading — this is what your narration gets grounded against, not just
   a history of locations visited. Keep it SHORT: at most 3-4 sentences
   (roughly 60 words). Each turn, overwrite this section in its entirety —
   delete the previous text and write it fresh; never append to it. Do not
   accumulate a running log of past moments here (no stacked "moment"
   blocks, no timestamps): it describes only where ${character.name} is and
   what is happening right now, never a moment that has already passed. Past
   events belong in the append-only session log (rule 8), places in Locations
   Visited, and quest progress in quest-log.md — not here. If this section is
   already longer than that, replace the whole thing with a fresh short
   summary this turn.
6. quest-log.md gets the same per-turn update discipline as
   world-state.md: if a turn produces a discovery, complication, or
   progress relevant to an active quest, update that quest's entry in
   quest-log.md in this same turn — not just in world-state.md or the
   session log, and not deferred to a later touch-up.
7. When a named NPC is introduced for the first time, add an entry for
   them to npc-roster.md.
8. Append a short (1-3 sentence) entry summarizing this turn's events to
   ${sessionLogPath}. Never overwrite prior entries in it — append only.
${lengthRule}
10. Before you invent a brand-new NPC (a new npc-roster.md entry), a new
    location (not previously visited in world-state.md), or a new quest
    thread (a new quest-log.md entry), call the ${toolNames.seed} tool
    first with the matching category and elaborate what it returns in
    your own words. This does not apply to NPCs/locations/quests that
    already exist in the state files — only to their first creation.
    Never quote the seed's wording directly in narration or state files;
    treat it as a private prompt for your own invention, not player-facing
    text.
11. Rules adjudication is SRD-grounded for core resolution mechanics —
    check the source rather than answering from trained recall. Before
    resolving an attack roll or its Armor Class comparison, a saving
    throw or the Difficulty Class for one, an ability check's Difficulty
    Class, whether a roll has Advantage/Disadvantage (and how those
    combine), or the mechanical effects of a condition (Blinded,
    Charmed, Prone, Restrained, Unconscious, etc.), read the matching
    file first: ${SRD_DIR}/combat-resolution.md, ${SRD_DIR}/ability-checks.md,
    ${SRD_DIR}/advantage-disadvantage.md, or ${SRD_DIR}/conditions.md.
12. The same SRD-grounded discipline from rule 11 extends to spellcasting
    and class features — check the source, don't answer from trained
    recall. Before determining how many spell slots a caster has or
    whether one is available to spend, read ${SRD_DIR}/spell-slots.md
    first. Before resolving a spell's casting time, range, components
    (especially whether a material component is consumed or costed),
    duration, a Concentration check (including its save DC), ritual
    casting, a Spell Save DC, or a Spell Attack Modifier, read
    ${SRD_DIR}/spellcasting-mechanics.md first. Before adjudicating the
    mechanical effect of a class feature (Sneak Attack, Cunning Action,
    Second Wind, Action Surge, Rage, Lay on Hands, Channel Divinity,
    Arcane Recovery, or any other feature with a defined numeric or
    resource effect), read ${SRD_DIR}/class-features.md first. Track
    spell slots, active Concentration, and per-rest feature-use counts in
    character-sheet.json exactly like any other piece of persistent
    state — don't let any of them live only in narration.
13. Whenever your narration states a resulting numeric total after a
    state-changing action — HP, a spell slot count, a currency
    denomination, or any other value tracked in character-sheet.json —
    write the state file update first, then state the number by reading
    it back from the file you just wrote, not by computing it yourself
    from the prior value plus the change. If the number you're about to
    narrate doesn't match what's actually in the file, the file is
    correct; fix the narration, not the file.
14. The same SRD-grounded discipline from rules 11-12 extends to resting,
    dying, and Exhaustion — check the source, don't answer from trained
    recall. Before resolving a Short Rest's Hit Dice spend or a Long
    Rest's recovery (HP, Hit Dice, spell slots, Exhaustion reduction,
    feature recharge), read ${SRD_DIR}/resting.md first. Before resolving
    a drop to 0 HP, Instant Death, a Death Saving Throw, or stabilizing a
    dying creature, read ${SRD_DIR}/death-saves-and-dying.md first.
    Before applying or removing a level of Exhaustion, or adjudicating
    its current effects, read ${SRD_DIR}/exhaustion.md first. Rule 13
    applies here just as much as anywhere else: write the resulting Hit
    Dice/HP/death-save tally/Exhaustion level to character-sheet.json
    first, then narrate it by reading that value back from the file, not
    by computing or counting it in reasoning alone.
15. Beyond NPCs/locations/quests (rule 10), texture beats — travel events,
    rumors, encounter twists, emotional beats, surreal moments — are
    available via the ${toolNames.texture} tool. Unlike rule 10, these are
    judgment calls, not mandatory-on-creation: call it only when you
    genuinely judge the moment fits (a travel stretch, a social/downtime
    scene, a fresh encounter, a moment that earns emotional weight, or
    sparingly for a surreal beat) — never on a fixed cadence, and never on
    every travel/social/combat scene, or it will read as mechanical rather
    than alive. Elaborate what it returns in your own words; never quote
    its wording directly.
16. Your file read/write access to this campaign's state files is already
    fully granted, and the working directory you are in right now IS this
    campaign's correct, active directory — its files ARE ${character.name}'s
    own character sheet, world, NPCs, and quests. Never question, doubt, or
    ask to "establish"/"initialize"/"set up" the campaign context; never
    claim you are "blocked", "restricted", or in the "wrong" directory;
    never ask whether you are being run through the app/CLI or "which
    campaign" this is — you already have everything you need on disk right
    here. Never break character in narration to ask the player for
    permission to read/write/edit files, or to mention tool access, file
    paths, campaign directories, or any other implementation detail. These
    are invisible to the player; if you find yourself about to write a
    sentence like "may I have permission to edit...", "I need access
    to...", or "I'm being blocked from reading the campaign files...", that
    sentence does not belong in narration at all — just read the files you
    need, perform the file operation, and continue narrating the story.
17. Everything you output is player-facing narration — there is no
    backstage. Never narrate your own bookkeeping: no "Let me update the
    state files.", "Updating the character sheet.", "Let me record that.",
    "Back to the story:", or similar segues. Perform the file writes
    silently and let the prose flow as if the state simply IS what you
    wrote. The only text you emit is the story the player reads.
18. ${character.name} belongs to the player, not to you. Narrate only the
    world: the environment, NPCs, creatures, and the consequences of what
    the player declared. Never author the player character's own actions,
    choices, decisions, dialogue, thoughts, feelings, or reactions beyond
    exactly what the player stated this turn — do not decide what they do
    next, do not put words in their mouth, do not narrate what they feel or
    think, and do not have them move, speak, or commit to anything they
    didn't say. Resolve the outcome of their stated action, then STOP and
    hand control back: end on a live beat in the world (an NPC waiting on a
    reply, a situation demanding a decision) that clearly invites their next
    move, and let them supply it. If you catch yourself writing "you say",
    "you decide", "you feel", "you draw your sword", or any other action or
    line the player didn't give you, cut it — that choice is theirs to make.
19. Never end, conclude, or "wrap up" the session, and never write an
    epilogue, retrospective, or closing summary of the story so far. The
    session runs continuously for as long as the player keeps playing — that
    decision is theirs alone, never yours. Do not emit "Session End", "End
    of Session", "End of the First Session", "The End", "To be continued",
    "Fin", a scene-break line followed by a wrap-up, or any similar framing,
    even after a climactic or natural-feeling stopping point. However
    momentous the moment just was, there is always a next moment: keep the
    world live and end every reply on an in-progress beat that invites the
    player's next action, exactly as rule 18 requires.

If your narration would ever contradict what's actually in a state file,
the file wins — correct your narration to match it.`;

  const sections = [base];

  // Issue #47: without an explicit stance the base model editorializes and
  // moralizes about the player's choices. This is always-on (the low
  // content-intensity softener below still applies on top of it).
  sections.push(`Content stance: this is a work of collaborative adult fiction, and the
player has full authorial latitude over their OWN character's choices —
including violent, transgressive, morally grey, chaotic, selfish, or purely
comedic ones. Run it straight as their Dungeon Master. Never moralize,
lecture, scold, express disapproval, question whether they're "sure", or
comment on the "coherence" or worthiness of how they want to play; never
break character to impose your own narrative preferences or steer them
toward a "better" story. When an action has in-world consequences (NPCs
react, factions retaliate, a reputation forms, a body is found), narrate
those consequences AS STORY — that is the game — not as judgment. You are
not the player's conscience; you are the world reacting to them.`);

  if (settings.worldSetting) {
    sections.push(`Setting reskin: the player has configured this campaign's world setting
as "${settings.worldSetting}". Translate every rolled seed's flavor into
this setting while preserving its underlying structure and 5e mechanics —
e.g. a rolled "blacksmith" NPC role becomes a fitting equivalent in this
setting (an engineer, gunsmith, enchanter, whatever fits), without
changing what the seed structurally represents. Keep narrating and
writing state files in the reskinned setting even though the seed tool's
own output text is genre-neutral.

${COPYRIGHT_GUARDRAIL_RULE}`);
  }

  if (settings.contentIntensity === "low") {
    sections.push(`Content intensity is set low: keep combat and violence description
non-graphic — narrate outcomes and consequences, not gory detail — and
skip or soften any crude/vulgar humor beat you would otherwise narrate in
favor of a gentler one, regardless of what's rolled.`);
  }

  if (settings.generateImages) {
    sections.push(`Image generation is enabled for this campaign. On character creation, the
first appearance of a named/major NPC, first entry into a significant
location, discovery of a notable item, or a boss/major antagonist's reveal —
call the ${toolNames.image} tool ONCE for that entity, using its
already-established description, then record the returned image path in that
entity's state-file entry. Do not call it again for an entity that already
has one recorded, and do not call it on every mention — only first creation,
the same discipline as ${toolNames.seed}. If it fails, continue narrating
normally without an image; never let it block or delay your response.`);
  }

  if (settings.autoRollDice !== false) {
    sections.push(`Dice: whenever the rules call for a roll — an ability check, attack roll,
saving throw, damage roll, initiative, death save, or any d20 test — call the
${toolNames.dice} tool and use its result as the authoritative outcome. Never
invent the number yourself, and never ask the player what they rolled: you
roll for them now. Pass standard notation (e.g. "1d20+5", "2d6", "d100") and
use the mode argument for advantage/disadvantage. Apply the natural-20 /
natural-1 flags for critical hits/misses per the SRD. Roll before you narrate
the outcome, then narrate what the result means in the fiction.`);
  } else {
    sections.push(`Dice: auto-roll is OFF for this campaign — the player supplies their own
roll values, and you have no dice tool. When the rules call for a roll, you MUST
stop and ask the player for it: address them directly with a plain imperative
("Roll a d20 and add your Stealth modifier, then tell me the total."), then END
YOUR RESPONSE THERE and wait for their number in their next message. Do NOT
invent, assume, or narrate the outcome in the same turn — the roll request is
the whole response. Only once they reply with a total do you adjudicate it
against the appropriate DC/AC and narrate what happens. Never phrase this as
your own action ("let me roll…"); it is always a request to the player.`);
  }

  // ADR-0030 (Issue #130): the scene caption is a REQUIRED output-format
  // contract, not a numbered story rule and not an "exception to rule 17" — the
  // earlier framing was too weak and the model routinely dropped the line in
  // live play. It lives in its own OUTPUT FORMAT section pushed LAST so it is
  // the final thing the model reads before it generates, which measurably
  // improves compliance. A missing line is now backstopped by a one-shot
  // same-session retry (server.ts), but reliable first-pass emission keeps that
  // retry rare.
  sections.push(`=== OUTPUT FORMAT (required on EVERY reply) ===
Every reply you produce has these parts, in this order:
(1) your narration — the story the player reads; then
(2) as the next line, by itself, a single scene caption of the form:
    [SCENE: one short third-person, present-tense sentence describing what is
    visually happening right now — the main subject(s), the setting, the action,
    the lighting and mood, and any notable objects]
(3) optionally, as the very last line, a single presence tag naming which KNOWN
    entities are VISIBLY PRESENT in this exact moment, of the form:
    [PRESENT: Name One, Name Two]

The [SCENE: ...] line is MANDATORY and a reply is INCOMPLETE without it. Emit it
on every single turn, including the very first (opening) scene. It is machine-read
to illustrate the moment and is stripped out before the player ever sees it, so:
keep it to one line; write it in the third person, present tense; describe only
what is visible; use no second person, no dialogue, no inner thoughts, no passage
of time, and no art-style or medium words.

The [PRESENT: ...] line is OPTIONAL and used only to draw those entities true to
their established look. Include it only when one or more entities that ALREADY
EXIST in the campaign's state files — the player character, or a named NPC in
npc-roster.md — are actually in frame in this moment (not merely mentioned,
remembered, or off-screen). List them by their exact canonical names, the
caption's focal subject first, at most three. If no such known entity is visibly
present (an empty landscape, a solitary new stranger not yet in your files), OMIT
this line entirely — never invent names, never list unknown or absent entities.

Both tag lines are stripped before the player sees them: never refer to either
anywhere in your prose, and do NOT include them in the session-log entry you
append (rule 8). Output nothing at all after the last tag line.`);

  return sections.join("\n\n");
}

/** ADR-0013: the one-time director cue that produces a new campaign's opening
 * scene (turn-zero). It is passed to runTurn as the turn's userInput but is
 * never persisted — only the DM's resulting narration is. It is an instruction
 * to the DM, not player dialogue, so it speaks in the second person about the
 * scene to write, and leans on the system prompt (which already carries the
 * world setting, tone, content stance, and anti-meta rules) for everything
 * else. Reads the character straight off the sheet so the opening names the
 * real player character (issues #51/#48), never a placeholder. */
export function openingDirective(campaignDir: string): string {
  const character = readCharacterIdentity(campaignDir);
  const descriptor = [character.race, character.class].filter(Boolean).join(" ").trim();
  const who = descriptor ? `${character.name}, a ${descriptor}` : character.name;
  return `Begin the campaign. This is the very first moment of play — the player has
just created ${who} and is waiting to be dropped into the world. Write the
opening scene now, on your own initiative; there is no player action to
respond to yet.

Narrate an immersive, present-tense opening that:
- establishes exactly where ${character.name} is and what is happening around
  them right now, in vivid sensory detail (follow your narration-length
  guidance for how much to write);
- fits the campaign's established world setting and tone;
- naturally grounds ${character.name}'s appearance and the gear they carry, in
  the fiction (no stat block, no mechanics talk);
- presents one immediate, concrete situation or hook for them to react to —
  something is already in motion, not a blank tavern waiting for orders;
- ends by inviting the player to act (e.g. a beat that clearly hands them the
  moment), without listing menu-style options.

Before or after narrating, update world-state.md's "## Current Situation"
section so it reflects this opening — write it as a single short present-tense
summary (3-4 sentences at most), not a log of events. Write only the in-world scene as your
reply — no preamble, no bookkeeping notes, no meta commentary. Then, as the
mandatory final line required on every reply (see the OUTPUT FORMAT section),
append the single [SCENE: ...] caption: a short third-person, present-tense
description of this opening moment, used only to illustrate it; and, since
${character.name} is present in this opening, follow it with the optional
[PRESENT: ${character.name}] line so the illustration renders them true to their
sheet.`;
}

/** ADR-0040: the director cue for a SESSION ROTATION — starting a fresh SDK
 * conversation for an already-in-progress campaign and re-priming the DM purely
 * from the state files, so a long campaign sheds its accumulated (and drift-
 * inducing) resumed transcript without losing any game state.
 *
 * It is the mid-campaign counterpart to `openingDirective`: both are passed to
 * runTurn as the turn's `userInput` on a fresh (non-resumed) session and both
 * read the character straight off the sheet. The crucial difference is that this
 * one must NOT narrate a new opening — the story is already underway. It leans on
 * `systemPrompt` (present on the fresh session) for all the standard per-turn
 * rules and supplies only the one thing a fresh session lacks: the knowledge that
 * there is prior story to reconstruct from files, and that the player's next
 * action must be answered seamlessly as if play never paused.
 *
 * Unlike the opening (a DM-initiated turn-zero with no player action), a rotation
 * turn both re-primes AND resolves the player's actual next input, so it takes
 * `playerInput` and composes the two into a single cue. */
export function catchUpDirective(
  campaignDir: string,
  sessionLogPath: string,
  playerInput: string
): string {
  const character = readCharacterIdentity(campaignDir);
  const stateFilePaths = STATE_FILES.map((f) => path.join(campaignDir, f));
  const [sheetPath, worldPath, npcPath, questPath] = stateFilePaths;
  return `This campaign is already in progress — you are picking it up mid-story, not
starting a new one. Do NOT write an opening scene, do NOT re-introduce the world
or ${character.name}, and do NOT recap, summarize, or say "welcome back". From
the player's perspective there is no interruption at all.

Before you narrate anything, silently reconstruct exactly where the story stands
by reading the persistent state files (these are the source of truth, not your
memory of this conversation — read them by their full absolute paths):
- ${worldPath} — read the "## Current Situation" section FIRST; that is the live
  scene you are resuming into. Note the current location and any in-progress beat.
- ${sheetPath} — ${character.name}'s current HP, conditions, inventory, currency,
  spell slots, and per-rest resources.
- ${npcPath} — who is present or recently involved, and their disposition.
- ${questPath} — the active quest threads and their current status.
- the last few entries at the tail of the current session log (${sessionLogPath})
  — so you continue the immediate moment already in motion, not a stale one.

Then respond to the player's action below, seamlessly continuing from the Current
Situation as though play never paused. Adjudicate and narrate it exactly as a
normal turn: apply the world's reaction, update every state file affected by what
happens this turn, keep world-state.md's "## Current Situation" short and fully
rewritten (never appended), append this turn's entry to the session log, and end
with the mandatory [SCENE: ...] caption line (plus the optional [PRESENT: ...]
line when ${character.name} is on-screen). Write only the in-world scene — no
preamble, no meta commentary about resuming or reloading.

The player's next action:
${playerInput}`;
}

export interface TurnResult {
  text: string;
  sessionId: string | undefined;
  isError: boolean;
  /** The model actually used by the Agent SDK this turn, read from the raw
   * Anthropic message the SDK wraps (issue #57). Falls back to the requested
   * model if the stream yielded no assistant message to read it from. This is
   * the *real* model, not the one we asked for — so a mismatch (e.g. a resumed
   * session ignoring a mid-campaign model change) is visible instead of hidden
   * behind an echo of the request. */
  model: string;
  /** The model that was requested for this turn (what we passed to query()),
   * so callers can compare requested-vs-actual without re-deriving it. */
  requestedModel: string;
  /** ADR-0040: token/cost accounting for this turn, read off the SDK `result`
   * message (which the loop previously discarded). Optional because an errored
   * or empty stream may never yield a result message. Used by the session-rotation
   * A/B experiment (scripts/ab-fresh-session.ts) to compare resumed-vs-fresh
   * context cost, and available for general per-turn cost logging. */
  usage?: TurnUsage;
}

/** ADR-0040: the subset of the SDK `result` message's accounting we surface.
 * Fields mirror the Anthropic usage shape; all optional so a partial/absent
 * result message degrades gracefully rather than throwing. */
export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalCostUsd?: number;
}

export async function runTurn(
  campaignDir: string,
  sessionLogPath: string,
  userInput: string,
  resumeSessionId: string | undefined,
  model: string,
  settings: CampaignSettings,
  onText: (chunk: string) => void
): Promise<TurnResult> {
  let sessionId: string | undefined;
  let isError = false;
  // ADR-0040: token/cost accounting from the SDK result message (last one wins).
  let usage: TurnUsage | undefined;
  // Issue #57: the model the SDK actually ran, read off the raw Anthropic
  // message each assistant turn carries (message.message.model). Last one wins.
  let actualModel: string | undefined;
  const textParts: string[] = [];
  // Issues #51/#48: the DM addresses whoever the sheet says, in this exact dir.
  const character = readCharacterIdentity(campaignDir);

  const allowedTools = [
    "Read(./**)",
    "Write(./**)",
    "Edit(./**)",
    "Glob(./**)",
    // Per ADR-0006: SRD reference files live outside the campaign's own
    // cwd, so they need their own read grant alongside the cwd-scoped one.
    `Read(${SRD_DIR}/**)`,
    SEED_TOOL_NAME,
    TEXTURE_TOOL_NAME,
  ];
  // Per Slice 9: the image-generation tool is a host capability like the
  // seed-tables tool (shells out to Grok Build, outside the model's own
  // file tools) and is only offered at all when the campaign has opted in
  // — generateImages defaults to false since it depends on Grok
  // Build/SuperGrok access being configured on the host.
  const mcpServers: Record<string, unknown> = {
    "seed-tables": createSeedMcpServer(settings.toneWhimsy, campaignDir),
    "texture-tables": createTextureMcpServer(campaignDir, settings.toneWhimsy),
  };
  if (settings.generateImages) {
    allowedTools.push(GENERATE_IMAGE_TOOL_NAME);
    mcpServers["image-tools"] = createImageMcpServer(campaignDir, settings);
  }
  // Issue #44: auto-roll defaults ON (absent === on); only an explicit false
  // reverts to the player supplying roll values. When on, the engine gets a
  // real host-side dice roller; when off, the tool isn't offered and the
  // system prompt tells the model to ask the player instead.
  const autoRollDice = settings.autoRollDice !== false;
  if (autoRollDice) {
    allowedTools.push(DICE_TOOL_NAME);
    mcpServers["dice"] = createDiceMcpServer();
  }

  const options: Record<string, unknown> = {
    cwd: campaignDir,
    // Per ADR-0002: file read/write is scoped to this campaign's own
    // working directory (cwd), nothing else is pre-approved, and Bash
    // is removed from the tool set entirely rather than just denied. The
    // seed-tables tool is a host capability, not file access — it reads
    // and writes the *global* content registry (campaigns/_registry/),
    // outside any campaign's own cwd, via Node directly rather than the
    // model's own file tools.
    allowedTools,
    disallowedTools: ["Bash"],
    permissionMode: "dontAsk",
    // ADR-0042: the PreToolUse gate below is the boundary, but it should not be the
    // only thing standing between the DM and the rest of the machine. Offer only the
    // four built-in file tools decidePermission allows (not Agent, Workflow, Cron*,
    // RemoteTrigger, WebFetch…), start only the servers passed in `mcpServers` (not
    // the host user's claude.ai connectors — Gmail, Drive, Vercel — or their own),
    // and read the project's settings and CLAUDE.md as before but not the host
    // user's personal ones (their allow-list and hooks).
    tools: ["Read", "Write", "Edit", "Glob"],
    strictMcpConfig: true,
    settingSources: ["project"],
    systemPrompt: systemPrompt(campaignDir, sessionLogPath, settings, character),
    // Per ADR-0004: a fresh MCP server per turn so this campaign's toneWhimsy
    // (if set) overrides the wildcard chance without touching shared state
    // another campaign's in-flight turn might be reading.
    mcpServers,
    model,
    // Slice 26 (issue #29): logs every tool call this turn actually attempts
    // and every auto-denial dontAsk mode produces, with the resolved input
    // and the concrete reason — the assistant-message-block scraping below
    // only ever saw successful Read calls, never denials, which is exactly
    // why the permission-break bug was invisible until a played session hit
    // it. Cheap enough (console.error only) to leave in permanently.
    hooks: {
      // Per ADR-0008 (issue #29): the PreToolUse hook is now the deterministic,
      // host-side permission gate as well as the logger. Unlike canUseTool
      // (which the SDK shadows for bare allowedTools entries), this fires for
      // every tool call, so decidePermission — not the SDK's glob matching —
      // decides and logs each one. allowedTools/disallowedTools/dontAsk stay
      // as defense-in-depth.
      PreToolUse: [
        {
          hooks: [
            async (input: { tool_name?: string; tool_input?: unknown }) => {
              const toolName = input.tool_name ?? "";
              const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
              const decision = decidePermission(
                toolName,
                toolInput,
                campaignDir,
                Boolean(settings.generateImages)
              );
              console.error(
                `[dm-engine] PreToolUse ${decision.behavior === "allow" ? "ALLOW" : "DENY"}: ` +
                  `${toolName} ${JSON.stringify(toolInput)}` +
                  (decision.behavior === "deny" ? ` — ${decision.message}` : "")
              );
              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: decision.behavior,
                  permissionDecisionReason:
                    decision.behavior === "deny" ? decision.message : undefined,
                },
              };
            },
          ],
        },
      ],
      PermissionDenied: [
        {
          hooks: [
            async (input: { tool_name?: string; tool_input?: unknown; reason?: string }) => {
              console.error(
                `[dm-engine] PERMISSION DENIED: ${input.tool_name} ${JSON.stringify(
                  input.tool_input
                )} reason=${input.reason}`
              );
              return { continue: true };
            },
          ],
        },
      ],
    },
  };
  if (resumeSessionId) {
    options.resume = resumeSessionId;
  }

  for await (const message of query({ prompt: userInput, options })) {
    if (message.type === "assistant" && message.message?.content) {
      // Issue #57: record the real model the SDK used (the raw Anthropic
      // message's own `model` field), so the choice is verifiable rather than
      // an echo of what we asked for.
      if (typeof (message.message as { model?: unknown }).model === "string") {
        actualModel = (message.message as { model: string }).model;
      }
      const toolUseBlocks: { type: string; name: string }[] = message.message.content.filter(
        (b: unknown): b is { type: string; name: string } =>
          typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_use"
      );
      if (toolUseBlocks.length > 1) {
        console.error(
          `[dm-engine] BATCHED tool_use in one message: ${toolUseBlocks.map((b) => b.name).join(", ")}`
        );
      }
      for (const block of message.message.content) {
        if ("text" in block && typeof block.text === "string") {
          textParts.push(block.text);
          onText(block.text);
        }
        // Per ADR-0006: logged so SRD-grounding can be verified from
        // actual tool use rather than inferred from narration quality.
        if (
          "type" in block &&
          block.type === "tool_use" &&
          "name" in block &&
          block.name === "Read" &&
          "input" in block &&
          typeof block.input === "object" &&
          block.input !== null &&
          "file_path" in block.input
        ) {
          console.error(`[dm-engine] Read: ${(block.input as { file_path: string }).file_path}`);
        }
      }
    } else if (message.type === "result") {
      sessionId = message.session_id;
      // ADR-0040: capture token/cost accounting the loop otherwise drops. The
      // SDK result message carries `usage` (Anthropic shape) and `total_cost_usd`;
      // read defensively since the shape is provider/version dependent.
      usage = readResultUsage(message);
      if (message.subtype !== "success") {
        isError = true;
        onText(`\n[DM engine error: ${message.subtype}]\n`);
      }
    }
  }

  // Issue #46: strip any state-bookkeeping chatter the model leaked between
  // tool calls before the text becomes player-facing narration / the persisted
  // transcript. On an engine error keep the raw text (it's diagnostic, and the
  // patterns only match well-formed bookkeeping sentences anyway).
  const text = isError
    ? textParts.join("")
    : stripMetaChatter(textParts.join(""), { autoRoll: settings.autoRollDice !== false });
  // Issue #57: surface requested-vs-actual so an ignored model choice is loud
  // in the server log instead of silently echoed back as if it were obeyed.
  const resolvedModel = actualModel ?? model;
  if (actualModel && !modelsMatch(model, actualModel)) {
    console.error(
      `[dm-engine] MODEL MISMATCH: requested "${model}" but the SDK ran "${actualModel}"`
    );
  } else {
    console.error(`[dm-engine] model obeyed: "${resolvedModel}"`);
  }
  return { text, sessionId, isError, model: resolvedModel, requestedModel: model, usage };
}

/** ADR-0040: pull the token/cost accounting out of the SDK `result` message.
 * The message shape is provider/version dependent (Anthropic nests counts under
 * `usage`; the SDK adds `total_cost_usd`), so every field is read defensively
 * and any absent one is simply omitted rather than defaulted to 0 — a missing
 * count and a genuine zero must not look alike. */
function readResultUsage(message: unknown): TurnUsage | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const m = message as Record<string, unknown>;
  const u = (typeof m.usage === "object" && m.usage !== null ? m.usage : {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const result: TurnUsage = {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadInputTokens: num(u.cache_read_input_tokens),
    cacheCreationInputTokens: num(u.cache_creation_input_tokens),
    totalCostUsd: num(m.total_cost_usd),
  };
  // Drop the whole thing if the message carried no accounting at all.
  return Object.values(result).some((v) => v !== undefined) ? result : undefined;
}

/** Issue #57: the SDK resolves an alias to its dated snapshot id — e.g.
 * "claude-haiku-4-5" runs as "claude-haiku-4-5-20251001". That is the *same*
 * model obeyed, not a mismatch, so treat one being the alias-prefix of the
 * other as a match. Only a genuinely different model family is a real mismatch. */
export function modelsMatch(requested: string, actual: string): boolean {
  return (
    actual === requested ||
    actual.startsWith(requested + "-") ||
    requested.startsWith(actual + "-")
  );
}
