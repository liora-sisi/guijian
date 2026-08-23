const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../src/shared-core.js");

function msg(id) { return { fingerprint: id, content: id, role: "unknown" }; }

test("older overlapping window is prepended without duplicating overlap", () => {
  const existing = [msg("C"), msg("D"), msg("E")];
  const incoming = [msg("A"), msg("B"), msg("C"), msg("D")];
  const result = Core.reconcileWindow(existing, incoming);
  assert.equal(result.relation, "older-overlap");
  assert.deepEqual(result.merged.map((item) => item.fingerprint), ["A", "B", "C", "D", "E"]);
});

test("identical repeated messages are not globally collapsed", () => {
  const existing = [msg("X"), msg("Y"), msg("X")];
  const incoming = [msg("Z"), msg("X"), msg("Y")];
  const result = Core.reconcileWindow(existing, incoming);
  assert.deepEqual(result.merged.map((item) => item.fingerprint), ["Z", "X", "Y", "X"]);
});

test("disjoint upward windows remain separate and produce a gap", () => {
  let state = Core.mergeWindowIntoState(null, [msg("C"), msg("D")], "older");
  state = Core.mergeWindowIntoState(state, [msg("A"), msg("B")], "older");
  assert.equal(state.segments.length, 2);
  assert.equal(state.gaps.length, 1);
  assert.deepEqual(Core.flattenState(state).map((item) => item.fingerprint), ["A", "B", "C", "D"]);
});

test("contained window changes no sequence", () => {
  const result = Core.reconcileWindow([msg("A"), msg("B"), msg("C")], [msg("B")]);
  assert.equal(result.relation, "already-contained");
  assert.deepEqual(result.merged.map((item) => item.fingerprint), ["A", "B", "C"]);
});

test("same raw message upgrades role and normalized content without duplicating an old snapshot", () => {
  const existing = [{
    fingerprint: "old",
    rawText: "思考区\n最终回答\n复制",
    content: "思考区\n最终回答\n复制",
    thinkingText: "思考区",
    role: "unknown",
    roleEvidence: { source: "unresolved", confidence: "none" },
    observedAt: "2026-08-23T10:00:00.000Z",
  }];
  const incoming = [{
    fingerprint: "new",
    rawText: "思考区\n最终回答\n复制",
    content: "最终回答",
    thinkingText: "思考区",
    role: "assistant",
    roleEvidence: { source: "thinking-region", confidence: "high" },
    observedAt: "2026-08-24T10:00:00.000Z",
  }];
  const result = Core.reconcileWindow(existing, incoming);
  assert.equal(result.relation, "already-contained");
  assert.equal(result.merged.length, 1);
  assert.equal(result.merged[0].role, "assistant");
  assert.equal(result.merged[0].content, "最终回答");
  assert.equal(result.merged[0].observedAt, "2026-08-23T10:00:00.000Z");
});

test("filename removes Windows-reserved characters", () => {
  assert.equal(Core.safeFilename('示例:/\\*?"<>|  房间'), "示例_________ 房间");
});

test("export filename uses platform, room name, explicit capture time and count", () => {
  const filename = Core.buildExportFilename({
    platform: "Kimi",
    displayName: "示例房间",
    completedAt: "2026-08-23T19:05:06+08:00",
    messageCount: 721,
  });
  assert.equal(filename, "Kimi__示例房间__采集至20260823-190506__721条.json");
});

test("missing platform time is stored only as an observed upper bound", () => {
  const evidence = Core.buildTimeEvidence({ sourceTimestamp: null, observedAt: "2026-08-23T11:11:12.000Z" });
  assert.equal(evidence.kind, "observed-upper-bound");
  assert.equal(evidence.eventTime, null);
  assert.equal(evidence.upperBound, "2026-08-23T11:11:12.000Z");
  assert.equal(evidence.confidence, "bounded");
});

test("absolute platform timestamp remains distinct from first observation", () => {
  const evidence = Core.buildTimeEvidence({
    sourceTimestamp: { value: "2026-08-23T18:52:36+08:00", source: "time.datetime" },
    observedAt: "2026-08-23T11:17:00.000Z",
  });
  assert.equal(evidence.kind, "platform-time-candidate");
  assert.equal(evidence.eventTime, "2026-08-23T10:52:36.000Z");
  assert.equal(evidence.firstObservedAt, "2026-08-23T11:17:00.000Z");
  assert.equal(evidence.confidence, "high");
});

test("time-only platform label is preserved without inventing a date", () => {
  const evidence = Core.buildTimeEvidence({
    sourceTimestamp: { value: "19:11", source: "time.text" },
    observedAt: "2026-08-23T11:17:00.000Z",
  });
  assert.equal(evidence.eventTime, null);
  assert.equal(evidence.precision, "time-of-day");
  assert.equal(evidence.contextRequired, true);
});

test("live streaming tail revision replaces partial reply instead of creating a gap", () => {
  const existing = [msg("A"), msg("B-partial")];
  const incoming = [msg("A"), msg("B-complete")];
  const result = Core.reconcileLiveWindow(existing, incoming);
  assert.equal(result.relation, "live-tail-revision");
  assert.deepEqual(result.merged.map((item) => item.fingerprint), ["A", "B-complete"]);
});

test("live window appends to the newest edge of an existing sequence", () => {
  let state = Core.mergeLiveWindowIntoState(null, [msg("A"), msg("B")]);
  state = Core.mergeLiveWindowIntoState(state, [msg("B"), msg("C")]);
  assert.equal(state.gaps.length, 0);
  assert.deepEqual(Core.flattenState(state).map((item) => item.fingerprint), ["A", "B", "C"]);
});

test("fuzzy adjacent overlap tolerates one changing message inside a virtualized window", () => {
  const older = [msg("A"), msg("B"), msg("old variant"), msg("C"), msg("D")];
  const newer = [msg("B"), msg("new variant"), msg("C"), msg("D"), msg("E")];
  const result = Core.fuzzyAdjacentOverlap(older, newer);
  assert.equal(result.relation, "fuzzy-adjacent-overlap");
  assert.equal(result.overlap, 3);
  assert.deepEqual(result.merged.map((item) => item.fingerprint), ["A", "B", "old variant", "C", "D", "E"]);
});

test("a live window that is an ordered subsequence does not append repeated utterances", () => {
  const existing = [msg("A"), msg("X"), msg("B"), msg("C"), msg("D")];
  const incoming = [msg("A"), msg("B"), msg("C"), msg("D")];
  const state = Core.mergeLiveWindowIntoState({ segments: [existing], gaps: [], relations: [] }, incoming);
  assert.equal(state.segments.length, 1);
  assert.equal(state.gaps.length, 0);
  assert.deepEqual(state.segments[0].map((item) => item.fingerprint), ["A", "X", "B", "C", "D"]);
});

test("adjacent repair joins strongly overlapping virtual windows and keeps weak boundaries", () => {
  const state = {
    segments: [
      [msg("A"), msg("B"), msg("old variant"), msg("C"), msg("D")],
      [msg("B"), msg("new variant"), msg("C"), msg("D"), msg("E")],
      [msg("X"), msg("Y")],
    ],
    duplicateObservations: 0,
    gaps: [{}, {}],
    relations: [],
  };
  const repaired = Core.coalesceAdjacentSegments(state);
  assert.equal(repaired.segments.length, 2);
  assert.equal(repaired.gaps.length, 1);
  assert.equal(repaired.repairs.mergedBoundaries, 1);
  assert.equal(repaired.repairs.unresolvedBoundaries, 1);
});

test("many virtualized windows merge into one ordered segment despite transient variants", () => {
  const base = Array.from({ length: 100 }, (_, index) => msg(`M${index}`));
  const windows = [];
  for (let start = 88; start >= 0; start -= 2) {
    const window = base.slice(start, start + 12).map((item) => ({ ...item }));
    if (start % 4 === 0 && window.length > 5) window[5] = msg(`${window[5].fingerprint} transient-controls`);
    windows.push(window);
  }
  let state = Core.mergeWindowIntoState(null, windows[0], "older");
  for (const window of windows.slice(1)) state = Core.mergeWindowIntoState(state, window, "older");
  assert.equal(state.segments.length, 1);
  assert.equal(state.gaps.length, 0);
  assert.equal(Core.flattenState(state).length, 100);
});
