(function () {
  "use strict";

  const Core = window.WebMemoryFerryCore;
  const defaults = { intervalMs: 1200, stepRatio: 0.6, stableNeeded: 15, confirmRounds: 4, quietMs: 3000, maxRounds: 1500, maxMs: 30 * 60 * 1000 };
  const localTest = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) ? window.__WMF_TEST_CONFIG__ : null;
  const CONFIG = Object.freeze({ ...defaults, ...(localTest || {}) });

  function explicitRole(node) {
    const candidates = [node, ...node.querySelectorAll("[data-message-author-role],[data-role],[role]")];
    for (const item of candidates) {
      const value = String(item.getAttribute("data-message-author-role") || item.getAttribute("data-role") || "").toLowerCase();
      if (["user", "human"].includes(value)) return { role: "user", source: "attribute", confidence: "high" };
      if (["assistant", "bot", "model", "ai"].includes(value)) return { role: "assistant", source: "attribute", confidence: "high" };
    }
    const tokens = `${node.className || ""} ${Array.from(node.querySelectorAll("[class]")).slice(0, 40).map((item) => item.className || "").join(" ")}`.toLowerCase();
    if (/(^|[\s_-])(user|human|mine|self)([\s_-]|$)/.test(tokens)) return { role: "user", source: "class-token", confidence: "medium" };
    if (/(^|[\s_-])(assistant|bot|model|ai)([\s_-]|$)/.test(tokens)) return { role: "assistant", source: "class-token", confidence: "medium" };
    return { role: "unknown", source: "unresolved", confidence: "none" };
  }

  function sourceTimestamp(node) {
    const time = node.querySelector("time[datetime]");
    if (time) return { value: time.getAttribute("datetime"), source: "time.datetime" };
    const nodes = [node, ...node.querySelectorAll("[data-time],[data-timestamp],[datetime]")];
    for (const item of nodes) {
      for (const name of ["data-time", "data-timestamp", "datetime"]) {
        const value = item.getAttribute?.(name);
        if (value) return { value: String(value).slice(0, 120), source: `attr:${name}` };
      }
    }
    return null;
  }

  function thinkingText(node) {
    const found = Array.from(node.querySelectorAll('[class*="think" i],[class*="reason" i],[data-testid*="think" i],[data-testid*="reason" i]'));
    const unique = [];
    for (const item of found) {
      if (found.some((parent) => parent !== item && parent.contains(item))) continue;
      const text = Core.normalizeText(item.innerText);
      if (text && !unique.includes(text)) unique.push(text);
    }
    return unique.join("\n\n");
  }

  function normalizedContentText(node, rawText) {
    if (typeof node.cloneNode !== "function") return rawText;
    const clone = node.cloneNode(true);
    const thinkingNodes = Array.from(clone.querySelectorAll('[class*="think" i],[class*="reason" i],[data-testid*="think" i],[data-testid*="reason" i]'));
    for (const item of thinkingNodes) {
      if (thinkingNodes.some((parent) => parent !== item && parent.contains(item))) continue;
      item.remove();
    }
    for (const item of clone.querySelectorAll('button,[role="button"]')) item.remove();
    const cleaned = Core.normalizeText(clone.innerText);
    if (!cleaned || (rawText.length >= 80 && cleaned.length < rawText.length * 0.02)) return rawText;
    return cleaned;
  }

  function inferWindowRoles(messages) {
    for (const message of messages) {
      if (message.role === "unknown" && message.thinkingText) {
        message.role = "assistant";
        message.roleEvidence = { source: "thinking-region", confidence: "high" };
      }
    }
    const parityVotes = messages.flatMap((message, index) => {
      if (message.role === "assistant") return [index % 2];
      if (message.role === "user") return [1 - (index % 2)];
      return [];
    });
    if (parityVotes.length < 2 || parityVotes.some((value) => value !== parityVotes[0])) return messages;
    const assistantParity = parityVotes[0];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role !== "unknown") continue;
      message.role = index % 2 === assistantParity ? "assistant" : "user";
      message.roleEvidence = { source: "alternating-window-anchors", confidence: "medium" };
    }
    return messages;
  }

  async function extractWindow(plan, observedAt) {
    const nodes = plan.getMessages().filter((node) => node instanceof Element && node.isConnected);
    const result = [];
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const rawText = Core.normalizeText(node.innerText);
      if (!rawText) continue;
      const roleInfo = explicitRole(node);
      const timestamp = sourceTimestamp(node);
      const thinking = thinkingText(node);
      const message = {
        observedIndex: index,
        role: roleInfo.role,
        roleEvidence: { source: roleInfo.source, confidence: roleInfo.confidence },
        rawText,
        content: normalizedContentText(node, rawText),
        thinkingText: thinking,
        sourceTimestamp: timestamp,
        observedAt,
        timeEvidence: Core.buildTimeEvidence({ sourceTimestamp: timestamp, observedAt }),
      };
      result.push(message);
    }
    inferWindowRoles(result);
    for (const message of result) message.fingerprint = await Core.fingerprintMessage(message);
    return result;
  }

  function emptyState() {
    return { segments: [], observedWindows: 0, observedMessages: 0, duplicateObservations: 0, gaps: [], relations: [] };
  }

  async function buildArchiveSnapshot({
    profile, roomKey, roomUrl, title, startedAt, completedAt, status,
    state, predecessorSnapshotId, topConfirmed, domQuietConfirmed, planSource,
  }) {
    const messages = Core.flattenState(state);
    const seqHash = await Core.sequenceHash(messages);
    const timeEvidenceStats = messages.reduce((stats, message) => {
      const key = message.timeEvidence?.kind || "unknown";
      stats[key] = (stats[key] || 0) + 1;
      return stats;
    }, {});
    const snapshotId = await Core.sha256Hex(`${roomKey}\0${completedAt}\0${seqHash}`);
    return {
      schemaVersion: "web-memory-ferry/snapshot-v1",
      snapshotId,
      predecessorSnapshotId: predecessorSnapshotId || null,
      roomKey,
      platform: profile.id,
      authorityStatus: profile.authorityStatus || "web-capture",
      roomUrl,
      title,
      startedAt,
      completedAt,
      status,
      messageCount: messages.length,
      sequenceHash: seqHash,
      evidence: {
        topConfirmed: Boolean(topConfirmed),
        domQuietConfirmed: Boolean(domQuietConfirmed),
        absoluteCompletenessProven: false,
        observedWindows: state.observedWindows,
        observedMessages: state.observedMessages,
        duplicateObservations: state.duplicateObservations,
        gaps: state.gaps,
        segmentCount: state.segments.length,
        repairs: state.repairs || null,
        roleWarnings: messages.filter((item) => item.role === "unknown").length,
        timeEvidenceStats,
        planSource,
      },
      raw: { segments: state.segments },
      normalized: messages.map((message, index) => ({
        index,
        role: message.role,
        roleEvidence: message.roleEvidence,
        content: Core.normalizeText(message.content),
        thinking: Core.normalizeText(message.thinkingText),
        sourceTimestamp: message.sourceTimestamp,
        timeEvidence: message.timeEvidence || Core.buildTimeEvidence({ sourceTimestamp: message.sourceTimestamp, observedAt: message.observedAt }),
        provenanceStatus: profile.authorityStatus || "web-capture",
        observedAt: message.observedAt,
        contentHash: message.fingerprint,
        segmentIndex: message.segmentIndex,
      })),
    };
  }

  class FerryRun {
    constructor({ profile, roomKey, roomUrl, title, plan, onUpdate }) {
      this.profile = profile;
      this.roomKey = roomKey;
      this.roomUrl = roomUrl;
      this.title = title;
      this.plan = plan;
      this.onUpdate = onUpdate || (() => {});
      this.status = "idle";
      this.state = emptyState();
      this.startedAt = null;
      this.round = 0;
      this.stableCount = 0;
      this.confirmCount = 0;
      this.lastHeight = null;
      this.nudgedAtHeight = null;
      this.lastMutationAt = 0;
      this.mutationCount = 0;
      this.timer = null;
      this.observer = null;
      this.routeAtStart = location.href;
      this.finishing = false;
      this.predecessorSnapshotId = null;
      this.boundVisibility = () => {
        if (document.hidden) {
          void this.saveCheckpoint({ runningWhileHidden: true });
          this.emit({ runningWhileHidden: true });
        } else if (this.status === "running" && !this.timer && !this.finishing) {
          this.timer = setTimeout(() => this.tick(), 250);
          this.emit({ resumedFromHidden: true });
        }
      };
      this.boundPagehide = () => { void this.saveCheckpoint({ resumeAfterReload: true }); };
    }

    snapshotStatus(extra) {
      const messages = Core.flattenState(this.state);
      return {
        status: this.status,
        round: this.round,
        messageCount: messages.length,
        segmentCount: this.state.segments.length,
        gapCount: this.state.gaps.length,
        duplicateObservations: this.state.duplicateObservations,
        elapsedMs: this.startedAt ? Date.now() - Date.parse(this.startedAt) : 0,
        stableCount: this.stableCount,
        confirmCount: this.confirmCount,
        ...extra,
      };
    }

    emit(extra) { this.onUpdate(this.snapshotStatus(extra)); }

    async start(checkpoint) {
      if (this.status === "running") return;
      if (!this.plan?.scroller?.isConnected) throw new Error("E-SCROLLER");
      if (checkpoint?.state) this.state = checkpoint.state;
      this.predecessorSnapshotId = checkpoint?.snapshotId || checkpoint?.baseSnapshotId || null;
      this.status = "running";
      this.startedAt = new Date().toISOString();
      this.lastHeight = this.plan.scroller.scrollHeight;
      this.observer = new MutationObserver((records) => {
        this.mutationCount += records.length;
        this.lastMutationAt = Date.now();
      });
      this.observer.observe(this.plan.scroller, { childList: true, subtree: true });
      document.addEventListener("visibilitychange", this.boundVisibility, true);
      window.addEventListener("pagehide", this.boundPagehide, true);
      this.emit({ resumed: Boolean(checkpoint?.state) });
      await this.tick();
    }

    async capture() {
      const observedAt = new Date().toISOString();
      const windowMessages = await extractWindow(this.plan, observedAt);
      this.state = Core.mergeWindowIntoState(this.state, windowMessages, "older");
      return windowMessages.length;
    }

    async saveCheckpoint(extra) {
      await chrome.runtime.sendMessage({ type: "checkpoint.put", value: {
        schemaVersion: "web-memory-ferry/checkpoint-v1",
        roomKey: this.roomKey,
        profileId: this.profile.id,
        roomUrl: this.roomUrl,
        title: this.title,
        startedAt: this.startedAt,
        updatedAt: new Date().toISOString(),
        mode: "manual-backfill",
        resumeRequested: true,
        baseSnapshotId: this.predecessorSnapshotId,
        state: this.state,
        ...(extra || {}),
      } });
    }

    async tick() {
      if (this.status !== "running") return;
      try {
        if (location.href !== this.routeAtStart) return void this.stop("stopped-room-switch");
        if (!this.plan.scroller.isConnected) return void this.stop("stopped-scroller-replaced");
        if (Date.now() - Date.parse(this.startedAt) > CONFIG.maxMs) return void this.stop("stopped-timeout");
        if (this.round >= CONFIG.maxRounds) return void this.stop("stopped-max-rounds");

        this.round += 1;
        const captured = await this.capture();
        const scroller = this.plan.scroller;
        const atTop = scroller.scrollTop <= 2;
        const height = scroller.scrollHeight;
        const quiet = !this.lastMutationAt || Date.now() - this.lastMutationAt >= CONFIG.quietMs;
        if (atTop && height === this.lastHeight && quiet) this.stableCount += 1;
        else {
          this.stableCount = 0;
          this.confirmCount = 0;
          if (height !== this.lastHeight) this.nudgedAtHeight = null;
        }
        this.lastHeight = height;

        if (this.round === 1 || this.round % 5 === 0 || atTop) await this.saveCheckpoint();
        // 有些页面只有收到真实的顶部滚动事件才继续懒加载。每个新高度只做一次
        // 1px 轻触；若随后发生 DOM/高度变化，稳定计数会自动清零。
        if (atTop && this.nudgedAtHeight !== height) {
          this.nudgedAtHeight = height;
          scroller.scrollTop = 1;
          requestAnimationFrame(() => { if (scroller.isConnected) scroller.scrollTop = 0; });
          this.stableCount = 0;
          this.confirmCount = 0;
        }
        if (atTop && this.stableCount >= CONFIG.stableNeeded) {
          this.confirmCount += 1;
          if (this.confirmCount >= CONFIG.confirmRounds) return void this.finish("done-top", true);
        } else {
          scroller.scrollBy({ top: -Math.max(120, scroller.clientHeight * CONFIG.stepRatio), behavior: document.hidden ? "auto" : "smooth" });
        }
        if (this.status !== "running" || this.finishing) return;
        this.emit({ capturedThisWindow: captured });
        this.timer = setTimeout(() => this.tick(), CONFIG.intervalMs);
      } catch (_) {
        await this.finish("stopped-error", false);
      }
    }

    async stop(reason) {
      if (this.status !== "running" || this.finishing) return;
      await this.finish(reason || "stopped-by-user", false);
    }

    async finish(status, topConfirmed) {
      if (this.finishing) return;
      this.finishing = true;
      // 先退出 running，阻止正在等待采集/落盘的 tick 在停止后重新排定时器。
      this.status = status;
      clearTimeout(this.timer);
      this.timer = null;
      this.observer?.disconnect();
      document.removeEventListener("visibilitychange", this.boundVisibility, true);
      window.removeEventListener("pagehide", this.boundPagehide, true);
      if (location.href === this.routeAtStart && this.plan.scroller.isConnected) {
        try { await this.capture(); } catch (_) {}
      }
      const completedAt = new Date().toISOString();
      const snapshot = await buildArchiveSnapshot({
        profile: this.profile,
        roomKey: this.roomKey,
        roomUrl: this.roomUrl,
        title: this.title,
        startedAt: this.startedAt,
        completedAt,
        status,
        state: this.state,
        predecessorSnapshotId: this.predecessorSnapshotId,
        topConfirmed,
        domQuietConfirmed: topConfirmed && (!this.lastMutationAt || Date.now() - this.lastMutationAt >= CONFIG.quietMs),
        planSource: this.plan.source,
      });
      const response = await chrome.runtime.sendMessage({ type: "snapshot.commit", value: snapshot });
      this.status = response?.ok ? status : "stopped-save-error";
      this.emit({ snapshotId: snapshot.snapshotId, saveOk: Boolean(response?.ok) });
      this.finishing = false;
    }
  }

  class PassiveRecorder {
    constructor({ profile, roomKey, roomUrl, title, plan, onUpdate }) {
      this.profile = profile;
      this.roomKey = roomKey;
      this.roomUrl = roomUrl;
      this.title = title;
      this.plan = plan;
      this.onUpdate = onUpdate || (() => {});
      this.status = "idle";
      this.state = emptyState();
      this.startedAt = null;
      this.predecessorSnapshotId = null;
      this.observer = null;
      this.timer = null;
      this.busy = false;
      this.queued = false;
      this.dirty = false;
      this.routeAtStart = location.href;
      this.inheritedTopConfirmed = false;
      this.boundHidden = () => { if (document.hidden) void this.flush(true); };
      this.boundPagehide = () => { void this.stop("live-stopped"); };
    }

    snapshotStatus(extra) {
      const messages = Core.flattenState(this.state);
      return {
        status: this.status,
        messageCount: messages.length,
        segmentCount: this.state.segments.length,
        gapCount: this.state.gaps.length,
        duplicateObservations: this.state.duplicateObservations,
        elapsedMs: this.startedAt ? Date.now() - Date.parse(this.startedAt) : 0,
        ...extra,
      };
    }

    emit(extra) { this.onUpdate(this.snapshotStatus(extra)); }

    async start(seed) {
      if (!this.plan?.scroller?.isConnected) throw new Error("E-LIVE-SCROLLER");
      if (seed?.state) this.state = seed.state;
      this.dirty = Boolean(seed?.state?.repairs?.mergedBoundaries || seed?.evidenceUpgradeNeeded);
      this.inheritedTopConfirmed = Boolean(seed?.baseEvidence?.topConfirmed);
      this.predecessorSnapshotId = seed?.snapshotId || seed?.baseSnapshotId || null;
      this.startedAt = new Date().toISOString();
      this.status = "watching";
      this.observer = new MutationObserver(() => this.schedule());
      this.observer.observe(this.plan.scroller, { childList: true, subtree: true, characterData: true });
      document.addEventListener("visibilitychange", this.boundHidden, true);
      window.addEventListener("pagehide", this.boundPagehide, true);
      this.emit({ initial: true });
      await this.flush(true);
    }

    schedule() {
      if (this.status !== "watching") return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(false), 800);
    }

    async saveCheckpoint() {
      await chrome.runtime.sendMessage({ type: "checkpoint.put", value: {
        schemaVersion: "web-memory-ferry/checkpoint-v1",
        roomKey: this.roomKey,
        profileId: this.profile.id,
        roomUrl: this.roomUrl,
        title: this.title,
        startedAt: this.startedAt,
        updatedAt: new Date().toISOString(),
        mode: "automatic-live-observation",
        baseSnapshotId: this.predecessorSnapshotId,
        state: this.state,
      } });
    }

    async captureOnce() {
      if (location.href !== this.routeAtStart || !this.plan.scroller.isConnected) return false;
      const before = await Core.sequenceHash(Core.flattenState(this.state));
      const messages = await extractWindow(this.plan, new Date().toISOString());
      this.state = Core.mergeLiveWindowIntoState(this.state, messages);
      const after = await Core.sequenceHash(Core.flattenState(this.state));
      const changed = before !== after;
      if (changed) {
        this.dirty = true;
        await this.saveCheckpoint();
      }
      this.emit({ capturedThisWindow: messages.length, changed });
      return changed;
    }

    async commit(status) {
      if (!this.dirty) return null;
      const completedAt = new Date().toISOString();
      const snapshot = await buildArchiveSnapshot({
        profile: this.profile,
        roomKey: this.roomKey,
        roomUrl: this.roomUrl,
        title: this.title,
        startedAt: this.startedAt,
        completedAt,
        status: status || "live-observation",
        state: this.state,
        predecessorSnapshotId: this.predecessorSnapshotId,
        topConfirmed: this.inheritedTopConfirmed,
        domQuietConfirmed: true,
        planSource: this.plan.source,
      });
      const response = await chrome.runtime.sendMessage({ type: "snapshot.commit", value: snapshot });
      if (!response?.ok) {
        this.status = "stopped-save-error";
        this.emit({ saveOk: false });
        return null;
      }
      this.predecessorSnapshotId = snapshot.snapshotId;
      this.dirty = false;
      this.emit({ snapshotId: snapshot.snapshotId, saveOk: true });
      return snapshot;
    }

    async flush(forceCommit) {
      if (this.status !== "watching") return;
      if (this.busy) { this.queued = true; return; }
      this.busy = true;
      clearTimeout(this.timer);
      this.timer = null;
      try {
        const changed = await this.captureOnce();
        if (forceCommit || changed) await this.commit("live-observation");
      } catch (_) {
        this.status = "stopped-error";
        this.emit();
      } finally {
        this.busy = false;
        if (this.queued && this.status === "watching") {
          this.queued = false;
          this.schedule();
        }
      }
    }

    async stop(reason) {
      if (this.status !== "watching") return;
      this.status = reason || "live-stopped";
      clearTimeout(this.timer);
      this.timer = null;
      this.observer?.disconnect();
      document.removeEventListener("visibilitychange", this.boundHidden, true);
      window.removeEventListener("pagehide", this.boundPagehide, true);
      while (this.busy) await new Promise((resolve) => setTimeout(resolve, 10));
      try {
        // 停止前再看一眼当前 DOM，保证切换到手动补档时不丢最后一次变化。
        this.status = "watching";
        await this.captureOnce();
        this.status = reason || "live-stopped";
        await this.commit(reason || "live-stopped");
      } catch (_) {
        this.status = "stopped-error";
      }
      this.emit();
    }
  }

  window.WebMemoryFerryRunner = Object.freeze({ FerryRun, PassiveRecorder, extractWindow, inferWindowRoles, buildArchiveSnapshot, CONFIG });
})();
