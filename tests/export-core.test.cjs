const test = require("node:test");
const assert = require("node:assert/strict");
const ExportCore = require("../src/export-core.js");

const snapshot = {
  snapshotId: "snapshot-demo",
  predecessorSnapshotId: null,
  roomKey: "deepseek:room-123456789",
  platform: "deepseek",
  authorityStatus: "web-capture",
  title: "合成对话",
  startedAt: "2026-08-24T00:00:00.000Z",
  completedAt: "2026-08-24T00:10:00.000Z",
  status: "done-top",
  messageCount: 2,
  sequenceHash: "synthetic-sequence-hash",
  evidence: { topConfirmed: true, segmentCount: 1, gaps: [] },
  raw: { segments: [[{ rawText: "合成原始消息" }]] },
  normalized: [
    {
      index: 0,
      role: "user",
      content: "第一条合成消息",
      thinking: "",
      sourceTimestamp: { value: "2026-08-24 08:01", source: "time.text" },
      timeEvidence: { eventTime: "2026-08-24T00:01:00.000Z" },
      observedAt: "2026-08-24T00:02:00.000Z",
    },
    {
      index: 1,
      role: "assistant",
      content: "第二条合成回复",
      thinking: "合成思考内容",
      sourceTimestamp: null,
      timeEvidence: { eventTime: null, upperBound: "2026-08-24T00:03:00.000Z" },
      observedAt: "2026-08-24T00:03:00.000Z",
    },
  ],
};

test("JSON export preserves raw and normalized layers", () => {
  const download = ExportCore.buildSnapshotDownload(snapshot, { format: "json", exportedAt: "2026-08-24T01:00:00.000Z" });
  const value = JSON.parse(download.body);
  assert.equal(download.extension, "json");
  assert.equal(value.exportSchemaVersion, "web-memory-ferry/export-v1");
  assert.deepEqual(value.raw, snapshot.raw);
  assert.deepEqual(value.normalized, snapshot.normalized);
});

test("Markdown export distinguishes page time from capture time and includes thinking", () => {
  const download = ExportCore.buildSnapshotDownload(snapshot, { format: "md", platformLabel: "DeepSeek" });
  assert.equal(download.mimeType, "text/markdown;charset=utf-8");
  assert.match(download.body, /^# 归笺｜合成对话/m);
  assert.match(download.body, /网页原始标记：2026-08-24 08:01/);
  assert.match(download.body, /对话时间：网页未提供/);
  assert.match(download.body, /首次抓取：/);
  assert.match(download.body, /### 思考内容\n\n合成思考内容/);
});

test("plain text export is readable without Markdown syntax", () => {
  const download = ExportCore.buildSnapshotDownload(snapshot, { format: "txt", platformLabel: "DeepSeek" });
  assert.equal(download.extension, "txt");
  assert.match(download.body, /^归笺｜合成对话/m);
  assert.match(download.body, /\[1\] 用户/);
  assert.match(download.body, /正文：\n第一条合成消息/);
  assert.match(download.body, /思考内容：\n合成思考内容/);
  assert.doesNotMatch(download.body, /^# /m);
});

test("all-room export supports human-readable bundles", () => {
  const download = ExportCore.buildLatestBundleDownload([snapshot, { ...snapshot, snapshotId: "snapshot-b", title: "第二个房间" }], {
    format: "md",
    exportedAt: "2026-08-24T01:00:00.000Z",
    platformLabels: { deepseek: "DeepSeek" },
  });
  assert.equal(download.extension, "md");
  assert.match(download.body, /房间数：2/);
  assert.match(download.body, /## 归笺｜合成对话/);
  assert.match(download.body, /## 归笺｜第二个房间/);
});
