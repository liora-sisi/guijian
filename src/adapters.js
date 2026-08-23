(function () {
  "use strict";

  const profiles = [
    // 仅供仓库内合成页直接加载脚本验收；正式 manifest 不会向 localhost 注入。
    { id: "synthetic", label: "本地合成房间", authorityStatus: "test-only", hosts: ["127.0.0.1", "localhost"], messageSelector: ".chat-content-item" },
    { id: "kimi", label: "Kimi", authorityStatus: "web-primary", hosts: ["kimi.com", "kimi.moonshot.cn"], subdomains: true, messageSelector: ".chat-content-item" },
    { id: "chatgpt", label: "ChatGPT", authorityStatus: "provisional-pending-official", hosts: ["chatgpt.com", "chat.openai.com"], messageSelector: "[data-message-author-role]" },
    { id: "deepseek", label: "DeepSeek", hosts: ["chat.deepseek.com"] },
    { id: "gemini", label: "Gemini", hosts: ["gemini.google.com"] },
    { id: "claude", label: "Claude", hosts: ["claude.ai"] },
    { id: "yuanbao", label: "腾讯元宝", hosts: ["yuanbao.tencent.com"] },
    { id: "doubao", label: "豆包", hosts: ["www.doubao.com"] },
    { id: "qianwen", label: "千问", hosts: ["qianwen.com", "www.qianwen.com"] },
  ];

  function matches(profile, hostname) {
    return profile.hosts.some((host) => hostname === host || (profile.subdomains && hostname.endsWith(`.${host}`)));
  }

  function resolve(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return null;
      return profiles.find((profile) => matches(profile, parsed.hostname)) || null;
    } catch (_) { return null; }
  }

  function normalizedRoomUrl(url) {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    return parsed.toString();
  }

  function nearestVerticalScroller(element) {
    let current = element;
    let nonScrollableOverflowContainer = null;
    while (current && current instanceof Element && current !== document.documentElement) {
      const style = getComputedStyle(current);
      if (style.overflowY === "auto" || style.overflowY === "scroll") {
        if (!nonScrollableOverflowContainer) nonScrollableOverflowContainer = current;
        if (current.scrollHeight - current.clientHeight > 8) return current;
      }
      current = current.parentElement;
    }
    const page = document.scrollingElement;
    if (page && page.scrollHeight - page.clientHeight > 8) return page;
    // 新房间可能暂时只有一条消息，容器尚不可滚动，但仍需要观察后续新增内容。
    return nonScrollableOverflowContainer || page || null;
  }

  function stableClassTokens(element) {
    return Array.from(element.classList || []).filter((token) =>
      /^[a-zA-Z_-][a-zA-Z0-9_-]{1,47}$/.test(token) && !/[a-f0-9]{10,}/i.test(token)
    ).slice(0, 4);
  }

  function signatureOf(element) {
    return { tag: element.tagName, classes: stableClassTokens(element) };
  }

  function matchesSignature(element, signature) {
    return element.tagName === signature.tag && signature.classes.every((token) => element.classList.contains(token));
  }

  function normalizedSignature(value) {
    if (!value || typeof value !== "object") return null;
    const tag = String(value.tag || "").toUpperCase();
    const classes = Array.isArray(value.classes)
      ? value.classes.filter((token) => /^[a-zA-Z_-][a-zA-Z0-9_-]{1,47}$/.test(token)).slice(0, 4)
      : [];
    if (!/^[A-Z][A-Z0-9-]{0,31}$/.test(tag)) return null;
    if (!classes.length && tag !== "ARTICLE") return null;
    return { tag, classes };
  }

  function buildSignaturePlan(profile, signature, source, descriptionPrefix, scrollerHint) {
    const normalized = normalizedSignature(signature);
    if (!profile || !normalized) return null;
    const candidates = Array.from(document.querySelectorAll(normalized.tag))
      .filter((item) => matchesSignature(item, normalized) && item.innerText.trim());
    const grouped = new Map();
    for (const item of candidates) {
      const owner = scrollerHint || nearestVerticalScroller(item);
      if (!owner || (scrollerHint && !scrollerHint.contains(item))) continue;
      if (!grouped.has(owner)) grouped.set(owner, []);
      grouped.get(owner).push(item);
    }
    const ranked = Array.from(grouped.entries()).sort((a, b) => b[1].length - a[1].length);
    const [scroller, matches] = ranked[0] || [];
    if (!scroller || !matches?.length || matches.length > 5000) return null;
    if (!scroller) return null;
    return {
      scroller,
      getMessages: () => Array.from(scroller.querySelectorAll(normalized.tag))
        .filter((item) => matchesSignature(item, normalized) && item.innerText.trim()),
      description: `${descriptionPrefix} ${normalized.tag.toLowerCase()}，当前 ${matches.length} 条`,
      source,
      learnedDescriptor: {
        schemaVersion: "web-memory-ferry/adapter-plan-v1",
        profileId: profile.id,
        signature: normalized,
      },
    };
  }

  function inferShell(clicked, scroller) {
    let current = clicked instanceof Element ? clicked : clicked.parentElement;
    let fallback = null;
    while (current && current !== scroller && current !== document.body) {
      const signature = signatureOf(current);
      if (signature.classes.length || current.tagName === "ARTICLE") {
        const matches = Array.from(scroller.querySelectorAll(current.tagName)).filter((item) => matchesSignature(item, signature));
        if (matches.length >= 2 && matches.length <= 5000) fallback = { signature, matches };
      }
      current = current.parentElement;
    }
    return fallback;
  }

  function findAutomaticPlan(profile) {
    if (!profile?.messageSelector) return null;
    const messages = Array.from(document.querySelectorAll(profile.messageSelector)).filter((item) => item.innerText.trim());
    if (!messages.length) return null;
    const scroller = nearestVerticalScroller(messages[0]);
    if (!scroller) return null;
    return {
      scroller,
      getMessages: () => Array.from(document.querySelectorAll(profile.messageSelector)).filter((item) => item.innerText.trim()),
      description: `${profile.label} 已识别消息区`,
      source: "verified-platform-selector",
    };
  }

  function findManualPlan(profile, clicked) {
    const scroller = nearestVerticalScroller(clicked);
    if (!scroller) return null;
    const inferred = inferShell(clicked, scroller);
    if (!inferred) return null;
    return buildSignaturePlan(profile, inferred.signature, "manual-structural-signature", "手动锚定", scroller);
  }

  function findLearnedPlan(profile, descriptor) {
    if (!profile || descriptor?.schemaVersion !== "web-memory-ferry/adapter-plan-v1" || descriptor.profileId !== profile.id) return null;
    return buildSignaturePlan(profile, descriptor.signature, "learned-structural-signature", `${profile.label} 已复用消息区`);
  }

  window.WebMemoryFerryAdapters = Object.freeze({ resolve, normalizedRoomUrl, findAutomaticPlan, findManualPlan, findLearnedPlan });
})();
