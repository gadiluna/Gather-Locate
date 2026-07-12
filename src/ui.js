(function initUI(root) {
  "use strict";

  const GLSim = root.GLSim;
  const svgNS = "http://www.w3.org/2000/svg";
  const byId = (id) => document.getElementById(id);

  let simulation = null;
  let selectedAgentId = 0;
  let playing = false;
  let playTimer = null;
  let visibleLogStart = 0;
  let configurationPending = false;

  function svgElement(name, attributes, text) {
    const element = document.createElementNS(svgNS, name);
    for (const [key, value] of Object.entries(attributes || {})) {
      element.setAttribute(key, String(value));
    }
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function clampInteger(value, minimum, maximum, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
    }
    return parsed;
  }

  function hashSeed(value) {
    const text = String(value || "1");
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function schedulerConfig() {
    const type = byId("scheduler-mode").value;
    if (type === "manual") {
      const raw = byId("manual-edge").value;
      return { type: "manual", missingEdge: raw === "none" ? null : Number(raw) };
    }
    if (type === "pattern") {
      return { type: "pattern", pattern: byId("missing-pattern").value };
    }
    if (type === "click") {
      return { type: "manual", missingEdge: null };
    }
    if (type === "random") {
      return {
        type: "random",
        seed: hashSeed(byId("random-seed").value),
        omissionProbability: 0.35,
      };
    }
    return { type: "none" };
  }

  function readConfiguration() {
    const n = clampInteger(byId("ring-size").value, 4, 60, "Ring size");
    const blackHole = clampInteger(byId("black-hole").value, 0, n - 1, "Black-hole node");
    const positions = [0, 1, 2].map((id) =>
      clampInteger(byId(`agent-${id}-start`).value, 0, n - 1, `Agent ${id} start`),
    );
    if (new Set(positions).size !== 3) throw new Error("The three starting nodes must be distinct.");
    if (positions.includes(blackHole)) throw new Error("No agent may start on the black hole.");
    return { n, blackHole, positions, scheduler: schedulerConfig() };
  }

  function updateNumericBounds() {
    const n = Math.max(4, Math.min(60, Number(byId("ring-size").value) || 4));
    for (const id of ["black-hole", "agent-0-start", "agent-1-start", "agent-2-start"]) {
      const input = byId(id);
      input.max = String(n - 1);
      if (Number(input.value) >= n) input.value = String(n - 1);
    }
    const select = byId("manual-edge");
    const previous = select.value;
    select.replaceChildren(new Option("None", "none"));
    for (let edge = 0; edge < n; edge += 1) {
      select.append(new Option(`${edge} — ${GLSim.mod(edge + 1, n)}`, String(edge)));
    }
    select.value = [...select.options].some((option) => option.value === previous) ? previous : "none";
  }

  function showError(error) {
    pause();
    const badge = byId("result-badge");
    badge.className = "result-badge result-badge--failure";
    badge.textContent = error instanceof Error ? error.message : String(error);
    byId("live-announcer").textContent = badge.textContent;
  }

  function markConfigurationPending() {
    pause();
    configurationPending = true;
    byId("configuration-state").textContent = "Changes pending. Initialize or start the simulation to apply them from round 0.";
    if (simulation) renderResult(simulation.observerFrame());
  }

  function clearConfigurationPending() {
    configurationPending = false;
    byId("configuration-state").textContent = "Current values are active.";
  }

  function resetSimulation() {
    try {
      pause();
      updateNumericBounds();
      updateSchedulerVisibility();
      simulation = new GLSim.Simulation(readConfiguration());
      visibleLogStart = 0;
      clearConfigurationPending();
      render(simulation.observerFrame());
      return true;
    } catch (error) {
      configurationPending = true;
      showError(error);
      return false;
    }
  }

  function applyCurrentScheduler() {
    if (!simulation) return;
    try {
      simulation.setScheduler(schedulerConfig());
      render(simulation.observerFrame());
    } catch (error) {
      showError(error);
    }
  }

  function toggleInteractiveEdge(edge) {
    if (byId("scheduler-mode").value !== "click") return;
    if (configurationPending && !resetSimulation()) return;
    try {
      if (simulation.observerFrame().scheduler.type !== "manual") {
        simulation.setScheduler({ type: "manual", missingEdge: null });
      }
      const current = simulation.observerFrame().missingEdge;
      render(simulation.setManualMissingEdge(current === edge ? null : edge));
    } catch (error) {
      showError(error);
    }
  }

  function stepOnce() {
    if ((!simulation || configurationPending) && !resetSimulation()) return null;
    try {
      const frame = simulation.step();
      render(frame);
      if (!frame.agents.some((agent) => agent.status === "ACTIVE")) pause();
      return frame;
    } catch (error) {
      showError(error);
      return null;
    }
  }

  function protocolSignature(frame) {
    return JSON.stringify({
      agents: frame.agents.map((agent) => ({
        id: agent.id,
        status: agent.status,
        mode: agent.memory && agent.memory.mode,
        stage: agent.memory && agent.memory.stage,
        role: agent.memory && agent.memory.role,
      })),
      pebbles: frame.pebbles.map((pebble) => ({
        status: pebble.status,
        position: pebble.position,
        carrierId: pebble.carrierId,
      })),
      claims: frame.claims.length,
    });
  }

  function runToNextEvent() {
    if ((!simulation || configurationPending) && !resetSimulation()) return;
    pause();
    const start = protocolSignature(simulation.observerFrame());
    try {
      for (let count = 0; count < 5000; count += 1) {
        const frame = simulation.step();
        if (
          protocolSignature(frame) !== start
          || !frame.agents.some((agent) => agent.status === "ACTIVE")
        ) {
          render(frame);
          return;
        }
      }
    } catch (error) {
      showError(error);
      return;
    }
    showError(new Error("No protocol event occurred within 5,000 rounds."));
  }

  function playDelay() {
    const speed = Math.max(1, Number(byId("speed-range").value) || 1);
    return Math.max(55, Math.round(1000 / speed));
  }

  function playTick() {
    if (!playing) return;
    const frame = stepOnce();
    if (!playing || !frame) return;
    playTimer = root.setTimeout(playTick, playDelay());
  }

  function play() {
    if (playing) return;
    if ((!simulation || configurationPending) && !resetSimulation()) return;
    playing = true;
    byId("play-button").setAttribute("aria-pressed", "true");
    byId("play-button-label").textContent = "Pause";
    byId("play-button").querySelector(".play-icon").textContent = "Ⅱ";
    renderResult(simulation ? simulation.observerFrame() : null);
    playTick();
  }

  function pause() {
    playing = false;
    if (playTimer !== null) root.clearTimeout(playTimer);
    playTimer = null;
    const button = byId("play-button");
    if (!button) return;
    button.setAttribute("aria-pressed", "false");
    byId("play-button-label").textContent = "Play";
    button.querySelector(".play-icon").textContent = "▶";
  }

  function setSelectedAgent(id) {
    selectedAgentId = Number(id);
    document.querySelectorAll(".agent-tab").forEach((tab) => {
      const selected = Number(tab.dataset.agentId) === selectedAgentId;
      tab.classList.toggle("is-selected", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    byId("agent-inspector").setAttribute("aria-labelledby", `agent-tab-${selectedAgentId}`);
    if (simulation) renderInspector(simulation.observerFrame());
  }

  function nodeCoordinates(n) {
    const centerX = 380;
    const centerY = 320;
    const radius = n > 36 ? 248 : 235;
    return Array.from({ length: n }, (_, index) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * index) / n;
      return {
        x: centerX + radius * Math.cos(angle),
        y: centerY + radius * Math.sin(angle),
        angle,
      };
    });
  }

  function renderRing(frame) {
    const truth = byId("observer-truth").checked;
    const interactiveEdges = byId("scheduler-mode").value === "click";
    const coordinates = nodeCoordinates(frame.n);
    const edgeLayer = byId("edge-layer");
    const nodeLayer = byId("node-layer");
    const pebbleLayer = byId("pebble-layer");
    const agentLayer = byId("agent-layer");
    const orientationLayer = byId("orientation-layer");
    edgeLayer.replaceChildren();
    nodeLayer.replaceChildren();
    pebbleLayer.replaceChildren();
    agentLayer.replaceChildren();
    orientationLayer.replaceChildren();
    byId("ring-empty-state").setAttribute("display", "none");

    for (let index = 0; index < frame.n; index += 1) {
      const from = coordinates[index];
      const to = coordinates[GLSim.mod(index + 1, frame.n)];
      edgeLayer.append(svgElement("line", {
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y,
        class: `ring-edge${frame.missingEdge === index ? " is-missing" : ""}`,
      }));
      if (interactiveEdges) {
        const target = svgElement("line", {
          x1: from.x,
          y1: from.y,
          x2: to.x,
          y2: to.y,
          class: "ring-edge-hit",
          role: "button",
          tabindex: "0",
          "aria-label": frame.missingEdge === index
            ? `Restore edge ${index}`
            : `Remove edge ${index}`,
        });
        target.addEventListener("click", () => toggleInteractiveEdge(index));
        target.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          toggleInteractiveEdge(index);
        });
        edgeLayer.append(target);
      }
    }

    orientationLayer.append(svgElement("path", {
      d: "M 323 313 A 66 66 0 0 1 435 275",
      class: "orientation-arrow",
      "marker-end": "url(#clockwise-arrow)",
    }));
    orientationLayer.append(svgElement("text", {
      x: 380,
      y: 342,
      class: "ring-node-label",
    }, "clockwise"));

    coordinates.forEach((point, index) => {
      const isBlackHole = truth && index === frame.blackHole;
      nodeLayer.append(svgElement("circle", {
        cx: point.x,
        cy: point.y,
        r: 14,
        class: `ring-node${isBlackHole ? " is-black-hole" : ""}`,
      }));
      if (truth) {
        const labelRadius = 25;
        const labelX = isBlackHole ? point.x : point.x + labelRadius * Math.cos(point.angle);
        const labelY = isBlackHole ? point.y + 4 : point.y + labelRadius * Math.sin(point.angle) + 4;
        if (frame.n > 30 && !isBlackHole && index % 5 !== 0) return;
        nodeLayer.append(svgElement("text", {
          x: labelX,
          y: labelY,
          class: `ring-node-label${isBlackHole ? " black-hole-label" : ""}`,
        }, isBlackHole ? "BH" : String(index)));
      }
    });

    const placed = frame.pebbles.filter((pebble) => pebble.status === "PLACED");
    const pebbleGroups = new Map();
    for (const pebble of placed) {
      if (!pebbleGroups.has(pebble.position)) pebbleGroups.set(pebble.position, []);
      pebbleGroups.get(pebble.position).push(pebble);
    }
    for (const [position, pebbles] of pebbleGroups.entries()) {
      const point = coordinates[position];
      pebbles.forEach((pebble, index) => {
        const x = point.x - 7 * (pebbles.length - 1) + 14 * index;
        const y = point.y + 26;
        const square = svgElement("rect", {
          x: x - 5,
          y: y - 5,
          width: 10,
          height: 10,
          rx: 2,
          class: "pebble-token",
          transform: `rotate(45 ${x} ${y})`,
        });
        square.append(svgElement("title", {}, truth ? pebble.id : "local pebble"));
        pebbleLayer.append(square);
      });
    }

    const agentsByPosition = new Map();
    for (const agent of frame.agents) {
      if (!agentsByPosition.has(agent.position)) agentsByPosition.set(agent.position, []);
      agentsByPosition.get(agent.position).push(agent);
    }
    for (const [position, agents] of agentsByPosition.entries()) {
      const point = coordinates[position];
      agents.sort((a, b) => a.id - b.id).forEach((agent, index) => {
        const offset = (index - (agents.length - 1) / 2) * 34;
        const tangentX = -Math.sin(point.angle);
        const tangentY = Math.cos(point.angle);
        const radialX = Math.cos(point.angle);
        const radialY = Math.sin(point.angle);
        const x = point.x + tangentX * offset - radialX * 31;
        const y = point.y + tangentY * offset - radialY * 31;
        const group = svgElement("g", { class: `agent-${agent.id}` });
        group.append(svgElement("circle", {
          cx: x,
          cy: y,
          r: 16,
          class: `agent-token agent-${agent.id}${agent.status === "DESTROYED" ? " is-destroyed" : ""}`,
        }));
        group.append(svgElement("text", { x, y: y + 4, class: "agent-label" }, `A${agent.id}`));
        group.append(svgElement("text", { x, y: y + 30, class: "role-label" }, roleAbbreviation(agent)));
        const title = `Agent ${agent.id}: ${agent.status}; ${agent.memory ? agent.memory.mode : "no state"}`;
        group.append(svgElement("title", {}, title));
        agentLayer.append(group);
      });
    }
  }

  function roleAbbreviation(agent) {
    if (agent.status === "DESTROYED") return "destroyed";
    if (agent.status === "TERMINATED") return "done";
    const role = agent.memory && agent.memory.role;
    const map = {
      LEADER: "L",
      AVANGUARD: "A",
      RETROGUARD: "R",
      AGGRESSIVE_LEADER: "AL",
      SCOUT: "S",
      NONE: "",
    };
    return map[role] !== undefined ? map[role] : "";
  }

  function renderStatus(frame) {
    byId("round-value").textContent = String(frame.round);
    byId("phase-value").textContent = String(frame.phase);
    byId("moves-value").textContent = String(frame.moves);
    byId("survivors-value").textContent = String(frame.agents.filter((agent) => agent.status !== "DESTROYED").length);
    renderResult(frame);
  }

  function renderResult(frame) {
    const badge = byId("result-badge");
    if (!frame) return;
    if (configurationPending) {
      badge.className = "result-badge result-badge--paused";
      badge.textContent = "Start to apply changes";
      return;
    }
    const incorrect = frame.claims.find((claim) => claim.correct === false);
    const correct = frame.claims.find((claim) => claim.correct === true);
    const active = frame.agents.some((agent) => agent.status === "ACTIVE");
    if (incorrect) {
      badge.className = "result-badge result-badge--failure";
      badge.textContent = `Incorrect claim by A${incorrect.agentId}`;
    } else if (correct) {
      badge.className = "result-badge result-badge--success";
      badge.textContent = `Black hole located by A${correct.agentId}`;
    } else if (!active) {
      badge.className = "result-badge result-badge--failure";
      badge.textContent = "No active agent";
    } else if (playing) {
      badge.className = "result-badge result-badge--running";
      badge.textContent = "Running";
    } else if (frame.round > 0) {
      badge.className = "result-badge result-badge--paused";
      badge.textContent = "Paused";
    } else {
      badge.className = "result-badge result-badge--running";
      badge.textContent = "Ready";
    }
  }

  function renderAgentTable(frame) {
    const body = byId("agent-table-body");
    body.replaceChildren();
    for (const agent of frame.agents) {
      const row = document.createElement("tr");
      row.dataset.agentId = String(agent.id);
      row.setAttribute("aria-selected", String(agent.id === selectedAgentId));
      const mode = agent.memory ? agent.memory.mode : agent.status;
      const role = agent.memory ? roleAbbreviation(agent) || "—" : "—";
      row.innerHTML = `<th scope="row"><button class="table-agent table-agent--${agent.id}" type="button" data-agent-id="${agent.id}">A${agent.id}</button></th><td>${mode}</td><td>${role}</td><td>${agent.carriedPebbles}</td>`;
      body.append(row);
      const tabState = byId(`agent-tab-state-${agent.id}`);
      tabState.textContent = agent.status === "ACTIVE" ? mode : agent.status;
    }
    body.querySelectorAll("button[data-agent-id]").forEach((button) => {
      button.addEventListener("click", () => setSelectedAgent(button.dataset.agentId));
    });
  }

  function pretty(value) {
    return JSON.stringify(value === undefined ? null : value, null, 2);
  }

  function renderInspector(frame) {
    const agent = frame.agents.find((candidate) => candidate.id === selectedAgentId) || frame.agents[0];
    if (!agent) return;
    byId("local-view-round").textContent = `round ${frame.round}`;
    byId("local-view-json").textContent = pretty(agent.lastLocalView || {
      ports: null,
      pebbleCount: null,
      coLocatedIds: [],
      messages: [],
      lastOwnResult: agent.lastResult,
    });
    byId("agent-memory-json").textContent = pretty(agent.memory || { status: agent.status });
    byId("agent-action-json").textContent = pretty({
      preparation: agent.lastTrace && agent.lastTrace.preparation,
      pebbleResult: agent.lastPebbleResult,
      intent: agent.lastIntent,
      ownResult: agent.lastResult,
    });
  }

  function eventClass(event) {
    if (event.agentId !== null && event.agentId !== undefined) return `event--agent-${event.agentId}`;
    if (event.type === "DESTROYED") return "event--danger";
    if (event.type === "TERMINATION") return event.details && event.details.correct ? "event--success" : "event--warning";
    if (event.type === "EDGE_MISSING" || event.type === "MOVE_BLOCKED") return "event--warning";
    return "event--system";
  }

  function renderLog(frame) {
    const log = byId("event-log");
    log.replaceChildren();
    const events = frame.events.slice(Math.max(visibleLogStart, frame.events.length - 120));
    for (const event of events) {
      const item = document.createElement("li");
      item.className = `event ${eventClass(event)}`;
      const actor = event.agentId === null || event.agentId === undefined ? "Environment" : `A${event.agentId}`;
      item.innerHTML = `<span class="event-round">r${event.round}</span><span class="event-mark" aria-hidden="true"></span><p><strong>${actor}.</strong> ${event.message}</p>`;
      log.append(item);
    }
    if (events.length === 0) {
      const item = document.createElement("li");
      item.className = "event event--system";
      item.innerHTML = "<span class=\"event-round\">—</span><span class=\"event-mark\" aria-hidden=\"true\"></span><p>Visible log cleared.</p>";
      log.append(item);
    }
    log.scrollTop = log.scrollHeight;
  }

  function render(frame) {
    renderStatus(frame);
    renderRing(frame);
    renderAgentTable(frame);
    renderInspector(frame);
    renderLog(frame);
  }

  function updateSchedulerVisibility() {
    const mode = byId("scheduler-mode").value;
    byId("manual-edge-field").hidden = mode !== "manual";
    byId("seed-field").hidden = mode !== "random";
    byId("pattern-field").hidden = mode !== "pattern";
    byId("scheduler-hint").textContent = mode === "pattern"
      ? "Use one rule per line. Round intervals are inclusive and may not remove different edges in the same round."
      : mode === "click"
        ? "Click a ring edge to remove it. Click the missing edge again to restore it."
        : "The scheduler removes at most one ring edge in every round.";
  }

  function initialize() {
    updateNumericBounds();
    updateSchedulerVisibility();
    document.querySelectorAll(".agent-tab").forEach((tab) => {
      tab.addEventListener("click", () => setSelectedAgent(tab.dataset.agentId));
      tab.addEventListener("keydown", (event) => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? 1 : -1;
        const next = GLSim.mod(selectedAgentId + delta, 3);
        setSelectedAgent(next);
        byId(`agent-tab-${next}`).focus();
      });
    });
    byId("step-button").addEventListener("click", stepOnce);
    byId("next-event-button").addEventListener("click", runToNextEvent);
    byId("play-button").addEventListener("click", () => (playing ? pause() : play()));
    byId("reset-button").addEventListener("click", () => root.setTimeout(resetSimulation, 0));
    byId("ring-size").addEventListener("input", () => {
      updateNumericBounds();
      markConfigurationPending();
    });
    for (const id of ["black-hole", "agent-0-start", "agent-1-start", "agent-2-start"]) {
      byId(id).addEventListener("input", markConfigurationPending);
    }
    byId("scheduler-mode").addEventListener("change", () => {
      updateSchedulerVisibility();
      markConfigurationPending();
      if (simulation) renderRing(simulation.observerFrame());
    });
    byId("manual-edge").addEventListener("change", () => {
      const activeScheduler = simulation && simulation.observerFrame().scheduler.type;
      if (!configurationPending && activeScheduler === "manual" && byId("scheduler-mode").value === "manual") {
        applyCurrentScheduler();
      } else {
        markConfigurationPending();
      }
    });
    byId("missing-pattern").addEventListener("input", markConfigurationPending);
    byId("random-seed").addEventListener("input", markConfigurationPending);
    byId("observer-truth").addEventListener("change", () => simulation && renderRing(simulation.observerFrame()));
    byId("speed-range").addEventListener("input", () => {
      byId("speed-label").textContent = `${byId("speed-range").value} rounds/s`;
    });
    byId("clear-log-button").addEventListener("click", () => {
      if (!simulation) return;
      visibleLogStart = simulation.observerFrame().events.length;
      renderLog(simulation.observerFrame());
    });
    byId("config-form").addEventListener("submit", (event) => {
      event.preventDefault();
      resetSimulation();
    });
    resetSimulation();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize, { once: true });
  } else {
    initialize();
  }
})(globalThis);
