const test = require("node:test");
const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");

global.crypto = webcrypto;
const Core = require("../src/shared-core.js");

class FakeElement {
  constructor({ text = "", role = null } = {}) {
    this.innerText = text;
    this.role = role;
    this.className = role || "";
    this.isConnected = true;
  }
  getAttribute(name) { return name === "data-role" ? this.role : null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

class FakeScroller extends FakeElement {
  constructor(scrollTop) {
    super();
    this.scrollTop = scrollTop;
    this.scrollHeight = 1000;
    this.clientHeight = 200;
  }
  scrollBy({ top }) { this.scrollTop = Math.max(0, this.scrollTop + top); }
}

global.Element = FakeElement;
global.location = { hostname: "127.0.0.1", href: "http://127.0.0.1/test-room" };
global.document = {
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
};
global.MutationObserver = class {
  constructor(callback) { this.callback = callback; }
  observe() {}
  disconnect() {}
};
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);

const archive = { checkpoints: [], snapshots: [] };
global.chrome = { runtime: { async sendMessage(message) {
  if (message.type === "checkpoint.put") archive.checkpoints.push(structuredClone(message.value));
  if (message.type === "snapshot.commit") archive.snapshots.push(structuredClone(message.value));
  return { ok: true };
} } };
global.window = {
  WebMemoryFerryCore: Core,
  __WMF_TEST_CONFIG__: { intervalMs: 5, stableNeeded: 2, confirmRounds: 1, quietMs: 0, maxMs: 2000 },
  addEventListener() {},
  removeEventListener() {},
};

require("../src/scroll-capture.js");
const { FerryRun, PassiveRecorder, inferWindowRoles } = window.WebMemoryFerryRunner;

test("thinking anchors infer an alternating user-assistant window without guessing from no evidence", () => {
  const anchored = inferWindowRoles([
    { role: "unknown", roleEvidence: {}, thinkingText: "" },
    { role: "unknown", roleEvidence: {}, thinkingText: "推理一" },
    { role: "unknown", roleEvidence: {}, thinkingText: "" },
    { role: "unknown", roleEvidence: {}, thinkingText: "推理二" },
  ]);
  assert.deepEqual(anchored.map((item) => item.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(anchored[0].roleEvidence.source, "alternating-window-anchors");

  const unanchored = inferWindowRoles([
    { role: "unknown", roleEvidence: {}, thinkingText: "" },
    { role: "unknown", roleEvidence: {}, thinkingText: "" },
  ]);
  assert.deepEqual(unanchored.map((item) => item.role), ["unknown", "unknown"]);
});

const nodes = [
  new FakeElement({ text: "合成消息 1", role: "user" }),
  new FakeElement({ text: "好的", role: "assistant" }),
  new FakeElement({ text: "合成消息 3", role: "user" }),
  new FakeElement({ text: "合成消息 4", role: "assistant" }),
  new FakeElement({ text: "合成消息 5", role: "user" }),
  new FakeElement({ text: "合成消息 6", role: "assistant" }),
  new FakeElement({ text: "合成消息 7", role: "user" }),
  new FakeElement({ text: "好的", role: "assistant" }),
];

function windowFor(scroller) {
  if (scroller.scrollTop > 300) return nodes.slice(4, 8);
  if (scroller.scrollTop > 150) return nodes.slice(2, 6);
  return nodes.slice(0, 4);
}

function makeRun(scrollTop = 400) {
  const scroller = new FakeScroller(scrollTop);
  const plan = { scroller, getMessages: () => windowFor(scroller), source: "synthetic-overlap" };
  return new FerryRun({
    profile: { id: "synthetic" },
    roomKey: "synthetic:room-a",
    roomUrl: location.href,
    title: "合成房间 A",
    plan,
  });
}

async function waitForSnapshot(afterCount, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (archive.snapshots.length > afterCount) return archive.snapshots.at(-1);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("snapshot timeout");
}

async function seedMessages(items) {
  const observedAt = new Date().toISOString();
  const result = [];
  for (const node of items) {
    const message = {
      observedIndex: result.length,
      role: node.role,
      roleEvidence: { source: "attribute", confidence: "high" },
      rawText: node.innerText,
      content: node.innerText,
      thinkingText: "",
      sourceTimestamp: null,
      observedAt,
    };
    message.fingerprint = await Core.fingerprintMessage(message);
    result.push(message);
  }
  return result;
}

test("simulated upward capture merges overlapping windows and keeps repeated utterances", async () => {
  const count = archive.snapshots.length;
  const run = makeRun(400);
  await run.start(null);
  const snapshot = await waitForSnapshot(count);
  assert.equal(snapshot.status, "done-top");
  assert.equal(snapshot.messageCount, 8);
  assert.equal(snapshot.evidence.topConfirmed, true);
  assert.equal(snapshot.evidence.gaps.length, 0);
  assert.equal(snapshot.evidence.roleWarnings, 0);
  assert.equal(snapshot.evidence.timeEvidenceStats["observed-upper-bound"], 8);
  assert.equal(snapshot.normalized.every((item) => item.timeEvidence.eventTime === null), true);
  assert.equal(snapshot.normalized.filter((item) => item.content === "好的").length, 2);
  assert.ok(snapshot.evidence.duplicateObservations > 0);
});

test("a later run can continue from an immutable snapshot seed", async () => {
  const count = archive.snapshots.length;
  const latestWindow = await seedMessages(nodes.slice(4, 8));
  const seed = {
    snapshotId: "snapshot-before-resume",
    state: {
      segments: [latestWindow],
      observedWindows: 1,
      observedMessages: 4,
      duplicateObservations: 0,
      gaps: [],
      relations: ["initial"],
    },
  };
  const run = makeRun(280);
  await run.start(seed);
  const snapshot = await waitForSnapshot(count);
  assert.equal(snapshot.predecessorSnapshotId, "snapshot-before-resume");
  assert.equal(snapshot.messageCount, 8);
  assert.equal(snapshot.evidence.gaps.length, 0);
});

test("manual stop commits one partial snapshot and does not restart its timer", async () => {
  const count = archive.snapshots.length;
  const run = makeRun(400);
  await run.start(null);
  await run.stop("stopped-by-user");
  const snapshot = await waitForSnapshot(count);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(snapshot.status, "stopped-by-user");
  assert.equal(snapshot.evidence.topConfirmed, false);
  assert.equal(archive.snapshots.length, count + 1);
  assert.equal(run.timer, null);
});

test("manual capture checkpoints and keeps progressing while the tab is hidden", async () => {
  const count = archive.snapshots.length;
  const checkpointCount = archive.checkpoints.length;
  const run = makeRun(400);
  await run.start(null);
  document.hidden = true;
  run.boundVisibility();
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(run.status, "running");
  assert.notEqual(run.timer, null);
  assert.ok(archive.checkpoints.length > checkpointCount);
  assert.equal(archive.checkpoints.at(-1).mode, "manual-backfill");
  assert.equal(archive.checkpoints.at(-1).resumeRequested, true);
  const snapshot = await waitForSnapshot(count);
  assert.equal(snapshot.status, "done-top");
  document.hidden = false;
});

test("passive recorder saves the loaded window and appends a newly visible message", async () => {
  const count = archive.snapshots.length;
  const scroller = new FakeScroller(400);
  let visible = nodes.slice(0, 2);
  const recorder = new PassiveRecorder({
    profile: { id: "synthetic" },
    roomKey: "synthetic:live-room",
    roomUrl: location.href,
    title: "合成随行房间",
    plan: { scroller, getMessages: () => visible, source: "synthetic-live" },
  });

  await recorder.start(null);
  const first = await waitForSnapshot(count);
  assert.equal(first.status, "live-observation");
  assert.equal(first.messageCount, 2);
  assert.equal(first.evidence.topConfirmed, false);

  visible = nodes.slice(0, 3);
  await recorder.flush(false);
  const second = archive.snapshots.at(-1);
  assert.equal(second.predecessorSnapshotId, first.snapshotId);
  assert.equal(second.messageCount, 3);
  assert.equal(second.evidence.gaps.length, 0);
  await recorder.stop("live-stopped");
});

test("passive recorder replaces a streaming tail instead of making a false gap", async () => {
  const scroller = new FakeScroller(400);
  const user = new FakeElement({ text: "问题", role: "user" });
  const answer = new FakeElement({ text: "半句", role: "assistant" });
  const visible = [user, answer];
  const recorder = new PassiveRecorder({
    profile: { id: "synthetic" },
    roomKey: "synthetic:stream-room",
    roomUrl: location.href,
    title: "合成流式房间",
    plan: { scroller, getMessages: () => visible, source: "synthetic-live" },
  });

  await recorder.start(null);
  const first = archive.snapshots.at(-1);
  answer.innerText = "完整回答";
  await recorder.flush(false);
  const second = archive.snapshots.at(-1);
  assert.equal(second.predecessorSnapshotId, first.snapshotId);
  assert.equal(second.messageCount, 2);
  assert.equal(second.normalized.at(-1).content, "完整回答");
  assert.equal(second.evidence.gaps.length, 0);
  await recorder.stop("live-stopped");
});
