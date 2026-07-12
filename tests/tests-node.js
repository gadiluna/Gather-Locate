"use strict";

class FakeElement {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.textContent = "";
    this.className = "";
  }

  append(...children) {
    this.children.push(...children);
  }
}

const elements = new Map();
globalThis.document = {
  documentElement: new FakeElement(),
  createElement: () => new FakeElement(),
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  },
};

require("../src/protocol.js");
require("../src/gl-agent.js");
require("../src/schedulers.js");
require("../src/kernel.js");
require("./tests.js");

const failures = document.documentElement.dataset.testFailures;
if (failures !== "0") {
  const textOf = (element) => [element.textContent, ...element.children.map(textOf)]
    .filter(Boolean)
    .join("\n");
  for (const result of elements.get("results").children) {
    if (result.className === "fail") console.error(textOf(result));
  }
  throw new Error(`${failures} simulator tests failed`);
}
console.log(elements.get("summary").textContent);
