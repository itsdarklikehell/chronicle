import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigFrom, CONFIG_DEFAULTS } from "../src/config.js";

// ADR-0033: the loader reads config.json / secrets.json from a directory, falling
// back to config.example.json (never crashing on a missing/optional/malformed file),
// deep-merges over the built-in defaults, and deep-freezes the result.

/** Make a throwaway dir, run `fn(dir)`, and remove it. */
function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-config-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const write = (dir: string, name: string, obj: unknown): void =>
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2) + "\n");

test("loadConfigFrom: reads config.json and deep-merges over defaults", () => {
  withTempDir((dir) => {
    write(dir, "config.json", { server: { port: 9999 }, defaults: { imageProvider: "local" } });
    const { config, sources } = loadConfigFrom(dir);
    assert.equal(sources.config, "config.json");
    assert.equal(config.server.port, 9999); // overridden
    assert.equal(config.server.host, CONFIG_DEFAULTS.server.host); // untouched sibling kept
    assert.equal(config.defaults.imageProvider, "local"); // overridden
    assert.equal(config.defaults.model, CONFIG_DEFAULTS.defaults.model); // untouched default kept
  });
});

test("loadConfigFrom: falls back to config.example.json when config.json is absent", () => {
  withTempDir((dir) => {
    write(dir, "config.example.json", { server: { port: 1234 } });
    const { config, sources } = loadConfigFrom(dir);
    assert.equal(sources.config, "config.example.json");
    assert.equal(config.server.port, 1234);
    // Values the example omits still come from the built-in defaults.
    assert.equal(config.comfyui.url, CONFIG_DEFAULTS.comfyui.url);
  });
});

test("loadConfigFrom: with neither file present, uses the built-in defaults", () => {
  withTempDir((dir) => {
    const { config, sources } = loadConfigFrom(dir);
    assert.equal(sources.config, "built-in defaults");
    assert.deepEqual(config, CONFIG_DEFAULTS);
  });
});

test("loadConfigFrom: missing secrets.json degrades gracefully (no throw, empty creds)", () => {
  withTempDir((dir) => {
    const { secrets, sources } = loadConfigFrom(dir);
    assert.equal(sources.secrets, "none");
    assert.equal(secrets.bootstrap.username, "");
    assert.equal(secrets.bootstrap.password, "");
    assert.equal(secrets.navidrome.username, "");
  });
});

test("loadConfigFrom: reads secrets.json when present", () => {
  withTempDir((dir) => {
    write(dir, "secrets.json", { bootstrap: { username: "alice", password: "hunter2" } });
    const { secrets, sources } = loadConfigFrom(dir);
    assert.equal(sources.secrets, "secrets.json");
    assert.equal(secrets.bootstrap.username, "alice");
    assert.equal(secrets.bootstrap.password, "hunter2");
    assert.equal(secrets.navidrome.password, ""); // unset key still defaults
  });
});

test("loadConfigFrom: nested defaults are deep-merged (not replaced) by partial user config", () => {
  withTempDir((dir) => {
    // User sets only one nested field; siblings must keep their defaults.
    write(dir, "config.json", {
      server: { host: "0.0.0.0" },
      defaults: { imageProvider: "local", artStyle: "noir" },
    });
    const { config } = loadConfigFrom(dir);
    assert.equal(config.server.host, "0.0.0.0");
    assert.equal(config.server.port, CONFIG_DEFAULTS.server.port); // sibling untouched
    assert.equal(config.defaults.imageProvider, "local");
    assert.equal(config.defaults.artStyle, "noir");
    assert.equal(config.defaults.model, CONFIG_DEFAULTS.defaults.model); // sibling untouched
    // The result must be frozen so accidental mutations throw.
    assert.throws(() => { (config.defaults as Record<string, unknown>).model = "fake"; }, TypeError);
  });
});

test("loadConfigFrom: a malformed config.json is ignored, not fatal", () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, "config.json"), "{ not valid json ,,, }");
    write(dir, "config.example.json", { server: { port: 4242 } });
    // Must not throw; falls back to the example.
    const { config, sources } = loadConfigFrom(dir);
    assert.equal(sources.config, "config.example.json");
    assert.equal(config.server.port, 4242);
  });
});

test("loadConfigFrom: the returned config and secrets are deeply frozen", () => {
  withTempDir((dir) => {
    const { config, secrets } = loadConfigFrom(dir);
    assert.equal(Object.isFrozen(config), true);
    assert.equal(Object.isFrozen(config.server), true);
    assert.equal(Object.isFrozen(config.defaults), true);
    assert.equal(Object.isFrozen(secrets.bootstrap), true);
    assert.throws(() => {
      // Mutating a deep-frozen object throws in strict mode (ESM is always strict).
      (config.server as { port: number }).port = 1;
    }, TypeError);
  });
});

test("loadConfigFrom: types/defaults are preserved exactly (behavior parity with the old env defaults)", () => {
  withTempDir((dir) => {
    const { config } = loadConfigFrom(dir);
    const d = config.defaults;
    assert.equal(config.server.host, "127.0.0.1");
    assert.equal(config.server.port, 4317);
    assert.equal(config.comfyui.url, "http://localhost:8188");
    assert.equal(d.provider, "claude");
    assert.equal(d.model, "claude-sonnet-5");
    assert.equal(d.imageProvider, "grok");
    assert.equal(d.imageQuality, "standard");
    assert.equal(d.responseLength, "detailed");
    assert.equal(d.autoRollDice, true);
    assert.equal(d.musicEnabled, false);
    assert.equal(d.musicSource, "local");
    assert.equal(d.videoDuration, 5);
    assert.equal(d.videoResolution, "480p");
    assert.equal(d.videoAspect, "square");
    assert.equal(d.seedWildcardChance, 0.175);
    assert.equal(d.toneWhimsy, null);
    assert.equal(typeof d.seedWildcardChance, "number");
    assert.equal(typeof d.autoRollDice, "boolean");
  });
});

test("committed config.example.json parses and its real values equal the built-in defaults", () => {
  // The repo-root example is both documentation and the runtime fallback, so it must
  // be valid JSON whose real values equal CONFIG_DEFAULTS (ignoring `_comment` docs).
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  withTempDir((dir) => {
    fs.copyFileSync(path.join(repoRoot, "config.example.json"), path.join(dir, "config.json"));
    const { config } = loadConfigFrom(dir);
    for (const [key, expected] of Object.entries(CONFIG_DEFAULTS.defaults)) {
      assert.deepEqual((config.defaults as Record<string, unknown>)[key], expected, `defaults.${key}`);
    }
    assert.equal(config.server.host, CONFIG_DEFAULTS.server.host);
    assert.equal(config.server.port, CONFIG_DEFAULTS.server.port);
    assert.equal(config.comfyui.url, CONFIG_DEFAULTS.comfyui.url);
    assert.equal(config.navidrome.url, CONFIG_DEFAULTS.navidrome.url);
  });
});
