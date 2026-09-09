import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveSessionLog,
  startSessionLog,
  appendTurnTranscript,
  readStateSnapshot,
} from "../src/campaign-store.js";

/** A minimal on-disk campaign: the four state files readStateSnapshot needs,
 * plus an empty session-log/ dir. Not scaffoldCampaign (that writes under the
 * real CAMPAIGNS_ROOT) — issue #49's logic is pure filesystem, so a temp dir
 * exercises it without touching campaigns/. */
function tempCampaign(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-resume-"));
  fs.writeFileSync(path.join(dir, "character-sheet.json"), JSON.stringify({ name: "Kira", level: 1 }));
  fs.writeFileSync(path.join(dir, "world-state.md"), "## Current Situation\n\nAt the inn.\n");
  fs.writeFileSync(path.join(dir, "npc-roster.md"), "# NPCs\n");
  fs.writeFileSync(path.join(dir, "quest-log.md"), "# Quests\n");
  fs.mkdirSync(path.join(dir, "session-log"));
  return dir;
}

test("resolveSessionLog(resume) reuses the log that has turns, not a newer empty one (#49)", () => {
  const dir = tempCampaign();
  try {
    const storyLog = startSessionLog(dir);
    appendTurnTranscript(dir, storyLog, "look around", "You see the inn.");
    // A stray, newer, EMPTY log (the kind repeated session/start used to leave).
    // Sleep-free: startSessionLog's timestamp is second-resolution, so force a
    // lexically-later name by writing one directly.
    const strayLater = "session-log/session-9999-99-99T99-99-99-999Z.md";
    fs.writeFileSync(path.join(dir, strayLater), "# later empty\n");

    // Resuming must land on the log with the story, not the empty stray.
    assert.equal(resolveSessionLog(dir, true), storyLog);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSessionLog(fresh) reuses an existing empty log instead of piling up more (#49)", () => {
  const dir = tempCampaign();
  try {
    const first = startSessionLog(dir);
    // No turns recorded -> a fresh start should reuse `first`, not create a 2nd.
    assert.equal(resolveSessionLog(dir, false), first);
    const mdCount = fs.readdirSync(path.join(dir, "session-log")).filter((f) => f.endsWith(".md")).length;
    assert.equal(mdCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSessionLog(fresh) continues the story log after auto-rotate cleared the SDK id", () => {
  // ADR-0040/0041: auto-rotate drops the persisted SDK session id, so the next
  // /session/start resolves with resuming=false even though the campaign has a
  // story in progress. It must continue the existing log-with-turns, not fork a
  // fresh empty log — otherwise the active session and the /state display diverge
  // and moment illustrate/animate report "no turn N in the active session".
  const dir = tempCampaign();
  try {
    const storyLog = startSessionLog(dir);
    appendTurnTranscript(dir, storyLog, "look around", "You see the inn.");

    // resuming=false (persisted SDK id was cleared by rotation) must still land
    // on the story log, and must not create a second .md.
    assert.equal(resolveSessionLog(dir, false), storyLog);
    const mdCount = fs.readdirSync(path.join(dir, "session-log")).filter((f) => f.endsWith(".md")).length;
    assert.equal(mdCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readStateSnapshot surfaces prior turns even with no active session log passed (#49)", () => {
  const dir = tempCampaign();
  try {
    const storyLog = startSessionLog(dir);
    appendTurnTranscript(dir, storyLog, "drink a beer", "The beer is warm.");

    // Simulate a server restart / deep-link: no active session, so no path.
    const snap = readStateSnapshot(dir);
    assert.ok(snap.currentSessionLog, "expected currentSessionLog to be populated from history");
    assert.equal(snap.currentSessionLog!.transcript.length, 1);
    assert.equal(snap.currentSessionLog!.transcript[0].narration, "The beer is warm.");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readStateSnapshot falls back past an empty active log to the one with turns (#49)", () => {
  const dir = tempCampaign();
  try {
    const storyLog = startSessionLog(dir);
    appendTurnTranscript(dir, storyLog, "enter", "You step inside.");
    const emptyLater = "session-log/session-9999-99-99T99-99-99-999Z.md";
    fs.writeFileSync(path.join(dir, emptyLater), "# empty\n");

    // Active session points at the empty later log; snapshot should still show
    // the story rather than an empty transcript.
    const snap = readStateSnapshot(dir, emptyLater);
    assert.equal(snap.currentSessionLog!.transcript.length, 1);
    assert.equal(snap.currentSessionLog!.transcript[0].narration, "You step inside.");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
