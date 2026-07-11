(function initSchedulers(root) {
  "use strict";

  const GLSim = (root.GLSim = root.GLSim || {});

  function edgeOrNull(value, n) {
    if (value === null || value === undefined || value === "" || value === "none") {
      return null;
    }
    const edge = Number(value);
    if (!Number.isInteger(edge) || edge < 0 || edge >= n) {
      throw new RangeError(`Missing edge must be null or an integer in [0, ${n - 1}]`);
    }
    return edge;
  }

  function normalizePatternIntervals(value, n) {
    if (!Array.isArray(value)) throw new TypeError("Pattern intervals must be an array");
    const intervals = value.map((raw, index) => {
      const entry = raw || {};
      const edge = edgeOrNull(entry.edge ?? entry.missingEdge, n);
      const start = Number(entry.start ?? entry.from);
      const end = Number(entry.end ?? entry.to);
      if (edge === null) throw new RangeError(`Pattern interval ${index + 1} needs an edge`);
      if (!Number.isInteger(start) || start < 1) {
        throw new RangeError(`Pattern interval ${index + 1} must start at a positive round`);
      }
      if (!Number.isInteger(end) || end < start) {
        throw new RangeError(`Pattern interval ${index + 1} must end at or after round ${start}`);
      }
      return { edge, start, end };
    }).sort((left, right) => left.start - right.start || left.end - right.end || left.edge - right.edge);

    for (let first = 0; first < intervals.length; first += 1) {
      for (let second = first + 1; second < intervals.length; second += 1) {
        const left = intervals[first];
        const right = intervals[second];
        if (right.start > left.end) break;
        if (left.edge !== right.edge) {
          throw new Error(
            `Pattern removes edges ${left.edge} and ${right.edge} in overlapping rounds ${right.start}–${Math.min(left.end, right.end)}`,
          );
        }
      }
    }
    return intervals;
  }

  function parseMissingEdgePattern(source, n) {
    const intervals = [];
    String(source || "").split(/\r?\n/).forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) return;
      const match = /^edge\s+(\d+)\s+absent\s+from\s+(\d+)\s+to\s+(\d+)\s*$/i.exec(line);
      if (!match) {
        throw new Error(
          `Invalid pattern on line ${index + 1}. Use: edge 1 absent from 5 to 12`,
        );
      }
      intervals.push({ edge: Number(match[1]), start: Number(match[2]), end: Number(match[3]) });
    });
    return normalizePatternIntervals(intervals, n);
  }

  class NoneScheduler {
    next() {
      return null;
    }

    reset() {}

    snapshot() {
      return { type: "none" };
    }
  }

  class ManualScheduler {
    constructor(config, n) {
      const options = config || {};
      this.n = Number(n || options.n);
      this.missingEdge = edgeOrNull(options.missingEdge, this.n);
    }

    setMissingEdge(edge) {
      this.missingEdge = edgeOrNull(edge, this.n);
      return this.missingEdge;
    }

    next() {
      return this.missingEdge;
    }

    reset() {}

    snapshot() {
      return { type: "manual", missingEdge: this.missingEdge };
    }
  }

  class PatternScheduler {
    constructor(config, n) {
      const options = config || {};
      this.n = Number(n || options.n);
      this.source = String(options.pattern ?? options.text ?? "");
      this.intervals = options.intervals
        ? normalizePatternIntervals(options.intervals, this.n)
        : parseMissingEdgePattern(this.source, this.n);
    }

    next(context) {
      const round = Number(context && context.round);
      const interval = this.intervals.find((entry) => round >= entry.start && round <= entry.end);
      return interval ? interval.edge : null;
    }

    reset() {}

    snapshot() {
      return {
        type: "pattern",
        source: this.source,
        intervals: this.intervals.map((entry) => ({ ...entry })),
      };
    }
  }

  // Xorshift32 is small, deterministic in every modern browser, and sufficient
  // for repeatable demonstrations. It is not intended for cryptography.
  class SeededRandomScheduler {
    constructor(config, n) {
      const options = config || {};
      this.n = Number(n || options.n);
      this.seed = Number.isInteger(Number(options.seed)) ? Number(options.seed) >>> 0 : 1;
      this.omissionProbability = Number(options.omissionProbability ?? 0.35);
      if (this.omissionProbability < 0 || this.omissionProbability > 1) {
        throw new RangeError("omissionProbability must lie in [0, 1]");
      }
      this.reset();
    }

    reset() {
      this.state = this.seed || 0x9e3779b9;
      this.generated = 0;
    }

    random() {
      let x = this.state >>> 0;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      this.state = x >>> 0;
      return this.state / 0x100000000;
    }

    next(context) {
      const n = Number((context && context.n) || this.n);
      this.generated += 1;
      if (this.random() >= this.omissionProbability) return null;
      return Math.floor(this.random() * n);
    }

    snapshot() {
      return {
        type: "random",
        seed: this.seed,
        omissionProbability: this.omissionProbability,
        generated: this.generated,
      };
    }
  }

  class ScriptedScheduler {
    constructor(config, n) {
      const options = config || {};
      this.n = Number(n || options.n);
      this.script = Array.isArray(options.script) ? options.script.slice() : [];
      this.repeat = Boolean(options.repeat);
      this.reset();
    }

    reset() {
      this.cursor = 0;
    }

    next(context) {
      const n = Number((context && context.n) || this.n);
      if (this.script.length === 0) return null;

      let index = this.cursor;
      if (index >= this.script.length) {
        if (!this.repeat) {
          this.cursor += 1;
          return null;
        }
        index %= this.script.length;
      }
      this.cursor += 1;

      const entry = this.script[index];
      const value = entry && typeof entry === "object" ? entry.missingEdge : entry;
      return edgeOrNull(value, n);
    }

    snapshot() {
      return {
        type: "scripted",
        script: this.script.slice(),
        repeat: this.repeat,
        cursor: this.cursor,
      };
    }
  }

  function createScheduler(config, n) {
    if (config && typeof config.next === "function") return config;
    const options = config || { type: "none" };
    switch (String(options.type || "none").toLowerCase()) {
      case "none":
      case "open":
        return new NoneScheduler();
      case "manual":
        return new ManualScheduler(options, n);
      case "pattern":
      case "manual-pattern":
      case "manual_pattern":
        return new PatternScheduler(options, n);
      case "random":
      case "seeded-random":
      case "seeded_random":
        return new SeededRandomScheduler(options, n);
      case "script":
      case "scripted":
        return new ScriptedScheduler(options, n);
      default:
        throw new Error(`Unknown scheduler type: ${options.type}`);
    }
  }

  Object.assign(GLSim, {
    ManualScheduler,
    NoneScheduler,
    NoMissingEdgeScheduler: NoneScheduler,
    PatternScheduler,
    ScriptedScheduler,
    SeededRandomScheduler,
    createScheduler,
    edgeOrNull,
    parseMissingEdgePattern,
  });
})(globalThis);
