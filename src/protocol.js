(function initProtocol(root) {
  "use strict";

  const GLSim = (root.GLSim = root.GLSim || {});

  const Direction = Object.freeze({
    CLOCKWISE: "CW",
    COUNTER_CLOCKWISE: "CCW",
    STAY: "STAY",
  });

  const Action = Object.freeze({
    MOVE_CW: "MOVE_CW",
    MOVE_CCW: "MOVE_CCW",
    STAY: "STAY",
    TERMINATE: "TERMINATE",
  });

  const PebbleOperation = Object.freeze({
    NONE: "NONE",
    DROP_ONE: "DROP_ONE",
    TAKE_ALL: "TAKE_ALL",
  });

  const Mode = Object.freeze({
    PHASE1_CW: "PHASE1_CW",
    PHASE1_WAIT: "PHASE1_WAIT",
    FOLLOW_RETURN: "FOLLOW_RETURN",
    JOINT_LEADER: "JOINT_LEADER",
    JOINT_AVANGUARD: "JOINT_AVANGUARD",
    RT_LEADER: "RT_LEADER",
    RT_AVANGUARD: "RT_AVANGUARD",
    RT_RETROGUARD: "RT_RETROGUARD",
    PHASE2_WAIT: "PHASE2_WAIT",
    PHASE2_RETURN: "PHASE2_RETURN",
    BCP_AGGRESSIVE_LEADER: "BCP_AGGRESSIVE_LEADER",
    BCP_RETROGUARD: "BCP_RETROGUARD",
    FORWARD: "FORWARD",
    TERMINATED: "TERMINATED",
  });

  const Stage = Object.freeze({
    READY: "READY",
    PROBE: "PROBE",
    RETURNED: "RETURNED",
    FINAL_CROSSING: "FINAL_CROSSING",
    WAITING: "WAITING",
    ADVANCE: "ADVANCE",
    OUTBOUND: "OUTBOUND",
    RETURNING: "RETURNING",
    AT_MARK: "AT_MARK",
    MOVING: "MOVING",
  });

  const Role = Object.freeze({
    NONE: "NONE",
    LEADER: "LEADER",
    AVANGUARD: "AVANGUARD",
    RETROGUARD: "RETROGUARD",
    AGGRESSIVE_LEADER: "AGGRESSIVE_LEADER",
    FORWARD: "FORWARD",
  });

  const FORBIDDEN_LOCAL_KEYS = Object.freeze([
    "node",
    "nodeIndex",
    "position",
    "blackHole",
    "bh",
    "aliveCount",
    "survivorCount",
    "remoteAgents",
    "remotePebbles",
    "missingEdge",
    "pebbleOwner",
    "world",
  ]);

  const MessageEvent = Object.freeze({
    NONE: "NONE",
    RETURN_COMPLETED: "RETURN_COMPLETED",
    CAUTIOUS_PROBE: "CAUTIOUS_PROBE",
    RETRO_RETURNING: "RETRO_RETURNING",
  });

  const OwnResultKind = Object.freeze({
    INITIAL: "INITIAL",
    MOVED: "MOVED",
    EDGE_ABSENT: "EDGE_ABSENT",
    STAYED: "STAYED",
    TERMINATED: "TERMINATED",
  });

  function mod(value, modulus) {
    return ((value % modulus) + modulus) % modulus;
  }

  function clone(value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(clone);
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = clone(item);
    return result;
  }

  function deepFreeze(value) {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
      return value;
    }
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
    return value;
  }

  function findForbiddenKey(value, path) {
    if (value === null || typeof value !== "object") return null;
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_LOCAL_KEYS.includes(key)) {
        return `${path}.${key}`;
      }
      const nested = findForbiddenKey(item, `${path}.${key}`);
      if (nested) return nested;
    }
    return null;
  }

  function sanitizeMessage(message) {
    const result = {
      id: Number(message.id),
      mode: String(message.mode),
      stage: String(message.stage),
      role: String(message.role),
      event: String(message.event || "NONE"),
    };
    if (!Number.isInteger(result.id)) throw new Error("Message id must be an integer");
    if (!Object.values(Mode).includes(result.mode)) throw new Error(`Unsupported message mode: ${result.mode}`);
    if (!Object.values(Stage).includes(result.stage)) throw new Error(`Unsupported message stage: ${result.stage}`);
    if (!Object.values(Role).includes(result.role)) throw new Error(`Unsupported message role: ${result.role}`);
    if (!Object.values(MessageEvent).includes(result.event)) throw new Error(`Unsupported message event: ${result.event}`);
    return result;
  }

  function makeLocalView(input) {
    const ownResultKind = String((input.lastOwnResult && input.lastOwnResult.kind) || OwnResultKind.INITIAL);
    const ownResultDirection = String((input.lastOwnResult && input.lastOwnResult.direction) || Direction.STAY);
    if (!Object.values(OwnResultKind).includes(ownResultKind)) {
      throw new Error(`Unsupported own-result kind: ${ownResultKind}`);
    }
    if (!Object.values(Direction).includes(ownResultDirection)) {
      throw new Error(`Unsupported own-result direction: ${ownResultDirection}`);
    }
    const localView = {
      ports: {
        clockwise: Boolean(input.ports && input.ports.clockwise),
        counterClockwise: Boolean(input.ports && input.ports.counterClockwise),
      },
      pebbleCount: Math.max(0, Number(input.pebbleCount) || 0),
      coLocatedIds: (input.coLocatedIds || []).map(Number).sort((a, b) => a - b),
      messages: (input.messages || []).map(sanitizeMessage).sort((a, b) => a.id - b.id),
      lastOwnResult: {
        kind: ownResultKind,
        direction: ownResultDirection,
      },
    };
    const forbidden = findForbiddenKey(localView, "localView");
    if (forbidden) throw new Error(`Forbidden local-view capability: ${forbidden}`);
    return deepFreeze(localView);
  }

  function validateLocalView(localView) {
    const forbidden = findForbiddenKey(localView, "localView");
    if (forbidden) throw new Error(`Forbidden local-view capability: ${forbidden}`);
    if (!localView || typeof localView !== "object" || Array.isArray(localView)) {
      throw new Error("Malformed local view");
    }

    function requireExactKeys(value, expected, path) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${path} must be an object`);
      }
      const actual = Object.keys(value).sort();
      const wanted = expected.slice().sort();
      if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
        throw new Error(`${path} has unsupported capabilities: ${actual.join(", ")}`);
      }
    }

    requireExactKeys(
      localView,
      ["ports", "pebbleCount", "coLocatedIds", "messages", "lastOwnResult"],
      "localView",
    );
    requireExactKeys(localView.ports, ["clockwise", "counterClockwise"], "localView.ports");
    requireExactKeys(localView.lastOwnResult, ["kind", "direction"], "localView.lastOwnResult");
    if (!Array.isArray(localView.coLocatedIds) || !Array.isArray(localView.messages)) {
      throw new Error("Malformed local view arrays");
    }
    if (typeof localView.ports.clockwise !== "boolean" || typeof localView.ports.counterClockwise !== "boolean") {
      throw new Error("Incident-port values must be boolean");
    }
    if (!Number.isInteger(localView.pebbleCount) || localView.pebbleCount < 0) {
      throw new Error("Local pebble count must be a non-negative integer");
    }
    if (!localView.coLocatedIds.every(Number.isInteger)) {
      throw new Error("Co-located identifiers must be integers");
    }
    if (!Object.values(OwnResultKind).includes(localView.lastOwnResult.kind)) {
      throw new Error(`Unsupported own-result kind: ${localView.lastOwnResult.kind}`);
    }
    if (!Object.values(Direction).includes(localView.lastOwnResult.direction)) {
      throw new Error(`Unsupported own-result direction: ${localView.lastOwnResult.direction}`);
    }
    for (const [index, message] of localView.messages.entries()) {
      requireExactKeys(message, ["id", "mode", "stage", "role", "event"], `localView.messages[${index}]`);
      sanitizeMessage(message);
    }
    return true;
  }

  function makeClaim(clockwiseDistance, counterClockwiseDistance, reason) {
    return deepFreeze({
      clockwiseDistance: Number(clockwiseDistance),
      counterClockwiseDistance: Number(counterClockwiseDistance),
      reason: String(reason),
    });
  }

  function actionIntent(action, reason, claim) {
    return deepFreeze({
      action,
      reason: String(reason || ""),
      claim: claim || null,
    });
  }

  function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }

  Object.assign(GLSim, {
    Action,
    Direction,
    MessageEvent,
    Mode,
    OwnResultKind,
    PebbleOperation,
    Role,
    Stage,
    FORBIDDEN_LOCAL_KEYS,
    actionIntent,
    clone,
    deepFreeze,
    findForbiddenKey,
    makeClaim,
    makeLocalView,
    mod,
    stableStringify,
    validateLocalView,
  });
})(globalThis);
