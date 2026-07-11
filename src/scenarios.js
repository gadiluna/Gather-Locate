(function initScenarios(root) {
  "use strict";

  const GLSim = (root.GLSim = root.GLSim || {});

  const scenarios = Object.freeze({
    marker: Object.freeze({
      id: "marker",
      name: "Pebble marks the black hole",
      description: "Agent 0 probes immediately into the black hole; the other agents later encounter its pebble.",
      n: 8,
      blackHole: 1,
      positions: Object.freeze([0, 3, 5]),
      scheduler: Object.freeze({ type: "none" }),
    }),
    open: Object.freeze({
      id: "open",
      name: "Open ring",
      description: "All edges remain present, making cautious steps and meetings easy to follow.",
      n: 12,
      blackHole: 10,
      positions: Object.freeze([0, 4, 7]),
      scheduler: Object.freeze({ type: "none" }),
    }),
    bottleneck: Object.freeze({
      id: "bottleneck",
      name: "Persistent bottleneck",
      description: "One fixed edge is absent in every round; the footprint remains a connected path.",
      n: 12,
      blackHole: 10,
      positions: Object.freeze([0, 4, 7]),
      scheduler: Object.freeze({ type: "manual", missingEdge: 5 }),
    }),
    dynamic: Object.freeze({
      id: "dynamic",
      name: "Seeded dynamic ring",
      description: "A reproducible schedule omits at most one randomly selected edge per round.",
      n: 14,
      blackHole: 12,
      positions: Object.freeze([0, 5, 9]),
      scheduler: Object.freeze({ type: "random", seed: 2025, omissionProbability: 0.42 }),
    }),
  });

  function getScenario(id) {
    const scenario = scenarios[id] || scenarios.marker;
    return GLSim.clone(scenario);
  }

  Object.assign(GLSim, { getScenario, scenarios });
})(globalThis);
