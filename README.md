# GL local-state simulator

This is a dependency-free browser simulator for the algorithm \(\mathrm{GL}\)
described in Section 5 of the paper. Open `index.html` directly in a modern
browser; no Node.js runtime, package installation, build command, or web server
is required.

## Locality boundary

The three agents are three independent instances of the same `AgentMachine`.
Every transition is computed from private memory and a frozen local view
containing only:

- the two incident edge states;
- co-located visible identifiers and finite protocol messages;
- the number of pebbles at the current anonymous node;
- the result of the agent's own preceding action.

The machine never receives a node number, the black-hole position, the number
of survivors, a remote position, a remote pebble, or another agent's private
memory. There are no shared `JointCW`, `CautiousPendulum`, or `BackwardCP`
objects.

`Simulation` is a neutral synchronous kernel. It keeps the physical truth
needed to resolve movements, missing edges, pebbles, and black-hole entries.
Its observer frame is read-only and is used only by the GUI and the correctness
oracle; it is never passed back to an agent.

## Controls

- Configure the ring size, black-hole node, and the three distinct safe starts.
- Select **Initialize ring** to apply those values and start again from round 0.
- Choose a permanently open, manually missing, interval-pattern, or seeded-random edge schedule.
- In **Manual missing pattern**, enter inclusive intervals such as
  `edge 1 absent from 5 to 12`, one per line. Intervals for different
  edges must not overlap.
- In **Click ring edges**, click a ring edge to remove it, click the
  missing edge to restore it, or click another edge to move the omission.
- Use **Step**, **Play**, or **Next event** to advance synchronous rounds.
- Select an agent to inspect the exact local view, private state, and action.
- Toggle observer truth to show or hide node numbers and the black hole.

## Tests

Open `tests/tests.html` in a browser. The suite checks local-view isolation,
determinism, rotation invariance, edge blocking, pebble marking, role
handshakes, timeout boundaries, and relative black-hole claims. It also runs
permanent cuts both incident to and away from the black hole, reachable
two-survivor `Forward` and `BackwardCP` executions, and rotating, shielding,
probe-blocking, and other adaptive one-edge adversaries.

The implementation files are deliberately separated:

- `src/protocol.js`: local capabilities and finite protocol values;
- `src/gl-agent.js`: the pure per-agent state machine;
- `src/kernel.js`: synchronous ring mechanics and passive oracle;
- `src/schedulers.js`: valid one-missing-edge schedules;
- `src/scenarios.js`: reproducible initial executions;
- `src/ui.js`: observer rendering and controls.
