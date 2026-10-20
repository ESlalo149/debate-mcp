import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCliProcessOnce } from "../src/agents/cli.js";
import { createOpenCodeChildEnvironment, isQuotaFailure, isRetryableCliFailure, resolveCliTimeout, withTransientRetries } from "../src/agents/policy.js";

test("OpenCode gets an isolated child config without mutating parent config", () => {
  const parent = {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "openai/model", tools: { read: true }, mcp: { custom: { enabled: true } } }),
    KEEP_ME: "yes",
  };
  const child = createOpenCodeChildEnvironment(parent);
  const childConfig = JSON.parse(child.OPENCODE_CONFIG_CONTENT!);
  const originalConfig = JSON.parse(parent.OPENCODE_CONFIG_CONTENT!);

  assert.equal(child.KEEP_ME, "yes");
  assert.equal(childConfig.model, "openai/model");
  assert.equal(childConfig.mcp.custom.enabled, false);
  assert.equal(childConfig.mcp["debate-room"].enabled, false);
  assert.equal(childConfig.mcp.gitnexus.enabled, false);
  assert.equal(childConfig.tools["*"], false);
  assert.equal(originalConfig.mcp["debate-room"], undefined);
  assert.deepEqual(originalConfig.tools, { read: true });
});

test("OpenCode rejects malformed inline config instead of losing user settings", () => {
  assert.throws(() => createOpenCodeChildEnvironment({ OPENCODE_CONFIG_CONTENT: "not-json" }), /no contiene JSON válido/);
});

test("fake OpenCode child receives isolated config while preserving inline user settings", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "debate-mcp-cli-test-"));
  try {
    const script = path.join(directory, "fake-opencode.mjs");
    await writeFile(script, "process.stdout.write(process.env.OPENCODE_CONFIG_CONTENT ?? '')\n", "utf8");
    const result = await runCliProcessOnce(process.execPath, [script], "fake OpenCode", "test-model", "opencode", "turn", 1, {
      timeoutMs: 10_000,
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "openai/model", mcp: { custom: { enabled: true } } }) },
    });
    const config = JSON.parse(result.stdout);
    assert.equal(config.model, "openai/model");
    assert.equal(config.mcp["debate-room"].enabled, false);
    assert.equal(config.mcp.custom.enabled, false);
    assert.equal(config.tools["*"], false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("timeouts resolve from phase-specific, provider-specific, then phase defaults", () => {
  assert.equal(resolveCliTimeout("agy", "plan", { DEBATE_TIMEOUT_AGY_PLAN_MS: "42000" }), 42000);
  assert.equal(resolveCliTimeout("opencode", "signoff", { DEBATE_TIMEOUT_OPENCODE_MS: "30000" }), 30000);
  assert.equal(resolveCliTimeout("agy", "turn", {}), 240000);
  assert.throws(() => resolveCliTimeout("agy", "turn", { DEBATE_TIMEOUT_AGY_TURN_MS: "0" }), /entero/);
});

test("quota failures are terminal and ambiguous 429 responses are not retried", () => {
  assert.equal(isQuotaFailure({ message: "RESOURCE_EXHAUSTED: quota reached; resets in 4h" }), true);
  assert.equal(isRetryableCliFailure({ message: "RESOURCE_EXHAUSTED: quota reached" }), false);
  assert.equal(isRetryableCliFailure({ message: "HTTP 429" }), false);
  assert.equal(isRetryableCliFailure({ message: "429 rate limit, Retry-After: 2" }), true);
  assert.equal(isRetryableCliFailure({ message: "connection reset", code: "ECONNRESET" }), true);
});

test("transient retries are bounded and use exponential backoff; quota fails immediately", async () => {
  const delays: number[] = [];
  let attempts = 0;
  const value = await withTransientRetries(async () => {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    return "ok";
  }, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100, sleep: async (ms) => { delays.push(ms); } });
  assert.equal(value, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);

  attempts = 0;
  await assert.rejects(() => withTransientRetries(async () => {
    attempts++;
    throw new Error("RESOURCE_EXHAUSTED quota reached");
  }, { maxRetries: 2, sleep: async () => { assert.fail("quota errors must not retry"); } }));
  assert.equal(attempts, 1);
});
