(function initKernel(root) {
  "use strict";

  const GLSim = (root.GLSim = root.GLSim || {});

  function requireProtocol() {
    const required = ["Action", "Direction", "PebbleOperation", "makeLocalView", "clone", "deepFreeze", "mod"];
    for (const name of required) {
      if (!GLSim[name]) throw new Error(`protocol.js must be loaded before kernel.js (missing ${name})`);
    }
    if (typeof GLSim.createScheduler !== "function") {
      throw new Error("schedulers.js must be loaded before kernel.js");
    }
  }

  function integer(value, label) {
    const result = Number(value);
    if (!Number.isInteger(result)) throw new TypeError(`${label} must be an integer`);
    return result;
  }

  function directionFor(action) {
    if (action === GLSim.Action.MOVE_CW) return GLSim.Direction.CLOCKWISE;
    if (action === GLSim.Action.MOVE_CCW) return GLSim.Direction.COUNTER_CLOCKWISE;
    return GLSim.Direction.STAY;
  }

  function statusOf(agent) {
    if (agent.terminated) return "TERMINATED";
    if (!agent.alive) return "DESTROYED";
    return "ACTIVE";
  }

  function normalizeMessage(id, value) {
    const message = value && typeof value === "object" ? value : {};
    return {
      id,
      mode: String(message.mode || "UNKNOWN"),
      stage: String(message.stage || "UNKNOWN"),
      role: String(message.role || "NONE"),
      event: String(message.event || "NONE"),
    };
  }

  function normalizePrepare(value) {
    const result = value && typeof value === "object" ? value : {};
    const requested = result.pebbleOperation || GLSim.PebbleOperation.NONE;
    if (!Object.values(GLSim.PebbleOperation).includes(requested)) {
      throw new Error(`Invalid pebble operation: ${requested}`);
    }
    const numericPriority = Number(result.priority);
    return {
      pebbleOperation: requested,
      priority: Number.isFinite(numericPriority) ? numericPriority : 100,
      reason: String(result.reason || ""),
    };
  }

  function normalizeIntent(value) {
    const result = value && typeof value === "object" ? value : {};
    const action = result.action || GLSim.Action.STAY;
    if (!Object.values(GLSim.Action).includes(action)) {
      throw new Error(`Invalid agent action: ${action}`);
    }
    return {
      action,
      reason: String(result.reason || ""),
      claim: result.claim ? GLSim.clone(result.claim) : null,
    };
  }

  class Simulation {
    constructor(config) {
      requireProtocol();
      const options = config || {};
      this.n = integer(options.n, "n");
      if (this.n <= 3) throw new RangeError("n must be greater than 3");
      this.blackHole = integer(options.blackHole, "blackHole");
      if (this.blackHole < 0 || this.blackHole >= this.n) {
        throw new RangeError(`blackHole must lie in [0, ${this.n - 1}]`);
      }

      this.round = 0;
      this.moves = 0;
      this.missingEdge = null;
      this.scheduler = GLSim.createScheduler(options.scheduler || { type: "none" }, this.n);
      this.events = [];
      this.claims = [];
      this.tokens = [];
      this.agents = this.#buildAgents(options);

      if (this.agents.length !== 3) {
        throw new Error("GL requires exactly three agent instances");
      }
      const ids = new Set(this.agents.map((agent) => agent.id));
      if (ids.size !== this.agents.length) throw new Error("Agent identifiers must be distinct");
      for (const agent of this.agents) {
        if (agent.position === this.blackHole) {
          throw new Error(`Agent ${agent.id} cannot start on the black hole`);
        }
        this.tokens.push({
          id: `p${agent.id}`,
          position: null,
          carrierId: agent.id,
          status: "CARRIED",
        });
      }

      this.#event("INITIALIZED", null, `Ring of size ${this.n}; three independent agent machines initialized`, {
        positions: this.agents.map((agent) => ({ id: agent.id, position: agent.position })),
      });
    }

    #buildAgents(options) {
      let specs = options.agents;
      if (!Array.isArray(specs)) {
        const positions = Array.isArray(options.positions) ? options.positions : [];
        specs = positions.map((position, id) => ({ id, position }));
      }

      const factory = options.agentFactory || options.machineFactory;
      return specs.map((raw, index) => {
        const spec = typeof raw === "number" ? { position: raw } : raw || {};
        const id = integer(spec.id ?? index, `agents[${index}].id`);
        const position = integer(spec.position ?? spec.start, `agents[${index}].position`);
        if (position < 0 || position >= this.n) {
          throw new RangeError(`Agent ${id} position must lie in [0, ${this.n - 1}]`);
        }

        let machine = spec.machine;
        if (!machine && typeof factory === "function") {
          machine = factory.length >= 2
            ? factory(id, this.n)
            : factory({ id, n: this.n });
        }
        if (!machine && typeof GLSim.AgentMachine === "function") {
          machine = new GLSim.AgentMachine({ id, n: this.n });
        }
        for (const method of ["announce", "prepare", "decide"]) {
          if (!machine || typeof machine[method] !== "function") {
            throw new TypeError(`Agent ${id} machine must implement ${method}()`);
          }
        }

        return {
          id,
          position,
          alive: true,
          terminated: false,
          machine,
          lastResult: { kind: "INITIAL", direction: GLSim.Direction.STAY },
          lastLocalView: null,
          lastIntent: null,
          lastPebbleResult: null,
        };
      });
    }

    #activeAgents() {
      return this.agents.filter((agent) => agent.alive && !agent.terminated);
    }

    #edgePresent(edge) {
      return this.missingEdge === null || edge !== this.missingEdge;
    }

    #portsAt(position) {
      return {
        clockwise: this.#edgePresent(position),
        counterClockwise: this.#edgePresent(GLSim.mod(position - 1, this.n)),
      };
    }

    #tokensAt(position) {
      return this.tokens.filter((token) => token.status === "PLACED" && token.position === position);
    }

    #tokensCarriedBy(agentId) {
      return this.tokens.filter((token) => token.status === "CARRIED" && token.carrierId === agentId);
    }

    #coLocated(agent) {
      return this.#activeAgents()
        .filter((candidate) => candidate.position === agent.position)
        .sort((left, right) => left.id - right.id);
    }

    #makeView(agent, announcements) {
      const peers = this.#coLocated(agent);
      return GLSim.makeLocalView({
        ports: this.#portsAt(agent.position),
        pebbleCount: this.#tokensAt(agent.position).length,
        coLocatedIds: peers.map((peer) => peer.id),
        messages: peers
          .filter((peer) => peer.id !== agent.id)
          .map((peer) => announcements.get(peer.id)),
        lastOwnResult: agent.lastResult,
      });
    }

    #event(type, agentId, message, details) {
      const event = GLSim.deepFreeze({
        round: this.round,
        type,
        agentId,
        message: String(message || ""),
        details: GLSim.clone(details || {}),
      });
      this.events.push(event);
      return event;
    }

    #resolvePebbles(prepared) {
      const results = new Map();
      const active = this.#activeAgents();

      for (const agent of active) {
        const request = prepared.get(agent.id);
        results.set(agent.id, {
          requested: request.pebbleOperation,
          success: request.pebbleOperation === GLSim.PebbleOperation.NONE,
          count: 0,
          reason: request.pebbleOperation === GLSim.PebbleOperation.NONE ? "NONE" : "PENDING",
        });
      }

      // Recovery is resolved before any new placement, matching the paper's
      // priority for a completed return and its pebble retrieval.
      const takeByNode = new Map();
      for (const agent of active) {
        const request = prepared.get(agent.id);
        if (request.pebbleOperation !== GLSim.PebbleOperation.TAKE_ALL) continue;
        if (!takeByNode.has(agent.position)) takeByNode.set(agent.position, []);
        takeByNode.get(agent.position).push({ agent, request });
      }

      for (const [position, requests] of takeByNode.entries()) {
        const tokens = this.#tokensAt(position);
        if (tokens.length === 0) {
          for (const { agent } of requests) results.get(agent.id).reason = "NO_PEBBLE";
          continue;
        }

        const bestPriority = Math.min(...requests.map(({ request }) => request.priority));
        const candidates = requests
          .filter(({ request }) => request.priority === bestPriority)
          .sort((left, right) => left.agent.id - right.agent.id);
        // Rotate equal-priority winners by round, so the physics layer does not
        // privilege one visible identifier forever.
        const winner = candidates[(Math.max(1, this.round) - 1) % candidates.length].agent;
        for (const token of tokens) {
          token.status = "CARRIED";
          token.position = null;
          token.carrierId = winner.id;
        }
        const winnerResult = results.get(winner.id);
        winnerResult.success = true;
        winnerResult.count = tokens.length;
        winnerResult.reason = "TAKEN";
        for (const { agent } of requests) {
          if (agent.id !== winner.id) results.get(agent.id).reason = "CONTENDED";
        }
        this.#event("PEBBLE_TAKEN", winner.id, `Agent ${winner.id} took ${tokens.length} pebble(s)`, {
          tokenIds: tokens.map((token) => token.id),
          position,
        });
      }

      // Placements are resolved only after all recovery requests. A pebble
      // dropped for a new cautious step cannot be consumed by another local
      // operation in the same activation.
      for (const agent of active) {
        const request = prepared.get(agent.id);
        if (request.pebbleOperation !== GLSim.PebbleOperation.DROP_ONE) continue;
        const token = this.#tokensCarriedBy(agent.id).sort((a, b) => a.id.localeCompare(b.id))[0];
        const result = results.get(agent.id);
        if (!token) {
          result.reason = "NO_CARRIED_PEBBLE";
          continue;
        }
        token.status = "PLACED";
        token.position = agent.position;
        token.carrierId = null;
        result.success = true;
        result.count = 1;
        result.reason = "DROPPED";
        this.#event("PEBBLE_DROPPED", agent.id, `Agent ${agent.id} dropped a pebble`, {
          tokenId: token.id,
          position: agent.position,
        });
      }

      for (const [id, result] of results.entries()) {
        results.set(id, GLSim.deepFreeze(GLSim.clone(result)));
      }
      return results;
    }

    #recordClaim(agent, claim, reason) {
      const hasClockwiseField = Boolean(claim)
        && Object.prototype.hasOwnProperty.call(claim, "clockwiseDistance")
        && claim.clockwiseDistance !== null;
      const hasCounterClockwiseField = Boolean(claim)
        && Object.prototype.hasOwnProperty.call(claim, "counterClockwiseDistance")
        && claim.counterClockwiseDistance !== null;
      const clockwiseDistance = hasClockwiseField ? Number(claim.clockwiseDistance) : NaN;
      const counterClockwiseDistance = hasCounterClockwiseField ? Number(claim.counterClockwiseDistance) : NaN;
      const hasClockwise = hasClockwiseField && Number.isFinite(clockwiseDistance);
      const hasCounterClockwise = hasCounterClockwiseField && Number.isFinite(counterClockwiseDistance);
      const clockwiseNode = hasClockwise
        ? GLSim.mod(agent.position + clockwiseDistance, this.n)
        : null;
      const counterClockwiseNode = hasCounterClockwise
        ? GLSim.mod(agent.position - counterClockwiseDistance, this.n)
        : null;
      const supplied = hasClockwise || hasCounterClockwise;
      const correct = supplied
        ? (!hasClockwise || clockwiseNode === this.blackHole)
          && (!hasCounterClockwise || counterClockwiseNode === this.blackHole)
        : null;
      const record = GLSim.deepFreeze({
        round: this.round,
        agentId: agent.id,
        position: agent.position,
        reason: String(reason || ""),
        claim: claim ? GLSim.clone(claim) : null,
        clockwiseNode,
        counterClockwiseNode,
        correct,
      });
      this.claims.push(record);
      this.#event("TERMINATION", agent.id, `Agent ${agent.id} terminated${correct === null ? "" : correct ? " correctly" : " incorrectly"}`, {
        claim: record.claim,
        correct,
      });
    }

    step() {
      const currentRound = this.round + 1;
      this.round = currentRound;
      const scheduled = this.scheduler.next({ round: currentRound, n: this.n });
      this.missingEdge = GLSim.edgeOrNull(scheduled, this.n);
      if (this.missingEdge !== null) {
        this.#event("EDGE_MISSING", null, `Edge ${this.missingEdge}--${GLSim.mod(this.missingEdge + 1, this.n)} is absent`, {
          missingEdge: this.missingEdge,
        });
      }

      const active = this.#activeAgents();
      const announcements = new Map();
      for (const agent of active) {
        announcements.set(agent.id, normalizeMessage(agent.id, agent.machine.announce()));
      }

      const prepared = new Map();
      for (const agent of active) {
        const localView = this.#makeView(agent, announcements);
        agent.lastLocalView = localView;
        prepared.set(agent.id, normalizePrepare(agent.machine.prepare(localView)));
      }

      const pebbleResults = this.#resolvePebbles(prepared);
      const intents = new Map();
      for (const agent of active) {
        const postPebbleView = this.#makeView(agent, announcements);
        const pebbleResult = pebbleResults.get(agent.id);
        agent.lastLocalView = postPebbleView;
        agent.lastPebbleResult = pebbleResult;
        const intent = normalizeIntent(agent.machine.decide(postPebbleView, pebbleResult));
        agent.lastIntent = GLSim.deepFreeze(GLSim.clone(intent));
        intents.set(agent.id, intent);
      }

      // Decisions above were computed from immutable snapshots. The following
      // loop only applies physical consequences; no agent transition can see
      // another agent's newly selected action in this round.
      for (const agent of active) {
        const intent = intents.get(agent.id);
        const direction = directionFor(intent.action);

        if (intent.action === GLSim.Action.TERMINATE) {
          agent.terminated = true;
          agent.lastResult = { kind: "TERMINATED", direction: GLSim.Direction.STAY };
          this.#recordClaim(agent, intent.claim, intent.reason);
          continue;
        }

        if (intent.action === GLSim.Action.STAY) {
          agent.lastResult = { kind: "STAYED", direction: GLSim.Direction.STAY };
          continue;
        }

        const edge = intent.action === GLSim.Action.MOVE_CW
          ? agent.position
          : GLSim.mod(agent.position - 1, this.n);
        if (!this.#edgePresent(edge)) {
          agent.lastResult = { kind: "EDGE_ABSENT", direction };
          this.#event("MOVE_BLOCKED", agent.id, `Agent ${agent.id}'s ${direction} move was blocked`, { edge });
          continue;
        }

        const from = agent.position;
        const to = intent.action === GLSim.Action.MOVE_CW
          ? GLSim.mod(from + 1, this.n)
          : GLSim.mod(from - 1, this.n);
        agent.position = to;
        agent.lastResult = { kind: "MOVED", direction };
        this.moves += 1;
        this.#event("MOVED", agent.id, `Agent ${agent.id} moved ${direction}`, { from, to });

        if (to === this.blackHole) {
          agent.alive = false;
          for (const token of this.#tokensCarriedBy(agent.id)) {
            token.status = "DESTROYED";
            token.position = null;
            token.carrierId = null;
          }
          // Destruction is observable only through this GUI-facing event. No
          // result or message is ever delivered back to the destroyed machine.
          this.#event("DESTROYED", agent.id, `Agent ${agent.id} entered the black hole`, { from, blackHole: to });
        }
      }

      return this.observerFrame();
    }

    setScheduler(config) {
      this.scheduler = GLSim.createScheduler(config || { type: "none" }, this.n);
      if (typeof this.scheduler.reset === "function") this.scheduler.reset();
      this.missingEdge = null;
      this.#event("SCHEDULER_CHANGED", null, "Edge scheduler changed", {
        scheduler: typeof this.scheduler.snapshot === "function" ? this.scheduler.snapshot() : {},
      });
      return this.observerFrame();
    }

    setManualMissingEdge(edge) {
      if (!this.scheduler || typeof this.scheduler.setMissingEdge !== "function") {
        throw new Error("The active scheduler does not support interactive edge changes");
      }
      this.missingEdge = this.scheduler.setMissingEdge(edge);
      const message = this.missingEdge === null
        ? "The manually missing edge was restored"
        : `Edge ${this.missingEdge}--${GLSim.mod(this.missingEdge + 1, this.n)} was removed manually`;
      this.#event("SCHEDULER_CHANGED", null, message, { missingEdge: this.missingEdge });
      return this.observerFrame();
    }

    getEventLog() {
      return GLSim.deepFreeze(GLSim.clone(this.events));
    }

    observerFrame() {
      const agents = this.agents.map((agent) => {
        const memory = typeof agent.machine.snapshot === "function"
          ? GLSim.clone(agent.machine.snapshot())
          : null;
        const lastTrace = typeof agent.machine.getLastTrace === "function"
          ? GLSim.clone(agent.machine.getLastTrace())
          : null;
        return {
          id: agent.id,
          position: agent.position,
          status: statusOf(agent),
          carriedPebbles: this.#tokensCarriedBy(agent.id).length,
          memory,
          lastTrace,
          lastLocalView: agent.lastLocalView ? GLSim.clone(agent.lastLocalView) : null,
          lastResult: GLSim.clone(agent.lastResult),
          lastIntent: agent.lastIntent ? GLSim.clone(agent.lastIntent) : null,
          lastPebbleResult: agent.lastPebbleResult ? GLSim.clone(agent.lastPebbleResult) : null,
        };
      });
      const scheduler = typeof this.scheduler.snapshot === "function"
        ? GLSim.clone(this.scheduler.snapshot())
        : { type: "custom" };
      return GLSim.deepFreeze({
        n: this.n,
        round: this.round,
        phase: this.round <= 6 * this.n ? 1 : 2,
        blackHole: this.blackHole,
        missingEdge: this.missingEdge,
        moves: this.moves,
        scheduler,
        agents,
        pebbles: this.tokens.map((token) => GLSim.clone(token)),
        claims: GLSim.clone(this.claims),
        events: GLSim.clone(this.events),
      });
    }
  }

  Object.assign(GLSim, {
    RingKernel: Simulation,
    Simulation,
    SimulationKernel: Simulation,
  });
})(globalThis);
