(function (root, factory) {
  "use strict";
  const Core = typeof module === "object" && module.exports
    ? require("./shared-core.js")
    : root.WebMemoryFerryCore;
  const api = factory(Core);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.WebMemoryFerryExport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core) {
  "use strict";

  const formatNames = { json: "JSON", md: "Markdown", txt: "纯文本" };
  const mimeTypes = {
    json: "application/json;charset=utf-8",
    md: "text/markdown;charset=utf-8",
    txt: "text/plain;charset=utf-8",
  };
  const roleNames = {
    user: "用户",
    assistant: "AI 助手",
    system: "系统",
    tool: "工具",
    unknown: "角色未识别",
  };

  function clean(value) {
    return String(value ?? "").replace(/\r\n?/g, "\n").trim();
  }

  function selectedFormat(value) {
    return Object.hasOwn(formatNames, value) ? value : "json";
  }

  function readableInstant(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return clean(value) || "时间未知";
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
  }

  function roomCode(snapshot) {
    return String(snapshot?.roomKey || "").split(":").at(-1).slice(0, 8) || "未知";
  }

  function snapshotManifest(snapshot) {
    return {
      snapshotId: snapshot.snapshotId,
      predecessorSnapshotId: snapshot.predecessorSnapshotId,
      roomKey: snapshot.roomKey,
      roomCode: roomCode(snapshot),
      platform: snapshot.platform,
      authorityStatus: snapshot.authorityStatus,
      title: snapshot.title,
      startedAt: snapshot.startedAt,
      completedAt: snapshot.completedAt,
      status: snapshot.status,
      messageCount: snapshot.messageCount,
      sequenceHash: snapshot.sequenceHash,
      evidence: snapshot.evidence,
      rawIncluded: true,
      normalizedIncluded: true,
    };
  }

  function snapshotJsonPayload(snapshot, exportedAt) {
    return {
      exportSchemaVersion: "web-memory-ferry/export-v1",
      exportedAt,
      manifest: snapshotManifest(snapshot),
      raw: snapshot.raw,
      normalized: snapshot.normalized,
    };
  }

  function pageTime(message) {
    const raw = clean(message?.sourceTimestamp?.value);
    const eventTime = clean(message?.timeEvidence?.eventTime);
    if (eventTime) {
      const rawSuffix = raw && raw !== eventTime ? `；网页原始标记：${raw}` : "";
      return `对话时间：${readableInstant(eventTime)}${rawSuffix}`;
    }
    if (raw) return `网页时间标记：${raw}（信息不足，未补造日期）`;
    return "对话时间：网页未提供";
  }

  function observedTime(message) {
    const observed = message?.observedAt
      || message?.timeEvidence?.firstObservedAt
      || message?.timeEvidence?.upperBound;
    return `首次抓取：${readableInstant(observed)}`;
  }

  function completeness(snapshot) {
    const evidence = snapshot?.evidence || {};
    const top = evidence.topConfirmed ? "页面已稳定到顶" : "未确认到顶";
    const segments = Number(evidence.segmentCount || 0);
    const gaps = Array.isArray(evidence.gaps) ? evidence.gaps.length : 0;
    return `${top}；${segments} 段；${gaps} 个待复核缺口`;
  }

  function markdownMessages(snapshot, headingLevel) {
    const marker = "#".repeat(Math.max(2, headingLevel));
    const thinkingMarker = "#".repeat(Math.max(3, headingLevel + 1));
    return (snapshot.normalized || []).map((message, index) => {
      const content = clean(message.content) || "（空消息）";
      const thinking = clean(message.thinking);
      return [
        `${marker} ${index + 1} · ${roleNames[message.role] || message.role || roleNames.unknown}`,
        "",
        `- ${pageTime(message)}`,
        `- ${observedTime(message)}`,
        "",
        content,
        thinking ? `\n${thinkingMarker} 思考内容\n\n${thinking}` : "",
      ].filter(Boolean).join("\n");
    }).join("\n\n---\n\n");
  }

  function snapshotMarkdown(snapshot, platformLabel, headingLevel = 1) {
    const heading = "#".repeat(Math.max(1, headingLevel));
    const messageHeading = Math.max(2, headingLevel + 1);
    return [
      `${heading} 归笺｜${clean(snapshot.title) || "未命名会话"}`,
      "",
      `- 平台：${clean(platformLabel) || clean(snapshot.platform) || "未知平台"}`,
      `- 房间编号：${roomCode(snapshot)}`,
      `- 消息数：${Number(snapshot.messageCount || snapshot.normalized?.length || 0)} 条`,
      `- 归笺完成：${readableInstant(snapshot.completedAt)}`,
      `- 完整性证据：${completeness(snapshot)}`,
      "- 时间说明：有“对话时间”表示网页提供了可解析时间；只有“首次抓取”不代表消息实际发生在抓取时。",
      "",
      markdownMessages(snapshot, messageHeading),
    ].join("\n").trim();
  }

  function textMessages(snapshot) {
    return (snapshot.normalized || []).map((message, index) => {
      const content = clean(message.content) || "（空消息）";
      const thinking = clean(message.thinking);
      return [
        `[${index + 1}] ${roleNames[message.role] || message.role || roleNames.unknown}`,
        pageTime(message),
        observedTime(message),
        "正文：",
        content,
        thinking ? `思考内容：\n${thinking}` : "",
      ].filter(Boolean).join("\n");
    }).join("\n\n----------------------------------------\n\n");
  }

  function snapshotText(snapshot, platformLabel) {
    return [
      `归笺｜${clean(snapshot.title) || "未命名会话"}`,
      `平台：${clean(platformLabel) || clean(snapshot.platform) || "未知平台"}`,
      `房间编号：${roomCode(snapshot)}`,
      `消息数：${Number(snapshot.messageCount || snapshot.normalized?.length || 0)} 条`,
      `归笺完成：${readableInstant(snapshot.completedAt)}`,
      `完整性证据：${completeness(snapshot)}`,
      "时间说明：有“对话时间”表示网页提供了可解析时间；只有“首次抓取”不代表消息实际发生在抓取时。",
      "",
      "========================================",
      "",
      textMessages(snapshot),
    ].join("\n").trim();
  }

  function buildSnapshotDownload(snapshot, options = {}) {
    const format = selectedFormat(options.format);
    const exportedAt = options.exportedAt || new Date().toISOString();
    const platformLabel = options.platformLabel || snapshot.platform;
    let body;
    if (format === "json") body = JSON.stringify(snapshotJsonPayload(snapshot, exportedAt), null, 2);
    else if (format === "md") body = snapshotMarkdown(snapshot, platformLabel);
    else body = snapshotText(snapshot, platformLabel);
    return { format, formatName: formatNames[format], extension: format, mimeType: mimeTypes[format], body };
  }

  function buildLatestBundleDownload(snapshots, options = {}) {
    const format = selectedFormat(options.format);
    const exportedAt = options.exportedAt || new Date().toISOString();
    const labels = options.platformLabels || {};
    let body;
    if (format === "json") {
      body = JSON.stringify({
        exportSchemaVersion: "web-memory-ferry/latest-rooms-bundle-v1",
        exportedAt,
        roomCount: snapshots.length,
        snapshots,
      }, null, 2);
    } else if (format === "md") {
      body = [
        "# 归笺｜全部最新房间",
        "",
        `- 导出时间：${readableInstant(exportedAt)}`,
        `- 房间数：${snapshots.length}`,
        "",
        snapshots.map((snapshot) => snapshotMarkdown(snapshot, labels[snapshot.platform] || snapshot.platform, 2)).join("\n\n***\n\n"),
      ].join("\n").trim();
    } else {
      body = [
        "归笺｜全部最新房间",
        `导出时间：${readableInstant(exportedAt)}`,
        `房间数：${snapshots.length}`,
        "",
        snapshots.map((snapshot) => snapshotText(snapshot, labels[snapshot.platform] || snapshot.platform)).join("\n\n########################################\n\n"),
      ].join("\n").trim();
    }
    return { format, formatName: formatNames[format], extension: format, mimeType: mimeTypes[format], body };
  }

  return {
    formatNames,
    buildSnapshotDownload,
    buildLatestBundleDownload,
  };
});
