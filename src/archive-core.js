(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.WebMemoryFerryArchiveCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function latestSnapshots(snapshots) {
    const latest = new Map();
    for (const snapshot of snapshots || []) {
      if (!snapshot?.roomKey) continue;
      const prior = latest.get(snapshot.roomKey);
      if (!prior || String(snapshot.completedAt || "").localeCompare(String(prior.completedAt || "")) > 0) {
        latest.set(snapshot.roomKey, snapshot);
      }
    }
    return Array.from(latest.values()).sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || "")));
  }

  function searchableText(snapshot) {
    const messages = Array.isArray(snapshot?.normalized) ? snapshot.normalized : [];
    return [
      snapshot?.title || "",
      snapshot?.platform || "",
      ...messages.flatMap((message) => [message?.content || "", message?.thinking || ""]),
    ].join("\n").toLocaleLowerCase();
  }

  function queryTokens(query) {
    return String(query || "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  }

  function summarizeSnapshots(snapshots, { query = "", todayStartIso = "" } = {}) {
    const all = Array.isArray(snapshots) ? snapshots : [];
    const latest = latestSnapshots(all);
    const byRoom = new Map();
    for (const snapshot of all) {
      if (!snapshot?.roomKey) continue;
      if (!byRoom.has(snapshot.roomKey)) byRoom.set(snapshot.roomKey, []);
      byRoom.get(snapshot.roomKey).push(snapshot);
    }

    const tokens = queryTokens(query);
    const rooms = [];
    const platforms = {};
    let totalMessages = 0;
    let todayIngested = 0;

    for (const snapshot of latest) {
      totalMessages += Number(snapshot.messageCount || 0);
      const platform = String(snapshot.platform || "unknown");
      if (!platforms[platform]) platforms[platform] = { rooms: 0, messages: 0 };
      platforms[platform].rooms += 1;
      platforms[platform].messages += Number(snapshot.messageCount || 0);

      if (todayStartIso && String(snapshot.completedAt || "") >= todayStartIso) {
        const history = byRoom.get(snapshot.roomKey) || [];
        const baseline = history
          .filter((item) => String(item.completedAt || "") < todayStartIso)
          .sort((a, b) => String(b.completedAt || "").localeCompare(String(a.completedAt || "")))[0];
        todayIngested += Math.max(0, Number(snapshot.messageCount || 0) - Number(baseline?.messageCount || 0));
      }

      const haystack = tokens.length ? searchableText(snapshot) : "";
      if (tokens.length && !tokens.every((token) => haystack.includes(token))) continue;
      const titleText = String(snapshot.title || "").toLocaleLowerCase();
      rooms.push({
        roomKey: snapshot.roomKey,
        roomCode: String(snapshot.roomKey).split(":").at(-1).slice(0, 8),
        snapshotId: snapshot.snapshotId,
        platform,
        title: snapshot.title || "未命名会话",
        messageCount: Number(snapshot.messageCount || 0),
        completedAt: snapshot.completedAt || null,
        status: snapshot.status || "unknown",
        authorityStatus: snapshot.authorityStatus || "web-capture",
        segmentCount: Number(snapshot.evidence?.segmentCount || snapshot.raw?.segments?.length || 0),
        gapCount: Array.isArray(snapshot.evidence?.gaps) ? snapshot.evidence.gaps.length : 0,
        matchKind: tokens.length && tokens.some((token) => !titleText.includes(token)) ? "content" : "title",
      });
    }

    return {
      totalRooms: latest.length,
      totalMessages,
      totalSnapshots: all.length,
      todayIngested,
      matchedRooms: rooms.length,
      platforms,
      rooms,
    };
  }

  return Object.freeze({ latestSnapshots, summarizeSnapshots });
});
