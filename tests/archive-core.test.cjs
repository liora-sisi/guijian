const test = require("node:test");
const assert = require("node:assert/strict");
const ArchiveCore = require("../src/archive-core.js");

function snapshot({ roomKey, id, completedAt, count, title, platform = "kimi", content = "" }) {
  return {
    snapshotId: id,
    roomKey,
    completedAt,
    messageCount: count,
    title,
    platform,
    normalized: [{ content, thinking: "" }],
    evidence: { segmentCount: 1, gaps: [] },
  };
}

const fixtures = [
  snapshot({ roomKey: "kimi:a", id: "a-old", completedAt: "2026-08-22T20:00:00.000Z", count: 90, title: "示例长房", content: "合成旧内容" }),
  snapshot({ roomKey: "kimi:a", id: "a-new", completedAt: "2026-08-23T12:00:00.000Z", count: 94, title: "示例长房", content: "合成新内容" }),
  snapshot({ roomKey: "chatgpt:b", id: "b-new", completedAt: "2026-08-23T13:00:00.000Z", count: 12, title: "工程房", platform: "chatgpt", content: "适配层" }),
];

test("summary keeps only the newest snapshot per room", () => {
  const result = ArchiveCore.summarizeSnapshots(fixtures, { todayStartIso: "2026-08-23T00:00:00.000Z" });
  assert.equal(result.totalRooms, 2);
  assert.equal(result.totalSnapshots, 3);
  assert.equal(result.totalMessages, 106);
  assert.equal(result.rooms[0].snapshotId, "b-new");
  assert.equal(result.platforms.kimi.rooms, 1);
  assert.equal(result.platforms.chatgpt.messages, 12);
});

test("today ingested uses the last pre-today snapshot as baseline", () => {
  const result = ArchiveCore.summarizeSnapshots(fixtures, { todayStartIso: "2026-08-23T00:00:00.000Z" });
  assert.equal(result.todayIngested, 16);
});

test("content search returns room metadata without leaking the matching message", () => {
  const result = ArchiveCore.summarizeSnapshots(fixtures, { query: "合成新内容" });
  assert.equal(result.matchedRooms, 1);
  assert.equal(result.rooms[0].roomKey, "kimi:a");
  assert.equal(result.rooms[0].matchKind, "content");
  assert.equal(Object.hasOwn(result.rooms[0], "content"), false);
});

test("multiple query words must all match locally", () => {
  assert.equal(ArchiveCore.summarizeSnapshots(fixtures, { query: "示例 新内容" }).matchedRooms, 1);
  assert.equal(ArchiveCore.summarizeSnapshots(fixtures, { query: "示例 适配" }).matchedRooms, 0);
});
