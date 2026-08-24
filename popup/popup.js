(function () {
  "use strict";

  const Core = globalThis.WebMemoryFerryCore;
  const ExportCore = globalThis.WebMemoryFerryExport;
  const exportFormatKey = "guijian.exportFormat";
  const labels = { kimi: "Kimi", chatgpt: "ChatGPT", deepseek: "DeepSeek", gemini: "Gemini", claude: "Claude", yuanbao: "腾讯元宝", doubao: "豆包", qianwen: "千问", synthetic: "本地测试" };
  const els = {
    totalRooms: document.getElementById("totalRooms"),
    totalMessages: document.getElementById("totalMessages"),
    todayIngested: document.getElementById("todayIngested"),
    platforms: document.getElementById("platforms"),
    resultMeta: document.getElementById("resultMeta"),
    roomList: document.getElementById("roomList"),
    emptyState: document.getElementById("emptyState"),
    notice: document.getElementById("notice"),
    searchInput: document.getElementById("searchInput"),
    settingsButton: document.getElementById("settingsButton"),
    settingsPanel: document.getElementById("settingsPanel"),
    storageText: document.getElementById("storageText"),
    storageFill: document.getElementById("storageFill"),
    exportAllButton: document.getElementById("exportAllButton"),
    exportFormatSelect: document.getElementById("exportFormatSelect"),
    refreshButton: document.getElementById("refreshButton"),
  };
  let queryTimer = null;
  let deleteArmed = null;

  function send(message) {
    return new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: "E-RUNTIME" });
      else resolve(response || { ok: false, error: "E-NO-RESPONSE" });
    }));
  }

  function formatCount(value) { return new Intl.NumberFormat("zh-CN").format(Number(value || 0)); }
  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "时间未知";
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }
  function notice(text, error) {
    els.notice.textContent = text || "";
    els.notice.style.color = error ? "#9b4b43" : "#4c6652";
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  async function refreshStorage() {
    try {
      const estimate = await navigator.storage.estimate();
      const usage = Number(estimate.usage || 0);
      const quota = Number(estimate.quota || 0);
      els.storageText.textContent = `${formatBytes(usage)} / ${formatBytes(quota)}`;
      const percent = quota ? Math.min(100, usage / quota * 100) : 0;
      els.storageFill.style.width = `${percent}%`;
    } catch (_) {
      els.storageText.textContent = "浏览器未提供估算";
    }
  }

  function renderRooms(summary) {
    els.totalRooms.textContent = formatCount(summary.totalRooms);
    els.totalMessages.textContent = formatCount(summary.totalMessages);
    els.todayIngested.textContent = formatCount(summary.todayIngested);
    els.platforms.innerHTML = Object.entries(summary.platforms || {}).map(([platform, stats]) =>
      `<span class="chip">${escapeHtml(labels[platform] || platform)} · ${formatCount(stats.rooms)} 房 / ${formatCount(stats.messages)} 条</span>`
    ).join("");
    els.resultMeta.textContent = els.searchInput.value.trim()
      ? `找到 ${formatCount(summary.matchedRooms)} 个房间；正文命中只显示房间，不展示私密片段`
      : `共 ${formatCount(summary.totalSnapshots)} 份不可覆盖快照；列表显示每房最新一份`;
    els.emptyState.hidden = summary.rooms.length > 0;
    els.roomList.innerHTML = summary.rooms.map((room) => `
      <article class="room-card" data-room-key="${escapeHtml(room.roomKey)}">
        <div class="room-head">
          <div class="room-title">
            <strong title="${escapeHtml(room.title)}">${escapeHtml(room.title)}</strong>
            <span>房间编号 ${escapeHtml(room.roomCode)}${room.matchKind === "content" ? " · 正文命中" : ""}</span>
          </div>
          <span class="badge">${escapeHtml(labels[room.platform] || room.platform)}</span>
        </div>
        <div class="room-meta">
          <span>${formatCount(room.messageCount)} 条</span>
          <span>${formatCount(room.segmentCount)} 段</span>
          <span>最后归笺 ${escapeHtml(formatTime(room.completedAt))}</span>
          ${room.gapCount ? `<span class="warning">${formatCount(room.gapCount)} 个待复核缺口</span>` : ""}
        </div>
        <div class="room-actions">
          <button type="button" data-action="export" data-snapshot-id="${escapeHtml(room.snapshotId)}">导出本房</button>
          <button type="button" class="delete" data-action="delete" data-room-key="${escapeHtml(room.roomKey)}">移除本房记录</button>
        </div>
      </article>`).join("");
  }

  async function loadSummary() {
    notice("正在翻阅本地归笺…");
    const response = await send({ type: "archive.summary", query: els.searchInput.value });
    if (!response?.ok) {
      notice("本地记录暂时读不到，重新加载扩展后再试", true);
      return;
    }
    renderRooms(response.value);
    notice("");
    await refreshStorage();
  }

  function selectedExportFormat() {
    return ["json", "md", "txt"].includes(els.exportFormatSelect.value) ? els.exportFormatSelect.value : "json";
  }

  function downloadDocument(download, filename) {
    const url = URL.createObjectURL(new Blob([download.body], { type: download.mimeType }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportSnapshot(snapshotId) {
    notice("正在整理本房归笺…");
    const response = await send({ type: "archive.snapshot.get", snapshotId });
    if (!response?.ok || !response.value) return void notice("没有找到这份快照", true);
    const snapshot = response.value;
    const download = ExportCore.buildSnapshotDownload(snapshot, {
      format: selectedExportFormat(),
      platformLabel: labels[snapshot.platform] || snapshot.platform,
    });
    downloadDocument(download, Core.buildExportFilename({
      platform: labels[snapshot.platform] || snapshot.platform,
      displayName: snapshot.title,
      completedAt: snapshot.completedAt,
      messageCount: snapshot.messageCount,
      extension: download.extension,
    }));
    notice(`已导出“${snapshot.title || "未命名会话"}”的 ${download.formatName}`);
  }

  async function exportAll() {
    notice("正在整理全部房间的最新归笺…");
    els.exportAllButton.disabled = true;
    try {
      const response = await send({ type: "archive.latest.all" });
      if (!response?.ok) return void notice("全部记录读取失败", true);
      const completedAt = new Date().toISOString();
      const download = ExportCore.buildLatestBundleDownload(response.value, {
        format: selectedExportFormat(),
        exportedAt: completedAt,
        platformLabels: labels,
      });
      downloadDocument(download, `归笺__全部最新房间__${Core.localCompactTimestamp(completedAt)}.${download.extension}`);
      notice(`已带回 ${response.value.length} 个房间的最新归笺 · ${download.formatName}`);
    } finally { els.exportAllButton.disabled = false; }
  }

  async function deleteRoom(button) {
    const roomKey = button.dataset.roomKey;
    if (deleteArmed !== roomKey) {
      deleteArmed = roomKey;
      button.textContent = "再点一次，确认移除";
      button.classList.add("confirm-delete");
      setTimeout(() => {
        if (deleteArmed !== roomKey) return;
        deleteArmed = null;
        button.textContent = "移除本房记录";
        button.classList.remove("confirm-delete");
      }, 5000);
      return;
    }
    deleteArmed = null;
    button.disabled = true;
    const response = await send({ type: "archive.room.delete", roomKey });
    if (!response?.ok) return void notice("移除失败，记录仍好好保留着", true);
    await loadSummary();
    notice(`已移除本房的 ${response.value.deletedSnapshots} 份本地快照`);
  }

  els.settingsButton.addEventListener("click", () => {
    els.settingsPanel.hidden = !els.settingsPanel.hidden;
    if (!els.settingsPanel.hidden) void refreshStorage();
  });
  els.refreshButton.addEventListener("click", () => void loadSummary());
  els.exportAllButton.addEventListener("click", () => void exportAll());
  els.exportFormatSelect.value = localStorage.getItem(exportFormatKey) || "json";
  els.exportFormatSelect.addEventListener("change", () => {
    localStorage.setItem(exportFormatKey, selectedExportFormat());
    notice(`以后默认导出 ${ExportCore.formatNames[selectedExportFormat()]}`);
  });
  els.searchInput.addEventListener("input", () => {
    clearTimeout(queryTimer);
    queryTimer = setTimeout(() => void loadSummary(), 250);
  });
  els.roomList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    if (button.dataset.action === "export") void exportSnapshot(button.dataset.snapshotId);
    if (button.dataset.action === "delete") void deleteRoom(button);
  });

  void loadSummary();
})();
