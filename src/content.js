(function () {
  "use strict";

  if (window.top !== window || document.getElementById("web-memory-ferry-dot")) return;

  const Core = window.WebMemoryFerryCore;
  const ExportCore = window.WebMemoryFerryExport;
  const Adapters = window.WebMemoryFerryAdapters;
  const { FerryRun, PassiveRecorder } = window.WebMemoryFerryRunner;
  const profile = Adapters.resolve(location.href);
  if (!profile) return;

  let plan = Adapters.findAutomaticPlan(profile);
  let run = null;
  let liveRecorder = null;
  let roomKey = null;
  let latestState = null;
  let picking = false;
  let drag = null;
  let suppressClick = false;
  let els = null;
  let observedPageUrl = location.href;
  let routeHandling = false;
  let passiveStarting = false;
  let backfillStarting = false;
  let lastPassiveAttemptAt = 0;
  let resumeTimer = null;
  let recoveryTimer = null;
  let backfillRecoveryAttempts = 0;
  let learnedDescriptor = null;
  const recoverableBackfillStatuses = new Set(["stopped-scroller-replaced", "stopped-error", "stopped-timeout", "stopped-max-rounds"]);

  const statusText = {
    idle: "正在认路：寻找当前对话",
    watching: "随页续记中：新对话会自动归入本地",
    running: "正在回溯旧对话",
    "live-observation": "新对话已经归笺",
    "live-paused-for-backfill": "随页续记已暂停，准备回溯旧对话",
    "live-room-switch": "上一房间已安放，正在认领新房间",
    "live-stopped": "随页续记已停止，进度已安放",
    "done-top": "已经回到开篇，本次归笺完成",
    "stopped-by-user": "已停在这里，当前进度已经安放",
    "stopped-hidden": "当前进度已安放，后台仍在缓慢回溯",
    "stopped-pagehide": "页面离开前已安放当前进度",
    "stopped-room-switch": "检测到换房，已安放当前进度",
    "stopped-scroller-replaced": "消息区发生变化，已安放当前进度",
    "stopped-timeout": "本次回溯时间已到，当前进度已安放",
    "stopped-max-rounds": "本次回溯轮数已到，当前进度已安放",
    "stopped-error": "途中遇到异常，已尽力安放当前进度",
    "stopped-save-error": "本地保存没有成功，先别关闭页面",
  };

  function send(message) {
    return new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: "E-RUNTIME" });
      else resolve(response || { ok: false, error: "E-NO-RESPONSE" });
    }));
  }

  function findReusablePlan() {
    return Adapters.findAutomaticPlan(profile) || Adapters.findLearnedPlan(profile, learnedDescriptor);
  }

  async function loadLearnedDescriptor() {
    const response = await send({ type: "adapter-plan.get", profileId: profile.id });
    learnedDescriptor = response?.ok ? response.value || null : null;
    return learnedDescriptor;
  }

  async function rememberPlan(selected) {
    const descriptor = selected?.learnedDescriptor;
    if (!descriptor) return false;
    learnedDescriptor = { ...descriptor, updatedAt: new Date().toISOString() };
    const response = await send({ type: "adapter-plan.put", value: learnedDescriptor });
    return Boolean(response?.ok);
  }

  async function prepareIdentity() {
    const normalizedUrl = Adapters.normalizedRoomUrl(location.href);
    roomKey = `${profile.id}:${(await Core.sha256Hex(normalizedUrl)).slice(0, 32)}`;
    return { normalizedUrl, roomKey };
  }

  async function loadSeed(identity) {
    const previous = await send({ type: "checkpoint.get", roomKey: identity.roomKey });
    const latest = await send({ type: "snapshot.latest", roomKey: identity.roomKey });
    const snapshot = latest?.ok ? latest.value : null;
    const topConfirmed = await send({ type: "snapshot.latest-top-confirmed", roomKey: identity.roomKey });
    const topEvidence = topConfirmed?.ok ? topConfirmed.value : null;
    if (previous?.ok && previous.value) return {
      ...previous.value,
      snapshotId: previous.value.baseSnapshotId || snapshot?.snapshotId || null,
      baseEvidence: topEvidence?.evidence || snapshot?.evidence || null,
      evidenceUpgradeNeeded: Boolean(topEvidence?.evidence?.topConfirmed && !snapshot?.evidence?.topConfirmed),
      state: Core.coalesceAdjacentSegments(previous.value.state),
    };
    if (!snapshot?.raw?.segments) return null;
    const state = Core.coalesceAdjacentSegments({
      segments: snapshot.raw.segments,
      observedWindows: Number(snapshot.evidence?.observedWindows || 0),
      observedMessages: Number(snapshot.evidence?.observedMessages || 0),
      duplicateObservations: Number(snapshot.evidence?.duplicateObservations || 0),
      gaps: Array.isArray(snapshot.evidence?.gaps) ? snapshot.evidence.gaps : [],
      relations: [],
    });
    return {
      schemaVersion: "web-memory-ferry/seed-v1",
      snapshotId: snapshot.snapshotId,
      baseEvidence: topEvidence?.evidence || snapshot.evidence || null,
      evidenceUpgradeNeeded: Boolean(topEvidence?.evidence?.topConfirmed && !snapshot.evidence?.topConfirmed),
      state,
    };
  }

  function colorFor(status) {
    if (status === "watching" || status === "live-observation") return "#1a7f37";
    if (status === "running") return "#2563eb";
    if (status === "done-top") return "#1a5fb4";
    if (status && status !== "idle") return "#c0392b";
    return "#888";
  }

  function render(state) {
    if (state) latestState = state;
    const manualRunning = run?.status === "running";
    const manualBusy = manualRunning || backfillStarting || Boolean(recoveryTimer);
    const status = state?.status || (manualRunning ? run.status : liveRecorder?.status) || "idle";
    els.dot.style.background = colorFor(status);
    els.dot.title = `归笺：${statusText[status] || status}`;
    const readableStatus = state?.runningWhileHidden
      ? "回溯进度已安放；后台标签页继续低速运行"
      : (statusText[status] || status);
    els.status.textContent = `平台：${profile.label} · ${readableStatus}`;
    const display = state || latestState;
    const count = display?.messageCount ?? 0;
    const gaps = display?.gapCount ?? 0;
    const segments = display?.segmentCount ?? 0;
    els.stats.textContent = `已收拢 ${count} 条 · ${segments} 段 · ${gaps} 处待核`;
    if (liveRecorder?.status === "watching") {
      els.plan.textContent = `随页续记：已开启 · ${liveRecorder.plan.description}`;
    } else {
      els.plan.textContent = plan ? `回溯范围：${plan.description}` : "还没有认出消息区，可以点“认领一条消息”";
    }
    els.start.disabled = manualBusy;
    els.stop.disabled = !manualRunning && !recoveryTimer;
    els.pick.disabled = manualBusy;
    els.exportBtn.disabled = manualBusy;
  }

  function setCollapsed(collapsed) {
    els.panel.style.display = collapsed ? "none" : "block";
    els.dot.style.display = collapsed ? "block" : "none";
  }

  function buildUi() {
    const dot = document.createElement("button");
    dot.id = "web-memory-ferry-dot";
    dot.type = "button";
    dot.setAttribute("aria-label", "展开归笺；可上下拖动");
    dot.style.cssText = "position:fixed;right:10px;top:45%;width:17px;height:17px;padding:0;border:2px solid #333;border-radius:50%;background:#888;box-shadow:0 2px 8px rgba(0,0,0,.3);z-index:2147483647;cursor:grab;touch-action:none";

    const panel = document.createElement("section");
    panel.id = "web-memory-ferry-panel";
    panel.style.cssText = "position:fixed;right:16px;bottom:16px;width:290px;padding:13px;border:2px solid #333;border-radius:12px;background:#fff;color:#222;box-shadow:0 5px 20px rgba(0,0,0,.25);font:13px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;z-index:2147483647;display:none";
    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px">
        <strong style="font-size:15px;font-family:Georgia,Songti SC,serif;color:#244b91">归笺 <span style="font:10px Segoe UI,sans-serif;color:#7b8798">v0.5.0</span></strong>
        <button data-action="collapse" type="button">— 收起</button>
      </div>
      <div data-field="status"></div>
      <div data-field="stats" style="color:#555;margin-top:3px"></div>
      <div data-field="plan" style="color:#777;font-size:11px;margin:5px 0 9px"></div>
      <button data-action="start" type="button" style="width:100%;padding:8px;background:linear-gradient(90deg,#315fc4,#1aa8b8);color:#fff;border:0;border-radius:7px;font-weight:700">回溯旧对话</button>
      <button data-action="stop" type="button" style="width:100%;padding:8px;margin-top:6px;background:#9b5362;color:#fff;border:0;border-radius:7px">停在这里并保存</button>
      <button data-action="pick" type="button" style="width:100%;padding:7px;margin-top:6px;background:#fff;color:#315a96;border:1px solid #8ba7cf;border-radius:7px">认领一条消息</button>
      <button data-action="export" type="button" style="width:100%;padding:7px;margin-top:6px;background:#fff;color:#826329;border:1px solid #d2b56f;border-radius:7px">快速导出本房 JSON</button>
      <div style="color:#7b8798;font-size:10px;margin-top:8px">打开对话即续记 · 回溯只在你点击后开始 · 只存本地 · 不联网发送</div>`;
    document.documentElement.append(dot, panel);
    els = {
      dot, panel,
      status: panel.querySelector('[data-field="status"]'),
      stats: panel.querySelector('[data-field="stats"]'),
      plan: panel.querySelector('[data-field="plan"]'),
      start: panel.querySelector('[data-action="start"]'),
      stop: panel.querySelector('[data-action="stop"]'),
      pick: panel.querySelector('[data-action="pick"]'),
      exportBtn: panel.querySelector('[data-action="export"]'),
    };

    dot.addEventListener("click", (event) => {
      if (!event.isTrusted || suppressClick) return;
      setCollapsed(false);
    });
    dot.addEventListener("pointerdown", (event) => {
      if (!event.isTrusted || event.button !== 0) return;
      drag = { id: event.pointerId, y: event.clientY, top: dot.getBoundingClientRect().top, moved: false };
      dot.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    dot.addEventListener("pointermove", (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const delta = event.clientY - drag.y;
      if (Math.abs(delta) > 4) drag.moved = true;
      const next = Math.max(8, Math.min(innerHeight - 25, drag.top + delta));
      dot.style.top = `${next}px`;
      event.preventDefault();
    });
    dot.addEventListener("pointerup", (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      suppressClick = drag.moved;
      drag = null;
      setTimeout(() => { suppressClick = false; }, 0);
    });
    panel.querySelector('[data-action="collapse"]').addEventListener("click", (event) => { if (event.isTrusted) setCollapsed(true); });
    els.start.addEventListener("click", (event) => { if (event.isTrusted) void startBackfill(); });
    els.stop.addEventListener("click", (event) => { if (event.isTrusted) void stopBackfill(); });
    els.pick.addEventListener("click", (event) => { if (event.isTrusted) beginPick(); });
    els.exportBtn.addEventListener("click", (event) => { if (event.isTrusted) void exportLatest(); });
  }

  function beginPick() {
    if (picking) return;
    picking = true;
    els.status.textContent = "现在去对话里点一条完整消息，让归笺认认路；按 Esc 取消";
    const cleanup = () => {
      picking = false;
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
    };
    const onKey = (event) => { if (event.key === "Escape") { cleanup(); render(); } };
    const onClick = (event) => {
      if (els.panel.contains(event.target) || els.dot.contains(event.target)) return;
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopPropagation();
      const selected = Adapters.findManualPlan(profile, event.target);
      cleanup();
      if (!selected) {
        els.status.textContent = "这一下没有认出重复消息外壳，换一条消息正文再点一次";
        return;
      }
      plan = selected;
      render();
      void activateLearnedPlan(selected);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  }

  async function activateLearnedPlan(selected) {
    const remembered = await rememberPlan(selected);
    if (!remembered) {
      els.status.textContent = "已经认出消息区，但本地学习记录暂时没保存成功";
      return;
    }
    const recorder = liveRecorder;
    liveRecorder = null;
    if (recorder?.status === "watching") await recorder.stop("live-stopped");
    if (run?.status !== "running") await ensurePassiveRecorder(true, selected);
  }

  function schedulePassiveResume() {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      if (run?.status === "running") return;
      run = null;
      plan = findReusablePlan() || plan;
      void ensurePassiveRecorder(true);
    }, 500);
  }

  async function stopBackfill() {
    clearTimeout(recoveryTimer);
    recoveryTimer = null;
    backfillRecoveryAttempts = 0;
    if (run?.status === "running") return void run.stop("stopped-by-user");
    run = null;
    els.status.textContent = "已取消自动接续；先前安放的进度仍好好保留着";
    schedulePassiveResume();
  }

  function scheduleBackfillRecovery(state) {
    clearTimeout(recoveryTimer);
    run = null;
    if (backfillRecoveryAttempts >= 15) {
      els.status.textContent = "已经尝试接续 15 次；当前进度已安放，可以稍后再回来";
      schedulePassiveResume();
      return;
    }
    backfillRecoveryAttempts += 1;
    const delayMs = Math.min(10000, 1500 + backfillRecoveryAttempts * 750);
    els.status.textContent = `回溯暂时中断，正在自动接续（${backfillRecoveryAttempts}/15）`;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (location.href !== observedPageUrl) return;
      plan = findReusablePlan() || plan;
      void startBackfill({ recovery: true, previousState: state });
    }, delayMs);
  }

  async function ensurePassiveRecorder(force, preferredPlan) {
    if (passiveStarting || backfillStarting || recoveryTimer || run?.status === "running" || liveRecorder?.status === "watching") return;
    if (!force && Date.now() - lastPassiveAttemptAt < 2000) return;
    lastPassiveAttemptAt = Date.now();
    const reusablePlan = preferredPlan || findReusablePlan();
    if (!reusablePlan) {
      render();
      return;
    }
    passiveStarting = true;
    const routeUrl = location.href;
    try {
      plan = reusablePlan;
      const identity = await prepareIdentity();
      const seed = await loadSeed(identity);
      if (location.href !== routeUrl || run?.status === "running") return;
      let recorder;
      recorder = new PassiveRecorder({
        profile,
        roomKey: identity.roomKey,
        roomUrl: identity.normalizedUrl,
        title: document.title,
        plan: reusablePlan,
        onUpdate: (state) => {
          if (liveRecorder !== recorder || run?.status === "running") return;
          render(state);
        },
      });
      liveRecorder = recorder;
      try {
        await recorder.start(seed);
      } catch (_) {
        if (liveRecorder === recorder) liveRecorder = null;
        els.status.textContent = "消息区还在加载，归笺会继续等一等";
      }
    } finally {
      passiveStarting = false;
    }
  }

  async function startBackfill(options) {
    const recovery = Boolean(options?.recovery);
    if (backfillStarting || run?.status === "running") return;
    if (!plan) plan = findReusablePlan();
    if (!plan) {
      if (recovery) {
        scheduleBackfillRecovery(options?.previousState);
        return;
      }
      els.status.textContent = "还差一步：点“认领一条消息”，再到对话里点任意一条完整消息";
      return;
    }
    if (!recovery) backfillRecoveryAttempts = 0;
    backfillStarting = true;
    render();
    try {
      const recorder = liveRecorder;
      liveRecorder = null;
      if (recorder?.status === "watching") await recorder.stop("live-paused-for-backfill");

      const identity = await prepareIdentity();
      const seed = await loadSeed(identity);
      const currentRun = new FerryRun({
        profile,
        roomKey: identity.roomKey,
        roomUrl: identity.normalizedUrl,
        title: document.title,
        plan,
        onUpdate: (state) => {
          if (run !== currentRun) return;
          render(state);
          if (state.status === "running") return;
          if (recoverableBackfillStatuses.has(state.status)) scheduleBackfillRecovery(state);
          else {
            backfillRecoveryAttempts = 0;
            schedulePassiveResume();
          }
        },
      });
      run = currentRun;
      await currentRun.start(seed);
    } catch (_) {
      run = null;
      if (recovery) scheduleBackfillRecovery(options?.previousState);
      else {
        els.status.textContent = "消息区已经变化，正在自动重新识别并接续";
        scheduleBackfillRecovery();
      }
    } finally {
      backfillStarting = false;
      if (!recoveryTimer) render();
    }
  }

  async function exportLatest() {
    if (!roomKey) await prepareIdentity();
    const response = await send({ type: "snapshot.latest", roomKey });
    if (!response?.ok || !response.value) {
      els.status.textContent = "这个房间还没有归笺记录，稍等片刻让随页续记先安放第一份";
      return;
    }
    const snapshot = response.value;
    const download = ExportCore.buildSnapshotDownload(snapshot, { format: "json", platformLabel: profile.label });
    const blob = new Blob([download.body], { type: download.mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = Core.buildExportFilename({
      platform: profile.label,
      displayName: snapshot.title,
      completedAt: snapshot.completedAt,
      messageCount: snapshot.messageCount,
      extension: download.extension,
    });
    link.style.display = "none";
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    els.status.textContent = `已经带回 ${snapshot.messageCount} 条，校验指纹也一并收好`;
  }

  async function handleRouteChange() {
    if (routeHandling || location.href === observedPageUrl) return;
    routeHandling = true;
    try {
      observedPageUrl = location.href;
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
      backfillRecoveryAttempts = 0;
      roomKey = null;
      latestState = null;
      const recorder = liveRecorder;
      liveRecorder = null;
      if (recorder?.status === "watching") await recorder.stop("live-room-switch");
      if (!run || run.status !== "running") run = null;
      plan = findReusablePlan();
      render();
      if (!run) await ensurePassiveRecorder(true);
    } finally {
      routeHandling = false;
    }
  }

  async function initializeMode() {
    await loadLearnedDescriptor();
    const reusablePlan = findReusablePlan();
    if (!reusablePlan) return void ensurePassiveRecorder(true);
    plan = reusablePlan;
    const identity = await prepareIdentity();
    const checkpoint = await send({ type: "checkpoint.get", roomKey: identity.roomKey });
    if (checkpoint?.ok && checkpoint.value?.mode === "manual-backfill" && checkpoint.value?.resumeRequested) {
      els.status.textContent = "找到上次没有走完的回溯进度，正在自动接续";
      return void startBackfill({ recovery: true });
    }
    void ensurePassiveRecorder(true);
  }

  buildUi();
  render();
  void initializeMode();
  window.setInterval(() => {
    if (location.href !== observedPageUrl) void handleRouteChange();
    else if (!run && !liveRecorder) void ensurePassiveRecorder(false);
  }, 1000);
})();
