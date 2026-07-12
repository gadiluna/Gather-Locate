"use strict";

const fs = require("fs");
const path = require("path");

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  toggle(name, enabled) {
    if (enabled) this.values.add(name);
    else this.values.delete(name);
  }
}

class FakeElement {
  constructor(tagName = "div", id = "") {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.max = "";
    this.textContent = "";
    this.className = "";
    this.dataset = {};
    this.options = [];
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.tabIndex = 0;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }

  dispatch(type, extra = {}) {
    const event = Object.assign({ preventDefault() {}, key: "" }, extra);
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  append(...children) {
    this.children.push(...children);
    for (const child of children) {
      if (child && child.tagName === "OPTION") this.options.push(child);
    }
  }

  replaceChildren(...children) {
    this.children = [];
    this.options = [];
    this.append(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  querySelector(selector) {
    if (this.id === "play-button" && selector === ".play-icon") return elements.get("play-icon");
    return null;
  }

  querySelectorAll() {
    return [];
  }

  focus() {}
}

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
if (!/<form\s+id="config-form"[^>]*\bnovalidate\b/.test(html)) {
  throw new Error("The configuration form must route invalid values through the visible simulator error");
}
const elements = new Map();
for (const match of html.matchAll(/\sid="([^"]+)"/g)) {
  elements.set(match[1], new FakeElement("div", match[1]));
}

function configure(id, tagName, value) {
  const element = elements.get(id);
  element.tagName = tagName.toUpperCase();
  element.value = String(value);
  return element;
}

configure("ring-size", "input", 12);
configure("black-hole", "input", 7);
configure("agent-0-start", "input", 0);
configure("agent-1-start", "input", 3);
configure("agent-2-start", "input", 9);
configure("scheduler-mode", "select", "manual");
configure("manual-edge", "select", "none");
configure("missing-pattern", "textarea", "");
configure("random-seed", "input", "gl-2025");
configure("speed-range", "input", 10);
elements.get("observer-truth").checked = true;
elements.set("play-icon", new FakeElement("span", "play-icon"));
for (let id = 0; id < 3; id += 1) elements.get(`agent-tab-${id}`).dataset.agentId = String(id);

globalThis.Option = class Option extends FakeElement {
  constructor(text, value) {
    super("option");
    this.textContent = text;
    this.value = String(value);
  }
};
globalThis.document = {
  readyState: "complete",
  getElementById(id) {
    return elements.get(id) || null;
  },
  querySelectorAll(selector) {
    if (selector === ".agent-tab") return [0, 1, 2].map((id) => elements.get(`agent-tab-${id}`));
    return [];
  },
  createElement(tagName) {
    return new FakeElement(tagName);
  },
  createElementNS(_namespace, tagName) {
    return new FakeElement(tagName);
  },
  addEventListener() {},
};

require(path.join(root, "src/protocol.js"));
require(path.join(root, "src/gl-agent.js"));
require(path.join(root, "src/schedulers.js"));
require(path.join(root, "src/kernel.js"));
require(path.join(root, "src/ui.js"));

// Shrinking the ring used to clamp A2 onto the black hole, making the
// Initialize ring button appear inert. Bounds normalization must preserve a
// valid configuration, and submitting the form must activate it at round 0.
const ringSize = elements.get("ring-size");
ringSize.value = "8";
ringSize.dispatch("input");
const resizedBlackHole = Number(elements.get("black-hole").value);
const resizedStarts = [0, 1, 2].map((id) => Number(elements.get(`agent-${id}-start`).value));
if (new Set(resizedStarts).size !== 3 || resizedStarts.includes(resizedBlackHole)) {
  throw new Error("Shrinking the ring produced an invalid starting configuration");
}
elements.get("config-form").dispatch("submit");
if (elements.get("configuration-state").textContent !== "Current values are active.") {
  throw new Error("Initialize ring did not apply the resized configuration");
}
if (elements.get("round-value").textContent !== "0") {
  throw new Error("Initialize ring did not restart the execution at round 0");
}

// Restore the default world for the remaining interaction tests.
ringSize.value = "12";
ringSize.dispatch("input");
elements.get("black-hole").value = "7";
elements.get("agent-0-start").value = "0";
elements.get("agent-1-start").value = "3";
elements.get("agent-2-start").value = "9";
elements.get("config-form").dispatch("submit");

const schedulerMode = elements.get("scheduler-mode");
schedulerMode.value = "pattern";
schedulerMode.dispatch("change");
const pattern = elements.get("missing-pattern");
pattern.value = "edge 1 absent from 3 to 5";
pattern.dispatch("input");

const play = elements.get("play-button");
if (play.disabled) throw new Error("Play is disabled after selecting a manual pattern");
play.dispatch("click");
if (elements.get("round-value").textContent !== "1") {
  throw new Error(`Play did not start the pending configuration; round is ${elements.get("round-value").textContent}`);
}
if (play.getAttribute && play.getAttribute("aria-pressed") === "false") {
  throw new Error("Play did not enter the running state");
}
play.dispatch("click");

// The click-edge scheduler must remove and restore an edge through the SVG
// control itself, without advancing a round.
schedulerMode.value = "click";
schedulerMode.dispatch("change");
let hitTargets = elements.get("edge-layer").children.filter((child) =>
  child.getAttribute("class") === "ring-edge-hit",
);
if (hitTargets.length !== 12) throw new Error(`Expected 12 interactive ring edges, found ${hitTargets.length}`);
hitTargets[0].dispatch("click");
let visibleEdges = elements.get("edge-layer").children.filter((child) =>
  String(child.getAttribute("class") || "").startsWith("ring-edge"),
);
if (!visibleEdges.some((edge) => String(edge.getAttribute("class")).includes("is-missing"))) {
  throw new Error("Clicking a ring edge did not remove it");
}
hitTargets = elements.get("edge-layer").children.filter((child) =>
  child.getAttribute("class") === "ring-edge-hit",
);
hitTargets[0].dispatch("click");
visibleEdges = elements.get("edge-layer").children.filter((child) =>
  String(child.getAttribute("class") || "").startsWith("ring-edge"),
);
if (visibleEdges.some((edge) => String(edge.getAttribute("class")).includes("is-missing"))) {
  throw new Error("Clicking the missing ring edge did not restore it");
}

console.log("UI Play and interactive-edge integration checks passed");
