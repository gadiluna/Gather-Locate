(function runTests(root) {
  "use strict";

  const G = root.GLSim;
  const tests = [];
  const test = (name, body) => tests.push({ name, body });

  function assert(condition, message) {
    if (!condition) throw new Error(message || "Assertion failed");
  }

  function equal(actual, expected, message) {
    if (G.stableStringify(actual) !== G.stableStringify(expected)) {
      throw new Error(`${message || "Values differ"}\nexpected ${JSON.stringify(expected)}\nactual   ${JSON.stringify(actual)}`);
    }
  }

  function localView(overrides) {
    return G.makeLocalView(Object.assign({
      ports: { clockwise: true, counterClockwise: true },
      pebbleCount: 0,
      coLocatedIds: [0],
      messages: [],
      lastOwnResult: { kind: "INITIAL", direction: G.Direction.STAY },
    }, overrides || {}));
  }

  function activate(machine, view, resultOverride) {
    const preparation = machine.prepare(view);
    const result = Object.assign({
      requested: preparation.pebbleOperation,
      success: preparation.pebbleOperation === G.PebbleOperation.NONE,
      count: 0,
      reason: "TEST",
    }, resultOverride || {});
    const intent = machine.decide(view, result);
    return { preparation, intent, memory: machine.snapshot() };
  }

  function runUntilClaim(simulation, limit, onFrame) {
    let frame = simulation.observerFrame();
    for (let round = 0; round < limit; round += 1) {
      frame = simulation.step();
      if (onFrame) onFrame(frame);
      const incorrect = frame.claims.find((claim) => claim.correct === false);
      assert(
        !incorrect,
        `an incorrect termination occurred for n=${frame.n}, h=${frame.blackHole}, round=${frame.round}: ${JSON.stringify(incorrect)}`,
      );
      if (frame.claims.some((claim) => claim.correct === true)) return frame;
    }
    return frame;
  }

  test("local views are frozen and contain no global capabilities", () => {
    const view = localView();
    assert(Object.isFrozen(view) && Object.isFrozen(view.ports), "local view must be deeply frozen");
    assert(!G.findForbiddenKey(view, "view"), "local view contains a forbidden field");
    for (const extra of ["blackHole", "blackHolePosition", "globalState", "allAgentPositions"]) {
      let rejected = false;
      try {
        G.validateLocalView(Object.assign({}, view, { [extra]: 3 }));
      } catch (_error) {
        rejected = true;
      }
      assert(rejected, `${extra} must be rejected`);
    }
  });

  test("private-memory restoration rejects unknown or global fields", () => {
    let rejected = false;
    try {
      new G.AgentMachine({ id: 0, n: 8, initialMemory: { blackHolePosition: 3 } });
    } catch (_error) {
      rejected = true;
    }
    assert(rejected, "global data must not be injectable into private memory");
  });

  test("the programmatic simulator enforces the paper's n greater than 3 assumption", () => {
    let machineRejected = false;
    let simulationRejected = false;
    try {
      new G.AgentMachine({ id: 0, n: 3 });
    } catch (_error) {
      machineRejected = true;
    }
    try {
      new G.Simulation({ n: 3, blackHole: 0, positions: [1, 1, 2], scheduler: { type: "none" } });
    } catch (_error) {
      simulationRejected = true;
    }
    assert(machineRejected && simulationRejected, "n=3 was accepted outside the theorem's domain");
  });

  test("a machine factory receives only the visible identifier and known n", () => {
    const capabilities = [];
    new G.Simulation({
      n: 8,
      blackHole: 7,
      positions: [0, 2, 4],
      scheduler: { type: "none" },
      agentFactory: (input) => {
        capabilities.push(Object.keys(input).sort());
        return new G.AgentMachine(input);
      },
    });
    assert(capabilities.length === 3, "factory was not called for each agent");
    capabilities.forEach((keys) => equal(keys, ["id", "n"], "factory received a physical position"));
  });

  test("the same local state and local view produce the same transition", () => {
    const left = new G.AgentMachine({ id: 0, n: 9 });
    const right = new G.AgentMachine({ id: 0, n: 9 });
    const view = localView();
    const leftStep = activate(left, view, { success: true, count: 1 });
    const rightStep = activate(right, view, { success: true, count: 1 });
    equal(leftStep, rightStep, "identical local inputs must be indistinguishable");
  });

  test("a black-hole probe leaves its pebble on the safe predecessor", () => {
    const simulation = new G.Simulation({
      n: 8,
      blackHole: 1,
      positions: [0, 3, 5],
      scheduler: { type: "none" },
    });
    const frame = simulation.step();
    const agent = frame.agents.find((item) => item.id === 0);
    const pebble = frame.pebbles.find((item) => item.id === "p0");
    assert(agent.status === "DESTROYED", "the probing agent must be destroyed");
    assert(pebble.status === "PLACED" && pebble.position === 0, "the pebble must remain at h-minus");
  });

  test("a missing clockwise edge blocks a cautious step before the pebble is placed", () => {
    const simulation = new G.Simulation({
      n: 8,
      blackHole: 7,
      positions: [0, 2, 4],
      scheduler: { type: "manual", missingEdge: 0 },
    });
    const frame = simulation.step();
    const agent = frame.agents.find((item) => item.id === 0);
    const pebble = frame.pebbles.find((item) => item.id === "p0");
    assert(agent.position === 0, "agent must remain at its node");
    assert(pebble.status === "CARRIED" && pebble.carrierId === 0, "agent must keep its pebble");
  });

  test("an interactive manual edge can be removed, moved, and restored", () => {
    const simulation = new G.Simulation({
      n: 8,
      blackHole: 7,
      positions: [0, 2, 4],
      scheduler: { type: "manual", missingEdge: null },
    });
    assert(simulation.setManualMissingEdge(1).missingEdge === 1, "interactive removal did not update the ring");
    assert(simulation.step().missingEdge === 1, "the clicked edge was not absent in the next round");
    assert(simulation.setManualMissingEdge(3).missingEdge === 3, "clicking another edge did not move the omission");
    assert(simulation.setManualMissingEdge(null).missingEdge === null, "clicking the missing edge did not restore it");
    assert(simulation.step().missingEdge === null, "the restored edge became absent again");
  });

  test("the manual pattern scheduler applies inclusive round intervals", () => {
    const scheduler = G.createScheduler({
      type: "pattern",
      pattern: "edge 1 absent from 2 to 4\nedge 2 absent from 6 to 7",
    }, 8);
    const actual = Array.from({ length: 8 }, (_item, index) =>
      scheduler.next({ round: index + 1, n: 8 }),
    );
    equal(actual, [null, 1, 1, 1, null, 2, 2, null], "pattern boundaries were not inclusive");
  });

  test("the manual pattern rejects malformed or overlapping rules", () => {
    let malformed = false;
    let overlapping = false;
    try {
      G.parseMissingEdgePattern("edge 1 missing from 2 to 4", 8);
    } catch (_error) {
      malformed = true;
    }
    try {
      G.parseMissingEdgePattern("edge 1 absent from 2 to 5\nedge 3 absent from 5 to 8", 8);
    } catch (_error) {
      overlapping = true;
    }
    assert(malformed, "a malformed pattern line was accepted");
    assert(overlapping, "two different edges were removed in the same round");
  });

  test("the missing-return test identifies the clockwise neighbour", () => {
    const simulation = new G.Simulation({
      n: 8,
      blackHole: 1,
      positions: [0, 3, 5],
      scheduler: { type: "none" },
    });
    let frame;
    for (let round = 0; round < 20; round += 1) {
      frame = simulation.step();
      if (frame.claims.length) break;
    }
    assert(frame.claims.length > 0, "a surviving agent should terminate");
    assert(frame.claims.every((claim) => claim.correct === true), "every claim must match observer truth");
  });

  test("a three-agent JointCW group persists through Phase 1 and becomes RT at the boundary", () => {
    const n = 5;
    const simulation = new G.Simulation({
      n,
      blackHole: 4,
      positions: [0, 1, 2],
      scheduler: { type: "manual", missingEdge: 3 },
    });
    let frame;
    let sawThreeAgentJointCW = false;
    for (let round = 1; round <= 6 * n; round += 1) {
      frame = simulation.step();
      assert(
        !frame.agents.some((agent) => agent.memory.mode.startsWith("RT_")),
        `CautiousPendulum started during Phase 1 in round ${round}`,
      );
      const joint = frame.agents.filter((agent) => agent.memory.mode.startsWith("JOINT_"));
      if (joint.length === 3) {
        sawThreeAgentJointCW = true;
        equal(
          joint.map((agent) => agent.memory.role).sort(),
          [G.Role.AVANGUARD, G.Role.LEADER, G.Role.LEADER].sort(),
          "three-agent JointCW must have one Avanguard and two Leaders",
        );
      }
    }
    assert(sawThreeAgentJointCW, "the execution never formed a three-agent JointCW group");
    assert(frame.round === 6 * n && frame.phase === 1, "the last Phase-1 frame must be round 6n");
    assert(
      frame.agents.every((agent) => agent.memory.mode.startsWith("JOINT_")),
      "the co-located three-agent group must remain JointCW through round 6n",
    );
    assert(
      new Set(frame.agents.map((agent) => agent.position)).size === 1,
      "this boundary regression must reach three co-located JointCW agents",
    );
    frame = simulation.step();
    assert(frame.round === 6 * n + 1 && frame.phase === 2, "CautiousPendulum must start exactly in round 6n+1");
    assert(
      frame.agents.every((agent) => agent.memory.mode.startsWith("RT_")),
      "all three co-located agents must switch from JointCW to RT at the boundary",
    );
    equal(
      frame.agents.map((agent) => agent.memory.role).sort(),
      [G.Role.AVANGUARD, G.Role.LEADER, G.Role.RETROGUARD].sort(),
      "the three local machines must select the RT roles in round 6n+1",
    );
  });

  test("a three-member JointCW completed return preserves the group and performs one final crossing", () => {
    const n = 7;
    const groupIds = [0, 1, 2];
    const machines = groupIds.map((id) => new G.AgentMachine({
      id,
      n,
      initialMemory: {
        mode: id === 2 ? G.Mode.JOINT_AVANGUARD : G.Mode.JOINT_LEADER,
        role: id === 2 ? G.Role.AVANGUARD : G.Role.LEADER,
        stage: id === 2 ? G.Stage.RETURNED : G.Stage.WAITING,
        jointPartnerId: id === 2 ? 0 : 2,
        jointGroupIds: groupIds,
        carriedPebbles: id === 2 ? 0 : 1,
        ownPebbleOutstanding: id === 2,
        expectReturn: id !== 2,
      },
    }));
    const announcements = new Map(machines.map((machine) => {
      const id = machine.snapshot().id;
      return [id, machine.announce()];
    }));
    const viewFor = (id, pebbleCount) => G.makeLocalView({
      ports: { clockwise: true, counterClockwise: true },
      pebbleCount,
      coLocatedIds: groupIds,
      messages: groupIds.filter((peerId) => peerId !== id).map((peerId) => announcements.get(peerId)),
      lastOwnResult: id === 2
        ? { kind: G.OwnResultKind.MOVED, direction: G.Direction.COUNTER_CLOCKWISE }
        : { kind: G.OwnResultKind.STAYED, direction: G.Direction.STAY },
    });

    const preparations = machines.map((machine) => machine.prepare(viewFor(machine.snapshot().id, 1)));
    equal(
      preparations.map((preparation) => preparation.pebbleOperation),
      [G.PebbleOperation.NONE, G.PebbleOperation.NONE, G.PebbleOperation.TAKE_ALL],
      "only the returning Avanguard may recover the cautious-step pebble",
    );
    const intents = machines.map((machine, index) => machine.decide(
      viewFor(machine.snapshot().id, 0),
      {
        requested: preparations[index].pebbleOperation,
        success: true,
        count: index === 2 ? 1 : 0,
        reason: "TEST",
      },
    ));
    const memories = machines.map((machine) => machine.snapshot());

    equal(
      intents.map((intent) => intent.action),
      [G.Action.MOVE_CW, G.Action.MOVE_CW, G.Action.MOVE_CW],
      "both Leaders and the Avanguard must make the certified final crossing together",
    );
    equal(
      memories.map((memory) => memory.mode),
      [G.Mode.JOINT_LEADER, G.Mode.JOINT_LEADER, G.Mode.JOINT_AVANGUARD],
      "a completed return must not convert the three-agent group to RT during Phase 1",
    );
    assert(memories.every((memory) => memory.stage === G.Stage.READY), "the final crossing must complete the cautious step");
    memories.forEach((memory) => equal(memory.jointGroupIds, groupIds, "the three-member JointCW group changed"));
    assert(memories[2].carriedPebbles === 1, "the returning Avanguard did not recover its pebble");
  });

  test("the failed-report threshold is checked on the following activation", () => {
    const n = 6;
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
    const simulation = new G.Simulation({
      n,
      blackHole: n - 1,
      agents: [
        { id: 0, position: 0, machine: makeBoundaryMachine(0) },
        { id: 1, position: 0, machine: makeBoundaryMachine(1) },
        { id: 2, position: 0, machine: makeBoundaryMachine(2) },
      ],
      scheduler: { type: "manual", missingEdge: 0 },
    });
    let frame;
    for (let round = 1; round <= 2 * n + 1; round += 1) frame = simulation.step();
    assert(frame.claims.length === 0, "the departure round plus 2n counted rounds must not terminate early");
    frame = simulation.step();
    assert(frame.claims.length === 1 && frame.claims[0].correct, "the next activation must terminate correctly");
  });

  test("failed-report counts are backed by blocked clockwise movement intents", () => {
    const cases = [
      {
        label: "RT Leader",
        mode: G.Mode.RT_LEADER,
        role: G.Role.LEADER,
        stage: G.Stage.READY,
        pebbleCount: 0,
      },
      {
        label: "AggressiveLeader",
        mode: G.Mode.BCP_AGGRESSIVE_LEADER,
        role: G.Role.AGGRESSIVE_LEADER,
        stage: G.Stage.AT_MARK,
        pebbleCount: 1,
      },
    ];

    for (const current of cases) {
      const makeMachine = () => new G.AgentMachine({
        id: 0,
        n: 6,
        initialMemory: {
          phase: 2,
          round: 50,
          mode: current.mode,
          role: current.role,
          stage: current.stage,
          departure: 1,
          failedReport: 3,
          reportActive: true,
        },
      });
      const blocked = activate(makeMachine(), localView({
        ports: { clockwise: false, counterClockwise: true },
        pebbleCount: current.pebbleCount,
      }));
      assert(blocked.intent.action === G.Action.MOVE_CW,
        `${current.label} counted an absent edge without attempting a clockwise traversal`);
      assert(blocked.memory.failedReport === 4,
        `${current.label} did not count its blocked clockwise attempt`);

      const present = activate(makeMachine(), localView({ pebbleCount: current.pebbleCount }));
      assert(present.intent.action === G.Action.STAY,
        `${current.label} must stay when its clockwise edge is present and it is waiting`);
      assert(present.memory.failedReport === 3,
        `${current.label} counted a failed report without a blocked attempt`);
    }
  });

  test("CautiousPendulum handles either black-hole-incident edge missing forever", () => {
    let executions = 0;
    for (let n = 5; n <= 12; n += 1) {
      for (let blackHole = 0; blackHole < n; blackHole += 1) {
        const origin = G.mod(blackHole + 1, n);
        const incidentEdges = [G.mod(blackHole - 1, n), blackHole];
        for (const missingEdge of incidentEdges) {
          const makeMachine = (id, mode, role, stage) => new G.AgentMachine({
            id,
            n,
            initialMemory: {
              round: 6 * n + 1,
              phase: 2,
              mode,
              role,
              stage,
              departure: 1,
              reportActive: role === G.Role.LEADER,
              retroTarget: -1,
            },
          });
          const simulation = new G.Simulation({
            n,
            blackHole,
            agents: [
              { id: 0, position: origin, machine: makeMachine(0, G.Mode.RT_LEADER, G.Role.LEADER, G.Stage.READY) },
              { id: 1, position: origin, machine: makeMachine(1, G.Mode.RT_AVANGUARD, G.Role.AVANGUARD, G.Stage.READY) },
              { id: 2, position: origin, machine: makeMachine(2, G.Mode.RT_RETROGUARD, G.Role.RETROGUARD, G.Stage.OUTBOUND) },
            ],
            scheduler: { type: "manual", missingEdge },
          });
          let sawCautiousPendulum = false;
          const frame = runUntilClaim(simulation, 10 * n * n, (current) => {
            sawCautiousPendulum ||= current.agents.some((agent) => agent.memory.mode.startsWith("RT_"));
          });
          assert(sawCautiousPendulum, "the three-agent subprocedure was not entered");
          assert(frame.claims.some((claim) => claim.correct === true), "a permanent incident cut prevented termination");
          executions += 1;
        }
      }
    }
    assert(executions === 136, "not every incident-edge rotation was tested");
  });

  test("a permanent edge away from the black hole cannot prevent a correct termination", () => {
    let executions = 0;
    let sawMissingReturn = false;
    let sawFailedReport = false;
    for (let n = 5; n <= 8; n += 1) {
      const safe = Array.from({ length: n - 1 }, (_item, index) => index + 1);
      for (let missingEdge = 1; missingEdge <= n - 2; missingEdge += 1) {
        for (let first = 0; first < safe.length - 2; first += 1) {
          for (let second = first + 1; second < safe.length - 1; second += 1) {
            for (let third = second + 1; third < safe.length; third += 1) {
              const simulation = new G.Simulation({
                n,
                blackHole: 0,
                positions: [safe[first], safe[second], safe[third]],
                scheduler: { type: "manual", missingEdge },
              });
              const frame = runUntilClaim(simulation, 6 * n + 20 * n * n);
              const correct = frame.claims.find((claim) => claim.correct === true);
              assert(correct, `non-incident cut ${missingEdge} prevented termination for n=${n}`);
              sawMissingReturn ||= correct.reason.includes("preceding round");
              sawFailedReport ||= correct.reason.includes("failed-report counter");
              executions += 1;
            }
          }
        }
      }
    }
    assert(executions === 362, "not every non-incident cut and safe start set was tested");
    assert(sawMissingReturn && sawFailedReport, "the matrix did not exercise both termination mechanisms");
  });

  test("an agent completing its own return does not become a follower of an unrelated probe", () => {
    const script = [null].concat(Array(199).fill(2));
    const simulation = new G.Simulation({
      n: 5,
      blackHole: 0,
      positions: [1, 2, 3],
      scheduler: { type: "scripted", script, repeat: false },
    });
    simulation.step();
    simulation.step();
    const third = simulation.step().agents.find((agent) => agent.id === 2);
    assert(third.position === 4, "the completed cautious step must make its final clockwise crossing");
    assert(third.memory.mode === G.Mode.PHASE1_CW, "the returning agent must keep its own cautious-walk state");
    assert(third.memory.mode !== G.Mode.FOLLOW_RETURN, "an own return was incorrectly converted to FollowReturn");
    const frame = runUntilClaim(simulation, 197);
    assert(frame.claims.some((claim) => claim.correct === true), "the open-then-permanent-cut execution did not terminate");
  });

  test("FollowReturn is entered only when the return edge is present", () => {
    const script = [3].concat(Array(199).fill(2));
    const simulation = new G.Simulation({
      n: 5,
      blackHole: 0,
      positions: [1, 2, 3],
      scheduler: { type: "scripted", script, repeat: false },
    });
    simulation.step();
    const second = simulation.step();
    const encountered = second.agents.find((agent) => agent.id === 2);
    assert(encountered.position === 4, "the non-returning agent must continue clockwise when the return edge is absent");
    assert(encountered.memory.mode === G.Mode.PHASE1_CW, "a blocked follower was left at the probe endpoint");
    const frame = runUntilClaim(simulation, 198);
    assert(frame.claims.some((claim) => claim.correct === true), "the blocked-return regression did not terminate");
  });

  test("JointCW partners stay committed under the reported permanent-cut schedule", () => {
    const script = [0, 2, 1, 2, 3, 3, 3].concat(Array(20).fill(0));
    const simulation = new G.Simulation({
      n: 5,
      blackHole: 2,
      positions: [3, 4, 0],
      scheduler: { type: "scripted", script, repeat: false },
    });

    let frame;
    for (let round = 1; round <= 4; round += 1) frame = simulation.step();
    let leader = frame.agents.find((agent) => agent.id === 1);
    let avanguard = frame.agents.find((agent) => agent.id === 2);
    assert(leader.position === 0 && leader.memory.mode === G.Mode.JOINT_LEADER,
      "the JointCW Leader was not waiting at the marked endpoint");
    assert(avanguard.position === 1 && avanguard.memory.stage === G.Stage.PROBE,
      "the JointCW Avanguard was not performing its probe");

    frame = simulation.step();
    leader = frame.agents.find((agent) => agent.id === 1);
    avanguard = frame.agents.find((agent) => agent.id === 2);
    assert(leader.position === 0 && leader.memory.mode === G.Mode.JOINT_LEADER,
      "the Leader followed an unrelated return and abandoned its Avanguard");
    assert(leader.memory.jointPartnerId === 2 && avanguard.memory.jointPartnerId === 1,
      "the JointCW partnership changed during its cautious step");

    frame = simulation.step();
    leader = frame.agents.find((agent) => agent.id === 1);
    avanguard = frame.agents.find((agent) => agent.id === 2);
    assert(leader.position === 1 && avanguard.position === 1,
      "the committed pair did not complete its certified final crossing together");
    assert(leader.memory.mode === G.Mode.JOINT_LEADER && avanguard.memory.mode === G.Mode.JOINT_AVANGUARD,
      "the pair changed roles before finishing its JointCW step");

    frame = runUntilClaim(simulation, 20);
    assert(frame.claims.some((claim) => claim.correct === true),
      "the reported schedule did not produce a correct termination");
  });

  test("a singleton meeting a committed JointCW Leader cannot absorb or reassign the pair", () => {
    const groupIds = [1, 2];
    const leader = new G.AgentMachine({
      id: 1,
      n: 7,
      initialMemory: {
        mode: G.Mode.JOINT_LEADER,
        role: G.Role.LEADER,
        stage: G.Stage.WAITING,
        jointPartnerId: 2,
        jointGroupIds: groupIds,
      },
    });
    const singleton = new G.AgentMachine({ id: 0, n: 7 });
    const leaderMessage = leader.announce();
    const singletonMessage = singleton.announce();
    const leaderResult = activate(leader, localView({
      ports: { clockwise: false, counterClockwise: true },
      pebbleCount: 1,
      coLocatedIds: [0, 1],
      messages: [singletonMessage],
    }));
    const singletonResult = activate(singleton, localView({
      ports: { clockwise: false, counterClockwise: true },
      pebbleCount: 1,
      coLocatedIds: [0, 1],
      messages: [leaderMessage],
    }));

    assert(leaderResult.memory.mode === G.Mode.JOINT_LEADER, "the committed Leader was reassigned");
    equal(leaderResult.memory.jointGroupIds, groupIds, "the singleton changed the committed pair membership");
    assert(leaderResult.memory.jointPartnerId === 2, "the singleton replaced the committed Avanguard");
    assert(singletonResult.memory.mode === G.Mode.PHASE1_WAIT, "the singleton must wait at the committed pair's pebble");
    equal(singletonResult.memory.jointGroupIds, [], "the waiting singleton incorrectly joined the unfinished step");
    assert(singletonResult.intent.action === G.Action.STAY, "the singleton moved while the pair's return was pending");
  });

  test("a committed JointCW Leader ignores an unrelated completed return", () => {
    const machine = new G.AgentMachine({
      id: 1,
      n: 5,
      initialMemory: {
        mode: G.Mode.JOINT_LEADER,
        role: G.Role.LEADER,
        stage: G.Stage.WAITING,
        jointPartnerId: 2,
      },
    });
    const result = activate(machine, localView({
      ports: { clockwise: false, counterClockwise: true },
      pebbleCount: 1,
      coLocatedIds: [0, 1],
      messages: [{
        id: 0,
        mode: G.Mode.PHASE1_CW,
        stage: G.Stage.RETURNED,
        role: G.Role.NONE,
        event: G.MessageEvent.RETURN_COMPLETED,
      }],
    }));
    assert(result.memory.mode === G.Mode.JOINT_LEADER && result.memory.jointPartnerId === 2,
      "an unrelated completed return changed the committed Leader's role or partner");
    assert(result.intent.action === G.Action.STAY,
      "the committed Leader moved while waiting for its own Avanguard");
  });

  test("a completed-return group excludes an unrelated pending probe", () => {
    const script = [0].concat(Array(99).fill(3));
    const simulation = new G.Simulation({
      n: 5,
      blackHole: 1,
      positions: [0, 3, 4],
      scheduler: { type: "scripted", script, repeat: false },
    });
    simulation.step();
    simulation.step();
    const third = simulation.step();
    const first = third.agents.find((agent) => agent.id === 0);
    const pending = third.agents.find((agent) => agent.id === 1);
    const returned = third.agents.find((agent) => agent.id === 2);
    assert(first.memory.mode === G.Mode.JOINT_LEADER, "the completed-return subgroup did not select its Leader");
    assert(returned.memory.mode === G.Mode.JOINT_AVANGUARD, "the completed-return subgroup did not select its Avanguard");
    assert(pending.memory.mode === G.Mode.PHASE1_CW && pending.memory.stage === G.Stage.PROBE,
      "the unrelated pending probe was incorrectly assigned a new role");
    assert(!third.agents.some((agent) => agent.memory.mode.startsWith("RT_")), "a spurious three-agent RT group was created");
    const frame = runUntilClaim(simulation, 97);
    assert(frame.claims.some((claim) => claim.correct === true), "the return-group regression did not terminate");
  });

  test("BackwardCP starts from the post-recovery pebble configuration", () => {
    const script = Array(25).fill(2).concat(Array(75).fill(0));
    const simulation = new G.Simulation({
      n: 5,
      blackHole: 0,
      positions: [1, 2, 3],
      scheduler: { type: "scripted", script, repeat: false },
    });
    let frame;
    for (let round = 0; round < 31; round += 1) frame = simulation.step();
    const leader = frame.agents.find((agent) => agent.memory.mode === G.Mode.BCP_AGGRESSIVE_LEADER);
    assert(leader, "the two survivors did not start BackwardCP");
    assert(leader.memory.stage === G.Stage.MOVING, "the removed temporary pebble was mistaken for a permanent mark");
    assert(leader.memory.expectReturn === false, "the stale pebble armed a false missing-return test");
    assert(frame.pebbles.filter((pebble) => pebble.status === "PLACED").length === 1,
      "the temporary pebble was not recovered before BackwardCP moved in the return activation");
    frame = runUntilClaim(simulation, 69);
    assert(frame.claims.some((claim) => claim.correct === true), "the post-recovery BackwardCP execution did not terminate");
  });

  test("two survivors co-located at the Phase-2 boundary finish through BackwardCP", () => {
    const simulation = new G.Simulation({
      n: 5,
      blackHole: 0,
      positions: [1, 2, 3],
      scheduler: { type: "manual", missingEdge: 2 },
    });
    let sawExactlyTwo = false;
    let sawBackwardCP = false;
    const frame = runUntilClaim(simulation, 300, (current) => {
      sawExactlyTwo ||= current.agents.filter((agent) => agent.status === "ACTIVE").length === 2;
      sawBackwardCP ||= current.agents.some((agent) => agent.memory.mode.startsWith("BCP_"));
    });
    assert(sawExactlyTwo, "the test never reached exactly two surviving active agents");
    assert(sawBackwardCP, "the two survivors did not start BackwardCP");
    assert(frame.claims.some((claim) => claim.correct === true), "BackwardCP did not finish correctly");
  });

  test("rotating the anonymous ring preserves every agent's local trace", () => {
    const n = 9;
    const rotation = 3;
    const script = [null, 0, 4, null, 7, 2, null, 5, 1, null];
    const rotatedScript = script.map((edge) => edge === null ? null : G.mod(edge + rotation, n));
    const first = new G.Simulation({
      n,
      blackHole: 8,
      positions: [0, 2, 5],
      scheduler: { type: "scripted", script, repeat: true },
    });
    const second = new G.Simulation({
      n,
      blackHole: G.mod(8 + rotation, n),
      positions: [0, 2, 5].map((position) => G.mod(position + rotation, n)),
      scheduler: { type: "scripted", script: rotatedScript, repeat: true },
    });
    for (let round = 0; round < 30; round += 1) {
      const a = first.step();
      const b = second.step();
      equal(
        a.agents.map((agent) => ({ status: agent.status, memory: agent.memory, intent: agent.lastIntent })),
        b.agents.map((agent) => ({ status: agent.status, memory: agent.memory, intent: agent.lastIntent })),
        `rotation changed a local trace in round ${round + 1}`,
      );
    }
  });

  test("permuting the kernel's agent array does not change the execution", () => {
    const config = {
      n: 8,
      blackHole: 7,
      scheduler: { type: "random", seed: 61, omissionProbability: 0.65 },
    };
    const ordered = new G.Simulation(Object.assign({}, config, {
      agents: [{ id: 0, position: 0 }, { id: 1, position: 2 }, { id: 2, position: 4 }],
    }));
    const permuted = new G.Simulation(Object.assign({}, config, {
      agents: [{ id: 2, position: 4 }, { id: 0, position: 0 }, { id: 1, position: 2 }],
    }));
    for (let round = 0; round < 50; round += 1) {
      const normalize = (frame) => frame.agents
        .map((agent) => ({ id: agent.id, position: agent.position, status: agent.status, memory: agent.memory, intent: agent.lastIntent }))
        .sort((left, right) => left.id - right.id);
      equal(normalize(ordered.step()), normalize(permuted.step()), `agent-array order affected round ${round + 1}`);
    }
  });

  test("Phase 2 is entered from the local clock and local configuration", () => {
    const n = 5;
    const machine = new G.AgentMachine({
      id: 0,
      n,
      initialMemory: {
        round: 6 * n + 1,
        phase: 1,
        mode: G.Mode.PHASE1_WAIT,
        stage: G.Stage.WAITING,
      },
    });
    const result = activate(machine, localView({
      ports: { clockwise: false, counterClockwise: true },
      pebbleCount: 1,
    }));
    assert(result.memory.mode === G.Mode.PHASE2_WAIT, "the marked-side agent must enter its local Phase-2 wait state");
    assert(result.memory.p2Elapsed === 1, "round 6n+1 must be the first counted timeout round");
  });

  test("both separated agents independently enter Forward after 4n squared rounds", () => {
    const n = 5;
    const timeout = 4 * n * n;
    const waiter = new G.AgentMachine({
      id: 0,
      n,
      initialMemory: {
        round: 6 * n + timeout + 1,
        phase: 2,
        mode: G.Mode.PHASE2_WAIT,
        stage: G.Stage.WAITING,
        p2Elapsed: timeout,
        carriedPebbles: 0,
      },
    });
    const returner = new G.AgentMachine({
      id: 1,
      n,
      initialMemory: {
        round: 6 * n + timeout + 1,
        phase: 2,
        mode: G.Mode.PHASE2_RETURN,
        stage: G.Stage.PROBE,
        p2Elapsed: timeout,
        carriedPebbles: 0,
        ownPebbleOutstanding: true,
      },
    });
    const waiterView = G.makeLocalView({
      ports: { clockwise: false, counterClockwise: true },
      pebbleCount: 1,
      coLocatedIds: [0],
      messages: [],
      lastOwnResult: { kind: "EDGE_ABSENT", direction: "CW" },
    });
    const returnerView = G.makeLocalView({
      ports: { clockwise: true, counterClockwise: false },
      pebbleCount: 0,
      coLocatedIds: [1],
      messages: [],
      lastOwnResult: { kind: "EDGE_ABSENT", direction: "CCW" },
    });
    const waitPreparation = waiter.prepare(waiterView);
    waiter.decide(waiterView, { requested: waitPreparation.pebbleOperation, success: true, count: 1, reason: "TEST" });
    activate(returner, returnerView);
    assert(waiter.snapshot().mode === G.Mode.FORWARD, "marked-side waiter must enter Forward");
    assert(returner.snapshot().mode === G.Mode.FORWARD, "returning-side agent must enter Forward");
    assert(waiter.snapshot().carriedPebbles === 1, "the marked-side agent must take the temporary pebble");
  });

  test("a return completed at the timeout boundary is handled before Forward", () => {
    const n = 5;
    const timeout = 4 * n * n;
    const waiter = new G.AgentMachine({
      id: 0,
      n,
      initialMemory: {
        round: 6 * n + timeout + 1,
        phase: 2,
        mode: G.Mode.PHASE2_WAIT,
        stage: G.Stage.WAITING,
        p2Elapsed: timeout,
      },
    });
    const returner = new G.AgentMachine({
      id: 1,
      n,
      initialMemory: {
        round: 6 * n + timeout + 1,
        phase: 2,
        mode: G.Mode.PHASE2_RETURN,
        stage: G.Stage.RETURNED,
        p2Elapsed: timeout,
        carriedPebbles: 0,
        ownPebbleOutstanding: true,
      },
    });
    const waiterMessage = waiter.announce();
    const returnMessage = returner.announce();
    const waiterView = G.makeLocalView({
      ports: { clockwise: true, counterClockwise: true },
      pebbleCount: 1,
      coLocatedIds: [0, 1],
      messages: [returnMessage],
      lastOwnResult: { kind: "STAYED", direction: "STAY" },
    });
    const returnerView = G.makeLocalView({
      ports: { clockwise: true, counterClockwise: true },
      pebbleCount: 1,
      coLocatedIds: [0, 1],
      messages: [waiterMessage],
      lastOwnResult: { kind: "MOVED", direction: "CCW" },
    });
    const waiterPreparation = waiter.prepare(waiterView);
    const returnPreparation = returner.prepare(returnerView);
    const postViewForWaiter = G.makeLocalView(Object.assign({}, waiterView, { pebbleCount: 0 }));
    const postViewForReturner = G.makeLocalView(Object.assign({}, returnerView, { pebbleCount: 0 }));
    const waiterIntent = waiter.decide(
      postViewForWaiter,
      { requested: waiterPreparation.pebbleOperation, success: true, count: 0, reason: "TEST" },
    );
    const returnerIntent = returner.decide(
      postViewForReturner,
      { requested: returnPreparation.pebbleOperation, success: true, count: 1, reason: "TEST" },
    );
    assert(waiter.snapshot().mode === G.Mode.BCP_AGGRESSIVE_LEADER, "waiting agent must start BackwardCP");
    assert(returner.snapshot().mode === G.Mode.BCP_RETROGUARD, "returning agent must start BackwardCP");
    assert(waiterIntent.action === G.Action.MOVE_CW,
      "AggressiveLeader must start moving in the completed-return activation");
    assert(returnerIntent.action === G.Action.MOVE_CCW,
      "Retroguard must start its departure in the completed-return activation");
  });

  test("BackwardCP states never apply the separated timeout", () => {
    const n = 5;
    const machine = new G.AgentMachine({
      id: 0,
      n,
      initialMemory: {
        round: 200,
        phase: 2,
        mode: G.Mode.BCP_AGGRESSIVE_LEADER,
        role: G.Role.AGGRESSIVE_LEADER,
        stage: G.Stage.MOVING,
        p2Elapsed: 1000,
        reportActive: true,
        departure: 1,
      },
    });
    const result = activate(machine, localView());
    assert(result.memory.mode === G.Mode.BCP_AGGRESSIVE_LEADER, "BackwardCP must remain active");
    assert(result.intent.action === G.Action.MOVE_CW, "AggressiveLeader must follow its own movement rule");
  });

  test("Forward terminates from a local pebble with a relative claim", () => {
    const n = 7;
    const machine = new G.AgentMachine({
      id: 0,
      n,
      initialMemory: { phase: 2, round: 100, mode: G.Mode.FORWARD, role: G.Role.FORWARD, stage: G.Stage.MOVING },
    });
    const result = activate(machine, localView({ pebbleCount: 1 }));
    assert(result.intent.action === G.Action.TERMINATE, "Forward must terminate at a local pebble");
    equal(result.intent.claim, G.makeClaim(1, n - 1, "Forward encountered the permanent black-hole mark"));
  });

  test("a Phase-2 returner checks a local permanent mark before its first Forward move", () => {
    const script = [null, null, null, null].concat(Array(196).fill(3));
    const simulation = new G.Simulation({
      n: 5,
      blackHole: 0,
      positions: [1, 2, 3],
      scheduler: { type: "scripted", script, repeat: false },
    });
    const frame = runUntilClaim(simulation, 200);
    const claim = frame.claims.find((item) => item.correct === true);
    assert(claim, "the returner did not identify the mark already at its node");
    assert(claim.position === 4 && claim.clockwiseNode === 0, "the returner claimed the wrong marked neighbour");
    const returner = frame.agents.find((agent) => agent.id === claim.agentId);
    assert(returner.status === "TERMINATED", "the returner moved into the black hole instead of terminating");
  });

  test("a reachable two-survivor timeout enters Forward and terminates at the permanent mark", () => {
    const n = 8;
    const script = Array.from({ length: 400 }, (_item, index) => {
      const round = index + 1;
      if (round <= 10) return 4;
      if (round === 11) return null;
      if (round <= 305) return 4;
      return null;
    });
    const simulation = new G.Simulation({
      n,
      blackHole: 0,
      positions: [7, 1, 4],
      scheduler: { type: "scripted", script, repeat: false },
    });
    let sawExactlyTwo = false;
    let sawSeparatedTimeout = false;
    let sawBothForward = false;
    const frame = runUntilClaim(simulation, 400, (current) => {
      const active = current.agents.filter((agent) => agent.status === "ACTIVE");
      sawExactlyTwo ||= active.length === 2 && current.agents.some((agent) => agent.status === "DESTROYED");
      const modes = active.map((agent) => agent.memory.mode).sort();
      sawSeparatedTimeout ||= modes.includes(G.Mode.PHASE2_RETURN) && modes.includes(G.Mode.PHASE2_WAIT);
      sawBothForward ||= modes.length === 2 && modes.every((mode) => mode === G.Mode.FORWARD);
    });
    assert(sawExactlyTwo, "the execution did not exercise the two-survivor case");
    assert(sawSeparatedTimeout, "the survivors did not remain on opposite endpoints through Phase 2");
    assert(sawBothForward, "both separated survivors did not enter Forward");
    assert(
      frame.claims.some((claim) => claim.correct === true && claim.reason.includes("Forward sees a pebble")),
      "Forward did not terminate at the permanent black-hole mark",
    );
  });

  test("two Forward agents that meet switch to BackwardCP and still terminate", () => {
    const n = 8;
    const script = Array.from({ length: 500 }, (_item, index) => {
      const round = index + 1;
      if (round <= 10) return 4;
      if (round === 11) return null;
      if (round <= 305) return 4;
      return 6;
    });
    const simulation = new G.Simulation({
      n,
      blackHole: 0,
      positions: [7, 1, 4],
      scheduler: { type: "scripted", script, repeat: false },
    });
    let sawForward = false;
    let sawBackwardCP = false;
    const frame = runUntilClaim(simulation, 500, (current) => {
      sawForward ||= current.agents.some((agent) => agent.memory.mode === G.Mode.FORWARD);
      sawBackwardCP ||= current.agents.some((agent) => agent.memory.mode.startsWith("BCP_"));
    });
    assert(sawForward, "the execution never entered Forward");
    assert(sawBackwardCP, "the Forward meeting did not start BackwardCP");
    assert(frame.claims.some((claim) => claim.correct === true), "the post-Forward BackwardCP execution did not terminate");
  });

  test("BackwardCP-to-RT preserves counters and moves in the completed-return activation", () => {
    const n = 9;
    const leader = new G.AgentMachine({
      id: 0,
      n,
      initialMemory: {
        phase: 2,
        round: 80,
        mode: G.Mode.BCP_AGGRESSIVE_LEADER,
        role: G.Role.AGGRESSIVE_LEADER,
        stage: G.Stage.AT_MARK,
        ell: 3,
        departure: 2,
        failedReport: 4,
        reportActive: true,
      },
    });
    const returnMessage = { id: 1, mode: G.Mode.PHASE2_RETURN, stage: G.Stage.RETURNED, role: G.Role.NONE, event: "RETURN_COMPLETED" };
    const view = G.makeLocalView({
      ports: { clockwise: true, counterClockwise: true },
      pebbleCount: 1,
      coLocatedIds: [0, 1],
      messages: [returnMessage],
      lastOwnResult: { kind: "STAYED", direction: "STAY" },
    });
    const preparation = leader.prepare(view);
    const postRecoveryView = G.makeLocalView(Object.assign({}, view, { pebbleCount: 0 }));
    const intent = leader.decide(postRecoveryView, {
      requested: preparation.pebbleOperation,
      success: true,
      count: 0,
      reason: "TEST",
    });
    const memory = leader.snapshot();
    assert(memory.mode === G.Mode.RT_LEADER, "AggressiveLeader must locally become Leader");
    assert(memory.departure === 2 && memory.failedReport === 4, "departure information must be preserved");
    assert(intent.action === G.Action.MOVE_CW, "the certified RT crossing must occur in the return activation");
    assert(memory.ell === 4, "ell must increment on the same-round certified crossing");
  });

  test("adversarial one-edge schedulers preserve safety and bounded termination", () => {
    const families = ["rotating", "reverse", "incident", "block-clockwise", "block-probe-return", "shield-black-hole"];
    let executions = 0;

    for (let n = 5; n <= 8; n += 1) {
      for (let blackHole = 0; blackHole < n; blackHole += 1) {
        const positions = [];
        for (let node = 0; node < n && positions.length < 3; node += 1) {
          if (node !== blackHole) positions.push(node);
        }

        for (const family of families) {
          let simulation;
          // This adversary may inspect physical state to choose the next cut;
          // that information remains in the scheduler/kernel and is never
          // included in an agent's local view.
          const scheduler = {
            next(context) {
              const round = context.round;
              if (family === "rotating") return G.mod(round - 1, n);
              if (family === "reverse") return G.mod(1 - round, n);
              if (family === "incident") {
                return round % 2 === 1 ? G.mod(blackHole - 1, n) : blackHole;
              }

              const active = simulation.agents
                .filter((agent) => agent.alive && !agent.terminated)
                .sort((left, right) => left.id - right.id);
              if (family === "block-clockwise") return active.length ? active[0].position : null;
              if (family === "block-probe-return") {
                const probe = active.find((agent) => agent.machine.snapshot().stage === G.Stage.PROBE);
                return probe ? G.mod(probe.position - 1, n) : (active.length ? active[0].position : null);
              }
              const clockwiseEntry = active.find((agent) => G.mod(agent.position + 1, n) === blackHole);
              if (clockwiseEntry) return clockwiseEntry.position;
              const counterClockwiseEntry = active.find((agent) => G.mod(agent.position - 1, n) === blackHole);
              if (counterClockwiseEntry) return G.mod(counterClockwiseEntry.position - 1, n);
              return G.mod(round - 1, n);
            },
            snapshot() {
              return { type: `test-${family}` };
            },
          };
          simulation = new G.Simulation({ n, blackHole, positions, scheduler });
          let frame;
          try {
            frame = runUntilClaim(simulation, 6 * n + 40 * n * n);
          } catch (error) {
            throw new Error(`${family} scheduler failed for n=${n}, h=${blackHole}: ${error.message}`);
          }
          assert(
            frame.claims.some((claim) => claim.correct === true),
            `${family} scheduler prevented termination for n=${n}, h=${blackHole}`,
          );
          executions += 1;
        }
      }
    }
    assert(executions === 156, "not every adversarial execution was tested");
  });

  test("seeded property traces contain no incorrect termination", () => {
    let executions = 0;
    for (let n = 5; n <= 10; n += 1) {
      for (let seed = 1; seed <= 20; seed += 1) {
        const blackHole = G.mod(seed * 3, n);
        const positions = [];
        for (let node = 0; node < n && positions.length < 3; node += 1) {
          if (node !== blackHole) positions.push(node);
        }
        const simulation = new G.Simulation({
          n,
          blackHole,
          positions,
          scheduler: { type: "random", seed: seed * 97 + n, omissionProbability: 0.7 },
        });
        let frame;
        for (let round = 0; round < 6 * n + 18 * n * n; round += 1) {
          frame = simulation.step();
          assert(!frame.claims.some((claim) => claim.correct === false), "an incorrect termination occurred");
          if (frame.claims.some((claim) => claim.correct === true)) break;
        }
        assert(frame.claims.some((claim) => claim.correct === true), "execution did not terminate within the tested bound");
        assert(frame.pebbles.length === 3, "the kernel lost a pebble token record");
        executions += 1;
      }
    }
    assert(executions === 120, "not all property executions ran");
  });

  function renderResult(name, error) {
    const item = document.createElement("li");
    item.className = error ? "fail" : "pass";
    const strong = document.createElement("strong");
    strong.textContent = `${error ? "FAIL" : "PASS"} — ${name}`;
    item.append(strong);
    if (error) {
      const details = document.createElement("pre");
      details.textContent = error.stack || String(error);
      item.append(details);
    }
    document.getElementById("results").append(item);
  }

  let failures = 0;
  const started = performance.now();
  for (const current of tests) {
    try {
      current.body();
      renderResult(current.name, null);
    } catch (error) {
      failures += 1;
      renderResult(current.name, error);
    }
  }
  const elapsed = Math.round(performance.now() - started);
  document.getElementById("summary").textContent = failures === 0
    ? `${tests.length} tests passed in ${elapsed} ms.`
    : `${failures} of ${tests.length} tests failed in ${elapsed} ms.`;
  document.documentElement.dataset.testFailures = String(failures);
})(globalThis);
