# Gather&Locate Simulator

This is a dependency-free browser simulator for the algorithm Gather&Locate
described in Section 5 of the paper. Open `index.html` directly in a modern
browser; no Node.js runtime, package installation, build command, or web server
is required.

Live simulator: https://gadiluna.github.io/Gather-Locate/

## Locality boundary

The three agents are three independent instances of the same `AgentMachine`.
Every transition is computed from private memory and a frozen local view
containing only:

- the two incident edge states;
- co-located visible identifiers and finite protocol messages;
- the number of pebbles at the current anonymous node;
- the result of the agent's own preceding action.

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

Run the complete automated suite with:

```sh
node tests/run-all.js
```
