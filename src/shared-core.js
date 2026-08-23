(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.WebMemoryFerryCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const encoder = new TextEncoder();

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[\t ]+$/g, ""))
      .join("\n")
      .replace(/^\n+|\n+$/g, "");
  }

  async function sha256Hex(value) {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function fingerprintMessage(message) {
    const role = String(message.role || "unknown").toLowerCase();
    const content = normalizeText(message.content ?? message.rawText);
    const thinking = normalizeText(message.thinking ?? message.thinkingText);
    return sha256Hex(`${role}\0${content}\0${thinking}`);
  }

  function tokenOf(message) {
    return message.fingerprint || message.contentHash || "";
  }

  function payloadText(message) {
    return normalizeText(message.rawText ?? message.content);
  }

  function messagesEquivalent(a, b) {
    if (tokenOf(a) && tokenOf(a) === tokenOf(b)) return true;
    return payloadText(a) === payloadText(b)
      && normalizeText(a.thinkingText ?? a.thinking) === normalizeText(b.thinkingText ?? b.thinking);
  }

  function roleEvidenceRank(message) {
    const role = String(message.role || "unknown");
    const confidence = String(message.roleEvidence?.confidence || "none");
    const confidenceRank = { none: 0, low: 1, medium: 2, high: 3 }[confidence] || 0;
    return (role === "unknown" ? 0 : 10) + confidenceRank;
  }

  function preferredEquivalent(existing, incoming) {
    const normalizationChanged = payloadText(existing) === payloadText(incoming)
      && normalizeText(existing.content) !== normalizeText(incoming.content);
    const preferred = roleEvidenceRank(incoming) > roleEvidenceRank(existing) || normalizationChanged ? incoming : existing;
    const firstObserved = [existing.observedAt, incoming.observedAt].filter(Boolean).sort()[0] || preferred.observedAt;
    return { ...preferred, observedAt: firstObserved };
  }

  function arrayEqualsAt(haystack, needle, start) {
    if (start < 0 || start + needle.length > haystack.length) return false;
    for (let i = 0; i < needle.length; i += 1) {
      if (!messagesEquivalent(haystack[start + i], needle[i])) return false;
    }
    return true;
  }

  function findContiguous(haystack, needle) {
    if (needle.length === 0) return 0;
    for (let i = 0; i <= haystack.length - needle.length; i += 1) {
      if (arrayEqualsAt(haystack, needle, i)) return i;
    }
    return -1;
  }

  function reconcileWindow(existing, incoming) {
    if (!existing.length) return { relation: "initial", overlap: 0, merged: [...incoming] };
    if (!incoming.length) return { relation: "empty-window", overlap: 0, merged: [...existing] };

    const incomingInside = findContiguous(existing, incoming);
    if (incomingInside >= 0) {
      const merged = [...existing];
      for (let index = 0; index < incoming.length; index += 1) {
        merged[incomingInside + index] = preferredEquivalent(merged[incomingInside + index], incoming[index]);
      }
      return { relation: "already-contained", overlap: incoming.length, merged };
    }
    const existingInside = findContiguous(incoming, existing);
    if (existingInside >= 0) {
      const merged = [...incoming];
      for (let index = 0; index < existing.length; index += 1) {
        merged[existingInside + index] = preferredEquivalent(existing[index], merged[existingInside + index]);
      }
      return { relation: "expanded-window", overlap: existing.length, merged };
    }

    const limit = Math.min(existing.length, incoming.length);
    for (let size = limit; size >= 1; size -= 1) {
      if (arrayEqualsAt(existing, incoming.slice(incoming.length - size), 0)) {
        const aligned = existing.slice(0, size).map((message, index) => preferredEquivalent(message, incoming[incoming.length - size + index]));
        return {
          relation: "older-overlap",
          overlap: size,
          merged: [...incoming.slice(0, incoming.length - size), ...aligned, ...existing.slice(size)],
        };
      }
      if (arrayEqualsAt(incoming, existing.slice(existing.length - size), 0)) {
        const aligned = existing.slice(existing.length - size).map((message, index) => preferredEquivalent(message, incoming[index]));
        return {
          relation: "newer-overlap",
          overlap: size,
          merged: [...existing.slice(0, existing.length - size), ...aligned, ...incoming.slice(size)],
        };
      }
    }
    return { relation: "disjoint", overlap: 0, merged: [...existing] };
  }

  function reconcileLiveWindow(existing, incoming) {
    const ordinary = reconcileWindow(existing, incoming);
    if (ordinary.relation !== "disjoint" && ordinary.relation !== "regression") return ordinary;

    // 流式回复会让最后一条消息从“半句话”变成完整文本。寻找 incoming 的
    // 稳定前缀在 existing 尾部附近的位置，只替换那一小段尾巴，不把整窗
    // 当成缺口，也不做全局内容去重。
    for (let prefixLength = incoming.length - 1; prefixLength >= 1; prefixLength -= 1) {
      const prefix = incoming.slice(0, prefixLength);
      const index = findContiguous(existing, prefix);
      if (index < 0) continue;
      if (index + prefixLength < existing.length - 1) continue;
      return {
        relation: "live-tail-revision",
        overlap: prefixLength,
        revised: existing.length - (index + prefixLength),
        merged: [...existing.slice(0, index), ...incoming],
      };
    }
    return ordinary;
  }

  function fuzzyAdjacentOverlap(older, newer) {
    if (!older.length || !newer.length) return { relation: "disjoint", overlap: 0, merged: [...older] };
    const edgeLimit = 64;
    const olderStart = Math.max(0, older.length - edgeLimit);
    const newerEnd = Math.min(newer.length, edgeLimit);
    const left = older.slice(olderStart);
    const right = newer.slice(0, newerEnd);
    const rows = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
    for (let i = left.length - 1; i >= 0; i -= 1) {
      for (let j = right.length - 1; j >= 0; j -= 1) {
        rows[i][j] = messagesEquivalent(left[i], right[j])
          ? rows[i + 1][j + 1] + 1
          : Math.max(rows[i + 1][j], rows[i][j + 1]);
      }
    }
    const overlap = rows[0][0];
    const ratio = overlap / Math.max(1, Math.min(left.length, right.length));
    if (overlap < 3 || ratio < 0.55) return { relation: "disjoint", overlap: 0, merged: [...older] };
    if (newerEnd === newer.length && overlap === right.length) {
      return { relation: "fuzzy-newer-contained", overlap, overlapRatio: ratio, merged: [...older] };
    }

    const matches = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
      if (messagesEquivalent(left[i], right[j])) {
        matches.push([i, j]);
        i += 1;
        j += 1;
      } else if (rows[i + 1][j] >= rows[i][j + 1]) {
        i += 1;
      } else {
        j += 1;
      }
    }

    function preferredRevision(a, b) {
      const aLength = normalizeText(a.content ?? a.rawText).length;
      const bLength = normalizeText(b.content ?? b.rawText).length;
      return aLength <= bLength ? a : b;
    }

    function mergeUnmatched(a, b) {
      if (a.length && a.length === b.length && a.length <= 3
        && a.every((message, index) => String(message.role || "unknown") === String(b[index].role || "unknown"))) {
        return a.map((message, index) => preferredRevision(message, b[index]));
      }
      return [...a, ...b];
    }

    const commonSupersequence = [];
    let leftCursor = 0;
    let rightCursor = 0;
    for (const [leftIndex, rightIndex] of matches) {
      commonSupersequence.push(...mergeUnmatched(left.slice(leftCursor, leftIndex), right.slice(rightCursor, rightIndex)));
      commonSupersequence.push(preferredEquivalent(left[leftIndex], right[rightIndex]));
      leftCursor = leftIndex + 1;
      rightCursor = rightIndex + 1;
    }
    commonSupersequence.push(...mergeUnmatched(left.slice(leftCursor), right.slice(rightCursor)));
    return {
      relation: "fuzzy-adjacent-overlap",
      overlap,
      overlapRatio: ratio,
      merged: [...older.slice(0, olderStart), ...commonSupersequence, ...newer.slice(newerEnd)],
    };
  }

  function coalesceAdjacentSegments(state) {
    const sourceSegments = (state?.segments || []).filter((segment) => segment.length).map((segment) => [...segment]);
    if (sourceSegments.length < 2) return {
      ...(state || {}),
      segments: sourceSegments,
      gaps: [...(state?.gaps || [])],
      relations: [...(state?.relations || [])],
      repairs: { ...(state?.repairs || {}), attempted: false, mergedBoundaries: 0, unresolvedBoundaries: Math.max(0, sourceSegments.length - 1) },
    };

    const repaired = [];
    let current = sourceSegments[0];
    let mergedBoundaries = 0;
    let repairedOverlap = 0;
    const repairRelations = [];
    for (let index = 1; index < sourceSegments.length; index += 1) {
      const next = sourceSegments[index];
      let result = reconcileWindow(current, next);
      if (result.relation === "disjoint") result = fuzzyAdjacentOverlap(current, next);
      if (result.relation !== "disjoint") {
        current = result.merged;
        mergedBoundaries += 1;
        repairedOverlap += result.overlap;
        repairRelations.push(`repair:${result.relation}`);
      } else {
        repaired.push(current);
        current = next;
      }
    }
    repaired.push(current);
    const gaps = repaired.slice(1).map((_, index) => ({
      beforeSegment: index + 1,
      observedWindow: null,
      reason: "unresolved-after-adjacent-repair",
    }));
    return {
      ...(state || {}),
      segments: repaired,
      duplicateObservations: Number(state?.duplicateObservations || 0) + repairedOverlap,
      gaps,
      relations: [...(state?.relations || []), ...repairRelations],
      repairs: {
        ...(state?.repairs || {}),
        attempted: true,
        originalSegments: sourceSegments.length,
        mergedBoundaries,
        repairedOverlap,
        unresolvedBoundaries: gaps.length,
      },
    };
  }

  function mergeWindowIntoState(state, incoming, direction) {
    const next = {
      segments: (state?.segments || []).map((segment) => [...segment]),
      observedWindows: Number(state?.observedWindows || 0) + 1,
      observedMessages: Number(state?.observedMessages || 0) + incoming.length,
      duplicateObservations: Number(state?.duplicateObservations || 0),
      gaps: [...(state?.gaps || [])],
      relations: [...(state?.relations || [])],
      repairs: state?.repairs || null,
    };
    if (!incoming.length) return next;
    if (!next.segments.length) {
      next.segments.push([...incoming]);
      next.relations.push("initial");
      return next;
    }

    let best = null;
    for (let i = 0; i < next.segments.length; i += 1) {
      const result = reconcileWindow(next.segments[i], incoming);
      if (result.relation !== "disjoint" && (!best || result.overlap > best.result.overlap)) {
        best = { index: i, result };
      }
    }
    if (best) {
      next.segments[best.index] = best.result.merged;
      next.duplicateObservations += best.result.overlap;
      next.relations.push(best.result.relation);
      return next;
    }

    if (direction === "older") {
      const fuzzy = fuzzyAdjacentOverlap(incoming, next.segments[0]);
      if (fuzzy.relation !== "disjoint") {
        next.segments[0] = fuzzy.merged;
        next.duplicateObservations += fuzzy.overlap;
        next.relations.push(fuzzy.relation);
        return next;
      }
    } else {
      const fuzzy = fuzzyAdjacentOverlap(next.segments.at(-1), incoming);
      if (fuzzy.relation !== "disjoint") {
        next.segments[next.segments.length - 1] = fuzzy.merged;
        next.duplicateObservations += fuzzy.overlap;
        next.relations.push(fuzzy.relation);
        return next;
      }
    }

    if (direction === "older") next.segments.unshift([...incoming]);
    else next.segments.push([...incoming]);
    next.gaps.push({
      beforeSegment: direction === "older" ? 1 : next.segments.length - 1,
      observedWindow: next.observedWindows,
      reason: "no-overlap-between-windows",
    });
    next.relations.push("disjoint");
    return next;
  }

  function mergeLiveWindowIntoState(state, incoming) {
    const next = {
      segments: (state?.segments || []).map((segment) => [...segment]),
      observedWindows: Number(state?.observedWindows || 0) + 1,
      observedMessages: Number(state?.observedMessages || 0) + incoming.length,
      duplicateObservations: Number(state?.duplicateObservations || 0),
      gaps: [...(state?.gaps || [])],
      relations: [...(state?.relations || [])],
      repairs: state?.repairs || null,
    };
    if (!incoming.length) return next;
    if (!next.segments.length) {
      next.segments.push([...incoming]);
      next.relations.push("initial-live-window");
      return next;
    }

    let best = null;
    for (let i = 0; i < next.segments.length; i += 1) {
      const result = reconcileLiveWindow(next.segments[i], incoming);
      if (result.relation !== "disjoint" && result.relation !== "regression" && (!best || result.overlap > best.result.overlap)) {
        best = { index: i, result };
      }
    }
    if (best) {
      next.segments[best.index] = best.result.merged;
      next.duplicateObservations += best.result.overlap;
      next.relations.push(best.result.relation);
      return next;
    }

    const fuzzy = fuzzyAdjacentOverlap(next.segments.at(-1), incoming);
    if (fuzzy.relation !== "disjoint") {
      next.segments[next.segments.length - 1] = fuzzy.merged;
      next.duplicateObservations += fuzzy.overlap;
      next.relations.push(`live:${fuzzy.relation}`);
      return next;
    }

    next.segments.push([...incoming]);
    next.gaps.push({ beforeSegment: next.segments.length - 1, observedWindow: next.observedWindows, reason: "live-window-has-no-overlap" });
    next.relations.push("disjoint-live-window");
    return next;
  }

  function flattenState(state) {
    return (state?.segments || []).flatMap((segment, segmentIndex) =>
      segment.map((message, indexInSegment) => ({ ...message, segmentIndex, indexInSegment }))
    );
  }

  async function sequenceHash(messages) {
    return sha256Hex(messages.map(tokenOf).join("\n"));
  }

  function safeFilename(value) {
    const result = normalizeText(value)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return result || "未命名会话";
  }

  function localCompactTimestamp(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "时间未知";
    const pad = (number) => String(number).padStart(2, "0");
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
      "-",
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds()),
    ].join("");
  }

  function buildExportFilename({ platform, displayName, completedAt, messageCount, extension = "json" }) {
    const safePlatform = safeFilename(platform || "未知平台");
    const safeName = safeFilename(displayName || "未命名房间");
    const stamp = localCompactTimestamp(completedAt);
    const count = Number.isInteger(messageCount) && messageCount >= 0 ? `${messageCount}条` : "条数未知";
    const safeExtension = /^[a-z0-9]{1,8}$/i.test(extension) ? extension.toLowerCase() : "json";
    return `${safePlatform}__${safeName}__采集至${stamp}__${count}.${safeExtension}`;
  }

  function classifySourceTime(value) {
    const text = normalizeText(value);
    if (!text) return { precision: "unknown", eventTime: null, contextRequired: true };
    if (/^\d{13}$/.test(text)) {
      const date = new Date(Number(text));
      return { precision: "millisecond", eventTime: Number.isNaN(date.getTime()) ? null : date.toISOString(), contextRequired: false };
    }
    if (/^\d{10}$/.test(text)) {
      const date = new Date(Number(text) * 1000);
      return { precision: "second", eventTime: Number.isNaN(date.getTime()) ? null : date.toISOString(), contextRequired: false };
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      return { precision: "day", eventTime: null, contextRequired: false };
    }
    if (/^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(text)) {
      const date = new Date(text);
      const precision = /:\d{2}(?:\.\d+)?(?:Z|[+-])/.test(text) ? "second" : "minute";
      return { precision, eventTime: Number.isNaN(date.getTime()) ? null : date.toISOString(), contextRequired: false };
    }
    if (/^(?:今天|昨天|前天)\s*\d{1,2}:\d{2}(?::\d{2})?$/.test(text) || /^\d{1,2}:\d{2}(?::\d{2})?$/.test(text)) {
      return { precision: "time-of-day", eventTime: null, contextRequired: true };
    }
    return { precision: "unparsed", eventTime: null, contextRequired: true };
  }

  function buildTimeEvidence({ sourceTimestamp, observedAt }) {
    const firstObservedAt = normalizeText(observedAt) || null;
    const rawValue = normalizeText(sourceTimestamp?.value);
    if (!rawValue) {
      return Object.freeze({
        kind: "observed-upper-bound",
        originalValue: null,
        eventTime: null,
        precision: "upper-bound-only",
        source: "page-observation",
        confidence: "bounded",
        contextRequired: false,
        firstObservedAt,
        lowerBound: null,
        upperBound: firstObservedAt,
      });
    }
    const classified = classifySourceTime(rawValue);
    return Object.freeze({
      kind: "platform-time-candidate",
      originalValue: rawValue,
      eventTime: classified.eventTime,
      precision: classified.precision,
      source: normalizeText(sourceTimestamp?.source) || "page-time-metadata",
      confidence: classified.eventTime ? "high" : classified.precision === "day" ? "day-level" : "context-needed",
      contextRequired: classified.contextRequired,
      firstObservedAt,
      lowerBound: classified.eventTime,
      upperBound: classified.eventTime || firstObservedAt,
    });
  }

  return Object.freeze({
    normalizeText,
    sha256Hex,
    fingerprintMessage,
    reconcileWindow,
    reconcileLiveWindow,
    fuzzyAdjacentOverlap,
    coalesceAdjacentSegments,
    mergeWindowIntoState,
    mergeLiveWindowIntoState,
    flattenState,
    sequenceHash,
    safeFilename,
    localCompactTimestamp,
    buildExportFilename,
    classifySourceTime,
    buildTimeEvidence,
  });
});
