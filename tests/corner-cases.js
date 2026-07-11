"use strict";

const path = require("path");

const root = path.resolve(__dirname, "..");
require(path.join(root, "src/protocol.js"));
require(path.join(root, "src/gl-agent.js"));
require(path.join(root, "src/schedulers.js"));
require(path.join(root, "src/kernel.js"));

const G = globalThis.GLSim;
const tests = [];
const test = (name, body) => tests.push({ name, body });

function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

function combinations(values, count, prefix = [], result = []) {
  if (prefix.length === count) {
    result.push(prefix.slice());
    return result;
  }
  for (let index = 0; index < values.length; index += 1) {
    combinations(values, count, prefix.concat(values[index]), result);
  }
  return result;
}

function safeStartSets(n, blackHole) {
  const safe = Array.from({ length: n }, (_item, node) => node)
    .filter((node) => node !== blackHole);
  const result = [];
  for (let a = 0; a < safe.length - 2; a += 1) {
    for (let b = a + 1; b < safe.length - 1; b += 1) {
      for (let c = b + 1; c < safe.length; c += 1) {
        result.push([safe[a], safe[b], safe[c]]);
      }
    }
  }
  return result;
}

function safeStartMultisets(n, blackHole) {
  const safe = Array.from({ length: n }, (_item, node) => node)
    .filter((node) => node !== blackHole);
  const result = [];
  for (let a = 0; a < safe.length; a += 1) {
    for (let b = a; b < safe.length; b += 1) {
      for (let c = b; c < safe.length; c += 1) {
        result.push([safe[a], safe[b], safe[c]]);
      }
    }
  }
  return result;
}

function checkFrame(frame, label) {
  assert(frame.pebbles.length === 3, `${label}: the kernel lost a pebble record`);
  assert(frame.agents.some((agent) => agent.status !== "DESTROYED"),
    `${label}: all three agents were destroyed`);
  assert(!frame.agents.some((agent) =>
    agent.status === "ACTIVE" && agent.position === frame.blackHole),
  `${label}: an active agent occupies the black hole`);
  assert(!frame.claims.some((claim) => claim.correct !== true),
    `${label}: an invalid or unsupported termination occurred`);
  assert(frame.agents.filter((agent) =>
    agent.status === "ACTIVE" && agent.memory.role === G.Role.FORWARD,
  ).length <= 2, `${label}: a legal execution placed three agents in Forward`);
  assert(!frame.agents.some((agent) =>
    agent.status === "ACTIVE"
    && agent.memory.role === G.Role.FORWARD
    && agent.memory.phase !== 3,
  ), `${label}: the Forward role appeared outside Phase 3`);

  const cautiousPendulumStarted = frame.agents.some((agent) =>
    agent.memory && agent.memory.mode.startsWith("RT_"));
  const activePhase1 = frame.agents.some((agent) =>
    agent.status === "ACTIVE" && agent.memory && agent.memory.phase === 1);
  if (frame.round <= 6 * frame.n && activePhase1) {
    assert(!cautiousPendulumStarted, `${label}: CautiousPendulum started during Phase 1`);
    const destroyed = frame.agents.filter((agent) => agent.status === "DESTROYED");
    assert(destroyed.length <= 1, `${label}: more than one agent entered the black hole in Phase 1`);
    if (destroyed.length === 1) {
      const casualty = destroyed[0];
      const mark = frame.pebbles.find((pebble) => pebble.id === `p${casualty.id}`);
      assert(mark && mark.status === "PLACED" && mark.position === G.mod(frame.blackHole - 1, frame.n),
        `${label}: the Phase-1 casualty did not leave its pebble on h-minus`);
    }
  }

  const carried = new Map(frame.agents.map((agent) => [agent.id, 0]));
  for (const pebble of frame.pebbles) {
    assert(["CARRIED", "PLACED", "DESTROYED"].includes(pebble.status),
      `${label}: invalid pebble status ${pebble.status}`);
    if (pebble.status === "CARRIED") {
      assert(carried.has(pebble.carrierId), `${label}: pebble has an unknown carrier`);
      carried.set(pebble.carrierId, carried.get(pebble.carrierId) + 1);
    } else {
      assert(pebble.carrierId === null, `${label}: uncarried pebble retains a carrier`);
    }
    if (pebble.status === "PLACED") {
      assert(Number.isInteger(pebble.position), `${label}: placed pebble has no node`);
      assert(pebble.position !== frame.blackHole, `${label}: a pebble was placed in the black hole`);
    } else {
      assert(pebble.position === null, `${label}: unplaced pebble retains a node`);
    }
  }
  for (const agent of frame.agents) {
    assert(agent.carriedPebbles === carried.get(agent.id),
      `${label}: observer pebble count disagrees with token records for agent ${agent.id}`);
  }
}

function assertPhase1Boundary(frame, label) {
  if (frame.round !== 6 * frame.n) return;
  if (frame.claims.some((claim) => claim.correct === true)) return;
  const survivors = frame.agents.filter((agent) => agent.status === "ACTIVE");
  const occupied = new Set(survivors.map((agent) => agent.position));
  if (occupied.size === 1) return;
  assert(occupied.size === 2, `${label}: survivors occupy more than two nodes at round 6n`);

  const returners = survivors.filter((agent) =>
    agent.memory.stage === G.Stage.PROBE
    && [G.Mode.PHASE1_CW, G.Mode.JOINT_AVANGUARD, G.Mode.FOLLOW_RETURN].includes(agent.memory.mode),
  );
  assert(returners.length === 1, `${label}: the split boundary has ${returners.length} pending returners`);
  const returner = returners[0];
  const safeEndpoint = G.mod(returner.position - 1, frame.n);
  assert(survivors.every((agent) => agent.id === returner.id || agent.position === safeEndpoint),
    `${label}: a survivor is not waiting at the pending returner's safe endpoint`);
  const marker = frame.pebbles.find((pebble) => pebble.id === `p${returner.id}`);
  assert(marker && marker.status === "PLACED" && marker.position === safeEndpoint,
    `${label}: the pending returner's pebble is not on the safe endpoint`);
}

function runToCorrectClaim(config, limit, label, onFrame) {
  const simulation = new G.Simulation(config);
  let frame = simulation.observerFrame();
  checkFrame(frame, `${label}, initial frame`);
  for (let round = 1; round <= limit; round += 1) {
    frame = simulation.step();
    checkFrame(frame, `${label}, round ${round}`);
    if (onFrame) onFrame(frame);
    if (frame.claims.some((claim) => claim.correct === true)) return frame;
  }
  throw new Error(`${label}: no correct termination within ${limit} rounds`);
}

test("all length-three periodic omission schedules terminate on every small-ring rotation", () => {
  let executions = 0;
  for (let n = 4; n <= 5; n += 1) {
    const choices = [null].concat(Array.from({ length: n }, (_item, edge) => edge));
    const schedules = combinations(choices, 3);
    for (let blackHole = 0; blackHole < n; blackHole += 1) {
      for (const positions of safeStartSets(n, blackHole)) {
        for (const script of schedules) {
          const label = `n=${n}, h=${blackHole}, starts=${positions}, period=${script}`;
          runToCorrectClaim({
            n,
            blackHole,
            positions,
            scheduler: { type: "scripted", script, repeat: true },
          }, 6 * n + 40 * n * n, label, (frame) => assertPhase1Boundary(frame, label));
          executions += 1;
        }
      }
    }
  }
  assert(executions === 4820, `expected 4820 executions, ran ${executions}`);
});

test("permanent safe cuts remain correct when introduced exactly at the Phase-1 boundary", () => {
  let executions = 0;
  for (let n = 5; n <= 9; n += 1) {
    for (let blackHole = 0; blackHole < n; blackHole += 1) {
      const positions = [1, 2, 3].map((offset) => G.mod(blackHole + offset, n));
      for (let missingEdge = 0; missingEdge < n; missingEdge += 1) {
        if (missingEdge === blackHole || missingEdge === G.mod(blackHole - 1, n)) continue;
        const script = Array(6 * n).fill(null)
          .concat(Array(40 * n * n).fill(missingEdge));
        const label = `boundary cut n=${n}, h=${blackHole}, edge=${missingEdge}`;
        runToCorrectClaim({
          n,
          blackHole,
          positions,
          scheduler: { type: "scripted", script },
        }, script.length, label, (frame) => assertPhase1Boundary(frame, label));
        executions += 1;
      }
    }
  }
  assert(executions === 185, `expected 185 executions, ran ${executions}`);
});

test("every co-located or partially co-located small-ring start handles periodic cuts", () => {
  const n = 4;
  const choices = [null, 0, 1, 2, 3];
  const schedules = combinations(choices, 2);
  let executions = 0;
  for (let blackHole = 0; blackHole < n; blackHole += 1) {
    for (const positions of safeStartMultisets(n, blackHole)) {
      for (const script of schedules) {
        runToCorrectClaim({
          n,
          blackHole,
          positions,
          scheduler: { type: "scripted", script, repeat: true },
        }, 6 * n + 40 * n * n,
        `co-location n=${n}, h=${blackHole}, starts=${positions}, period=${script}`,
        (frame) => assertPhase1Boundary(frame,
          `co-location n=${n}, h=${blackHole}, starts=${positions}, period=${script}`));
        executions += 1;
      }
    }
  }
  assert(executions === 1000, `expected 1000 executions, ran ${executions}`);
});

test("alternating the two black-hole incident edges exercises Pendulum without a false claim", () => {
  let executions = 0;
  for (let n = 5; n <= 12; n += 1) {
    for (let blackHole = 0; blackHole < n; blackHole += 1) {
      const start = G.mod(blackHole + 1, n);
      const script = [G.mod(blackHole - 1, n), blackHole];
      let sawRT = false;
      const groupIds = [0, 1, 2];
      const makeBoundaryMachine = (id) => new G.AgentMachine({
        id,
        n,
        initialMemory: {
          round: 6 * n + 1,
          phase: 1,
          mode: id === 2 ? G.Mode.JOINT_AVANGUARD : G.Mode.JOINT_LEADER,
          role: id === 2 ? G.Role.AVANGUARD : G.Role.LEADER,
          stage: G.Stage.READY,
          jointPartnerId: id === 2 ? 0 : 2,
          jointGroupIds: groupIds,
        },
      });
      runToCorrectClaim({
        n,
        blackHole,
        agents: [0, 1, 2].map((id) => ({ id, position: start, machine: makeBoundaryMachine(id) })),
        scheduler: { type: "scripted", script, repeat: true },
      }, 6 * n + 40 * n * n, `alternating incident edges n=${n}, h=${blackHole}`, (frame) => {
        sawRT ||= frame.agents.some((agent) =>
          agent.status === "ACTIVE" && agent.memory.mode.startsWith("RT_"));
      });
      assert(sawRT, `n=${n}, h=${blackHole}: RT was never entered`);
      executions += 1;
    }
  }
  assert(executions === 68, `expected 68 executions, ran ${executions}`);
});

test("interactive edge changes are effective immediately and survive scheduler snapshots", () => {
  const simulation = new G.Simulation({
    n: 7,
    blackHole: 6,
    positions: [0, 2, 4],
    scheduler: { type: "manual", missingEdge: null },
  });
  for (const edge of [0, 3, null, 5, null]) {
    const before = simulation.round;
    const changed = simulation.setManualMissingEdge(edge);
    assert(changed.round === before, "clicking an edge advanced the protocol round");
    assert(changed.missingEdge === edge, "observer frame did not update immediately");
    assert(changed.scheduler.missingEdge === edge, "scheduler snapshot disagrees with the ring");
    const stepped = simulation.step();
    assert(stepped.missingEdge === edge, "clicked omission was not used by the next round");
    checkFrame(stepped, `interactive edge ${edge}`);
  }
});

let failures = 0;
const started = Date.now();
for (const current of tests) {
  try {
    current.body();
    console.log(`PASS - ${current.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL - ${current.name}`);
    console.error(error.stack || String(error));
  }
}

const elapsed = Date.now() - started;
if (failures > 0) {
  console.error(`${failures} of ${tests.length} corner-case tests failed in ${elapsed} ms`);
  process.exitCode = 1;
} else {
  console.log(`${tests.length} corner-case tests passed in ${elapsed} ms`);
}
