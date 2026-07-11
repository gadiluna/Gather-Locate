"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const commands = [
  ["tests/tests-node.js"],
  ["tests/ui-harness.js"],
  ["tests/corner-cases.js"],
];

for (const [script] of commands) {
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log("All Gather&Locate simulator tests passed");
