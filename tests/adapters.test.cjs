const test = require("node:test");
const assert = require("node:assert/strict");

class FakeElement {
  constructor({ text = "", overflowY = "visible", parent = null, scrollHeight = 100, clientHeight = 100, tag = "DIV", classes = [] } = {}) {
    this.innerText = text;
    this.overflowY = overflowY;
    this.parentElement = parent;
    this.scrollHeight = scrollHeight;
    this.clientHeight = clientHeight;
    this.classList = Object.assign([...classes], { contains(token) { return this.includes(token); } });
    this.tagName = tag;
    this.children = [];
    if (parent) parent.children.push(this);
  }
  contains(item) { return item === this || this.children.some((child) => child.contains(item)); }
  querySelectorAll(tag) {
    const result = [];
    for (const child of this.children) {
      if (child.tagName === tag.toUpperCase()) result.push(child);
      result.push(...child.querySelectorAll(tag));
    }
    return result;
  }
}

global.Element = FakeElement;
const root = new FakeElement();
const page = new FakeElement();
const container = new FakeElement({ overflowY: "auto", parent: root, scrollHeight: 100, clientHeight: 100 });
const onlyMessage = new FakeElement({ text: "唯一一条消息", parent: container });
global.document = {
  documentElement: root,
  scrollingElement: page,
  querySelectorAll() { return [onlyMessage]; },
};
global.getComputedStyle = (element) => ({ overflowY: element.overflowY });
global.window = {};

require("../src/adapters.js");
const Adapters = window.WebMemoryFerryAdapters;

test("a recognized room with one message keeps its non-scrollable overflow container for live observation", () => {
  const profile = Adapters.resolve("https://chatgpt.com/c/one-message-room");
  const plan = Adapters.findAutomaticPlan(profile);
  assert.ok(plan);
  assert.equal(plan.scroller, container);
  assert.equal(plan.getMessages().length, 1);
});

test("a manually selected generic platform plan can be learned and reused for passive observation", () => {
  const deepseek = Adapters.resolve("https://chat.deepseek.com/a/chat/s/room");
  const learnedContainer = new FakeElement({ overflowY: "auto", parent: root, scrollHeight: 500, clientHeight: 200 });
  const first = new FakeElement({ text: "用户消息", parent: learnedContainer, classes: ["ds-message"] });
  new FakeElement({ text: "助手消息", parent: learnedContainer, classes: ["ds-message"] });
  const originalQuery = document.querySelectorAll;
  document.querySelectorAll = (selector) => selector === "DIV" ? root.querySelectorAll("DIV") : [];
  try {
    const manual = Adapters.findManualPlan(deepseek, first);
    assert.ok(manual);
    assert.equal(manual.getMessages().length, 2);
    assert.equal(manual.learnedDescriptor.profileId, "deepseek");
    const learned = Adapters.findLearnedPlan(deepseek, manual.learnedDescriptor);
    assert.ok(learned);
    assert.equal(learned.source, "learned-structural-signature");
    assert.equal(learned.getMessages().length, 2);
  } finally {
    document.querySelectorAll = originalQuery;
  }
});
