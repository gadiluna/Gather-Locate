(function initAgentMachine(root) {
  "use strict";

  const GLSim = (root.GLSim = root.GLSim || {});
  const {
    Action,
    Mode,
    PebbleOperation,
    Role,
    Stage,
  } = GLSim;

  const RETURN_EVENT = GLSim.MessageEvent.RETURN_COMPLETED;
  const PROBE_EVENT = GLSim.MessageEvent.CAUTIOUS_PROBE;
  const RETRO_EVENT = GLSim.MessageEvent.RETRO_RETURNING;

  const returnModes = new Set([
    Mode.PHASE1_CW,
    Mode.FOLLOW_RETURN,
    Mode.JOINT_AVANGUARD,
    Mode.RT_AVANGUARD,
    Mode.PHASE2_RETURN,
  ]);

  const pebbleReturnModes = new Set([
    Mode.PHASE1_CW,
    Mode.FOLLOW_RETURN,
    Mode.JOINT_AVANGUARD,
    Mode.PHASE2_RETURN,
  ]);

  function initialMemory(id, n) {
    return {
      id,
      n,
      round: 1,
      phase: 1,
      mode: Mode.PHASE1_CW,
      stage: Stage.READY,
      role: Role.NONE,
      jointPartnerId: null,
      jointGroupIds: [],
      carriedPebbles: 1,
      ownPebbleOutstanding: false,
      expectReturn: false,
      ell: 0,
      departure: 0,
      failedReport: 0,
      reportActive: false,
      retroDisplacement: 0,
      retroTarget: -1,
      p2Elapsed: 0,
      terminalClaim: null,
      lastReason: "initial state",
    };
  }

  function signalFor(memory) {
    let event = "NONE";
    if (returnModes.has(memory.mode) && memory.stage === Stage.RETURNED) {
      event = RETURN_EVENT;
    } else if (
      (memory.mode === Mode.PHASE1_CW
        || memory.mode === Mode.FOLLOW_RETURN
        || memory.mode === Mode.JOINT_AVANGUARD
        || memory.mode === Mode.RT_AVANGUARD
        || memory.mode === Mode.PHASE2_RETURN)
      && memory.stage === Stage.PROBE
    ) {
      event = PROBE_EVENT;
    } else if (
      (memory.mode === Mode.RT_RETROGUARD || memory.mode === Mode.BCP_RETROGUARD)
      && memory.stage === Stage.RETURNING
    ) {
      event = RETRO_EVENT;
    }
    return GLSim.deepFreeze({
      id: memory.id,
      mode: memory.mode,
      stage: memory.stage,
      role: memory.role,
      event,
      jointGroupIds: memory.jointGroupIds.slice(),
    });
  }

  function defaultPlan(memory, reason) {
    return {
      memory,
      preparation: {
        pebbleOperation: PebbleOperation.NONE,
        priority: 100,
        reason: reason || "no pebble operation",
      },
      intent: {
        action: Action.STAY,
        reason: reason || "wait",
        claim: null,
      },
      dropRequired: false,
      departureThisRound: false,
      cautiousDepartureThisRound: false,
      modeActionAfterPebble: false,
    };
  }

  function setAction(plan, action, reason, claim) {
    plan.intent = { action, reason, claim: claim || null };
    plan.memory.lastReason = reason;
  }

  function requestPebble(plan, operation, priority, reason) {
    plan.preparation = {
      pebbleOperation: operation,
      priority,
      reason,
    };
  }

  function terminate(plan, claim, reason) {
    plan.memory.mode = Mode.TERMINATED;
    plan.memory.stage = Stage.WAITING;
    plan.memory.role = Role.NONE;
    plan.memory.jointPartnerId = null;
    plan.memory.jointGroupIds = [];
    plan.memory.terminalClaim = claim;
    setAction(plan, Action.TERMINATE, reason, claim);
  }

  function allIds(memory, view) {
    const ids = new Set(view.coLocatedIds);
    ids.add(memory.id);
    return [...ids].sort((a, b) => a - b);
  }

  function peerByMode(view, modes) {
    const accepted = new Set(Array.isArray(modes) ? modes : [modes]);
    return view.messages.find((message) => accepted.has(message.mode));
  }

  function sameIds(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((id, index) => id === right[index]);
  }

  function sameJointGroup(memory, message) {
    return sameIds(memory.jointGroupIds, message.jointGroupIds);
  }

  function jointGroupReady(memory, view) {
    const groupIds = memory.jointGroupIds;
    if (!Array.isArray(groupIds) || groupIds.length < 2 || groupIds.length > 3) {
      return false;
    }
    const avanguardId = groupIds[groupIds.length - 1];
    return groupIds.every((id) => {
      if (id === memory.id) {
        const expectedMode = id === avanguardId ? Mode.JOINT_AVANGUARD : Mode.JOINT_LEADER;
        return memory.mode === expectedMode && memory.stage === Stage.READY;
      }
      const message = view.messages.find((candidate) => candidate.id === id);
      if (!message || !sameJointGroup(memory, message) || message.stage !== Stage.READY) {
        return false;
      }
      return message.mode === (id === avanguardId ? Mode.JOINT_AVANGUARD : Mode.JOINT_LEADER);
    });
  }

  function hasCommittedJointStep(memory) {
    if (memory.mode === Mode.JOINT_LEADER) {
      return memory.stage === Stage.WAITING || memory.stage === Stage.ADVANCE;
    }
    if (memory.mode === Mode.JOINT_AVANGUARD) {
      return memory.stage === Stage.PROBE
        || memory.stage === Stage.RETURNED
        || memory.stage === Stage.ADVANCE;
    }
    return false;
  }

  function startsJointStepNow(memory, view) {
    return view.ports.clockwise
      && memory.stage === Stage.READY
      && (memory.mode === Mode.JOINT_LEADER || memory.mode === Mode.JOINT_AVANGUARD)
      && jointGroupReady(memory, view);
  }

  function isAvailableForPhase1Group(state) {
    return (state.mode === Mode.PHASE1_CW && state.stage === Stage.READY)
      || ((state.mode === Mode.JOINT_LEADER || state.mode === Mode.JOINT_AVANGUARD)
        && state.stage === Stage.READY);
  }

  function availablePhase1Ids(memory, view) {
    const ids = [];
    if (isAvailableForPhase1Group(memory)) ids.push(memory.id);
    for (const message of view.messages) {
      if (isAvailableForPhase1Group(message)) ids.push(message.id);
    }
    return [...new Set(ids)].sort((a, b) => a - b);
  }

  function hasReturn(view) {
    return view.messages.some((message) => message.event === RETURN_EVENT);
  }

  function isSelfReturned(memory) {
    return returnModes.has(memory.mode) && memory.stage === Stage.RETURNED;
  }

  function isPhase2Round(memory) {
    return memory.round > 6 * memory.n;
  }

  function setJointRole(memory, ids, stage) {
    const sorted = [...new Set(ids)].sort((a, b) => a - b);
    if (sorted.length < 2 || sorted.length > 3) {
      throw new Error("JointCW requires two or three local agents");
    }
    const avanguardId = sorted[sorted.length - 1];
    if (memory.id === avanguardId) {
      memory.mode = Mode.JOINT_AVANGUARD;
      memory.role = Role.AVANGUARD;
      memory.jointPartnerId = sorted[0];
    } else {
      memory.mode = Mode.JOINT_LEADER;
      memory.role = Role.LEADER;
      memory.jointPartnerId = avanguardId;
    }
    memory.stage = stage || Stage.READY;
    memory.jointGroupIds = sorted;
    memory.expectReturn = false;
    memory.ownPebbleOutstanding = false;
  }

  function setStandardRTRole(memory, ids) {
    const sorted = ids.slice().sort((a, b) => a - b);
    const rank = sorted.indexOf(memory.id);
    memory.expectReturn = false;
    memory.jointPartnerId = null;
    memory.jointGroupIds = [];
    memory.ownPebbleOutstanding = false;
    memory.ell = 0;
    memory.failedReport = 0;
    memory.departure = 1;
    memory.reportActive = rank === 0;
    memory.retroDisplacement = 0;
    memory.retroTarget = -1;
    if (rank === 0) {
      memory.mode = Mode.RT_LEADER;
      memory.role = Role.LEADER;
      memory.stage = Stage.READY;
    } else if (rank === 1) {
      memory.mode = Mode.RT_AVANGUARD;
      memory.role = Role.AVANGUARD;
      memory.stage = Stage.READY;
    } else {
      memory.mode = Mode.RT_RETROGUARD;
      memory.role = Role.RETROGUARD;
      memory.stage = Stage.OUTBOUND;
    }
  }

  function setBCPRole(memory, ids) {
    const sorted = ids.slice().sort((a, b) => a - b);
    memory.expectReturn = false;
    memory.jointPartnerId = null;
    memory.jointGroupIds = [];
    memory.ownPebbleOutstanding = false;
    memory.ell = 0;
    memory.failedReport = 0;
    memory.departure = 1;
    memory.retroDisplacement = 0;
    memory.retroTarget = -1;
    if (memory.id === sorted[0]) {
      memory.mode = Mode.BCP_AGGRESSIVE_LEADER;
      memory.role = Role.AGGRESSIVE_LEADER;
      memory.stage = Stage.MOVING;
      memory.reportActive = true;
    } else {
      memory.mode = Mode.BCP_RETROGUARD;
      memory.role = Role.RETROGUARD;
      memory.stage = Stage.OUTBOUND;
      memory.reportActive = false;
    }
  }

  function setForward(memory) {
    memory.mode = Mode.FORWARD;
    memory.role = Role.FORWARD;
    memory.stage = Stage.MOVING;
    memory.expectReturn = false;
    memory.jointPartnerId = null;
    memory.jointGroupIds = [];
    memory.reportActive = false;
    memory.ownPebbleOutstanding = false;
  }

  function claimClockwiseNeighbour(memory, reason) {
    return GLSim.makeClaim(1, memory.n - 1, reason);
  }

  function claimRetroTarget(memory, reason) {
    const target = -memory.departure;
    const clockwiseDistance = GLSim.mod(target - memory.ell, memory.n);
    const counterClockwiseDistance = GLSim.mod(memory.ell - target, memory.n);
    return GLSim.makeClaim(clockwiseDistance, counterClockwiseDistance, reason);
  }

  function configureBCPtoRT(memory, view) {
    const selfWasAL = memory.mode === Mode.BCP_AGGRESSIVE_LEADER;
    const selfWasR = memory.mode === Mode.BCP_RETROGUARD;
    const returningId = isSelfReturned(memory)
      ? memory.id
      : (view.messages.find((message) => message.event === RETURN_EVENT) || {}).id;
    const leaderMessage = peerByMode(view, [Mode.BCP_AGGRESSIVE_LEADER, Mode.RT_LEADER]);
    const leaderId = selfWasAL ? memory.id : leaderMessage && leaderMessage.id;

    if (memory.id === leaderId || selfWasAL) {
      memory.mode = Mode.RT_LEADER;
      memory.role = Role.LEADER;
      memory.stage = Stage.ADVANCE;
    } else if (memory.id === returningId || isSelfReturned(memory)) {
      memory.mode = Mode.RT_AVANGUARD;
      memory.role = Role.AVANGUARD;
      memory.stage = Stage.ADVANCE;
    } else if (selfWasR) {
      memory.mode = Mode.RT_RETROGUARD;
      memory.role = Role.RETROGUARD;
    }
    memory.expectReturn = false;
    memory.jointPartnerId = null;
    memory.jointGroupIds = [];
    memory.ownPebbleOutstanding = false;
  }

  function handleCompletedReturn(plan, view) {
    const memory = plan.memory;
    const ids = allIds(memory, view);
    const selfReturned = isSelfReturned(memory);
    const selfIsProbe = signalFor(memory).event === PROBE_EVENT;
    const returnMessages = view.messages.filter((message) => message.event === RETURN_EVENT);
    const sourceModes = new Set(returnMessages.map((message) => message.mode));
    if (selfReturned) sourceModes.add(memory.mode);
    const completedIds = new Set(returnMessages.map((message) => message.id));
    if (selfReturned) completedIds.add(memory.id);
    const pendingProbeIds = new Set(
      view.messages.filter((message) => message.event === PROBE_EVENT).map((message) => message.id),
    );
    if (selfIsProbe) pendingProbeIds.add(memory.id);
    const returnedJointGroups = returnMessages
      .filter((message) => message.mode === Mode.JOINT_AVANGUARD)
      .map((message) => message.jointGroupIds);
    if (selfReturned && memory.mode === Mode.JOINT_AVANGUARD) {
      returnedJointGroups.push(memory.jointGroupIds);
    }
    const belongsToReturnedJointGroup = (message) => returnedJointGroups.some((groupIds) =>
      groupIds.includes(message.id) && sameIds(groupIds, message.jointGroupIds),
    );
    const committedPeerIds = new Set(
      view.messages
        .filter((message) =>
          message.event !== RETURN_EVENT
          && hasCommittedJointStep(message)
          && !(message.mode === Mode.JOINT_LEADER && belongsToReturnedJointGroup(message)),
        )
        .map((message) => message.id),
    );
    const returnGroupIds = ids.filter((id) => !committedPeerIds.has(id));

    const ownJointReturn = (
      memory.mode === Mode.JOINT_LEADER
      && returnMessages.some((message) =>
        message.mode === Mode.JOINT_AVANGUARD
        && sameJointGroup(memory, message),
      )
    ) || (memory.mode === Mode.JOINT_AVANGUARD && selfReturned);

    if (hasCommittedJointStep(memory) && !ownJointReturn) {
      if (memory.mode === Mode.JOINT_LEADER && memory.expectReturn) {
        const claim = claimClockwiseNeighbour(memory, "expected JointCW Avanguard return did not occur");
        terminate(plan, claim, "JointCW Leader ignores an unrelated return and detects its missing Avanguard");
      } else {
        setAction(plan, Action.STAY, "committed JointCW step ignores an unrelated completed return");
      }
      return;
    }

    if (
      selfReturned
      && pebbleReturnModes.has(memory.mode)
      && memory.ownPebbleOutstanding
      && view.pebbleCount > 0
    ) {
      requestPebble(plan, PebbleOperation.TAKE_ALL, 0, "recover pebble before any other rule");
    }
    memory.expectReturn = false;
    if (selfReturned) memory.ownPebbleOutstanding = false;

    // A meeting must never cancel a cautious return that is still pending at
    // this node. A newly encountered agent accompanies the probe back, but an
    // agent completing its own return first recovers its pebble and completes
    // that cautious step.
    const peerProbe = view.messages.some((message) => message.event === PROBE_EVENT);
    if (
      !isPhase2Round(memory)
      && completedIds.size > 0
      && pendingProbeIds.size > 0
    ) {
      if (pendingProbeIds.has(memory.id)) {
        setAction(plan, Action.STAY, "continue the unrelated cautious return before any meeting rule");
        return;
      }

      const completionGroupIds = returnGroupIds.filter((id) => !pendingProbeIds.has(id));
      if (completionGroupIds.length >= 2) {
        setJointRole(memory, completionGroupIds, Stage.ADVANCE);
        setAction(plan, Action.STAY, "the completed-return group finishes the certified crossing together");
      } else {
        memory.mode = Mode.PHASE1_CW;
        memory.role = Role.NONE;
        memory.stage = Stage.FINAL_CROSSING;
        memory.jointPartnerId = null;
        memory.jointGroupIds = [];
        setAction(plan, Action.STAY, "finish this cautious step independently of the unrelated probe");
      }
      return;
    }
    if (
      !isPhase2Round(memory)
      && (selfIsProbe || (peerProbe && view.ports.counterClockwise))
      && !hasCommittedJointStep(memory)
    ) {
      if (!selfIsProbe) {
        memory.mode = Mode.FOLLOW_RETURN;
        memory.stage = Stage.PROBE;
        memory.role = Role.NONE;
        memory.jointPartnerId = null;
        memory.jointGroupIds = [];
      }
      setAction(plan, Action.STAY, "a pending cautious return has priority over this meeting");
      return;
    }

    if (sourceModes.has(Mode.RT_AVANGUARD)) {
      if (memory.mode === Mode.RT_LEADER || memory.mode === Mode.RT_AVANGUARD) {
        memory.stage = Stage.ADVANCE;
      }
      setAction(plan, Action.STAY, "RT return completed; prepare the joint final crossing");
      return;
    }

    if (sourceModes.has(Mode.JOINT_AVANGUARD) && !isPhase2Round(memory)) {
      const requiredPartners = memory.jointGroupIds.length > 1
        ? memory.jointGroupIds.filter((id) => id !== memory.id)
        : [memory.jointPartnerId].filter(Number.isInteger);
      const orphanedSelf = selfReturned
        && memory.mode === Mode.JOINT_AVANGUARD
        && requiredPartners.some((id) => !returnGroupIds.includes(id));
      if (orphanedSelf) {
        memory.mode = Mode.PHASE1_CW;
        memory.role = Role.NONE;
        memory.stage = Stage.FINAL_CROSSING;
        memory.jointPartnerId = null;
        memory.jointGroupIds = [];
        memory.expectReturn = false;
        memory.ownPebbleOutstanding = false;
        setAction(plan, Action.STAY, "orphaned JointCW Avanguard completes the certified crossing alone");
      } else if (returnGroupIds.length >= 2) {
        setJointRole(memory, returnGroupIds, Stage.ADVANCE);
        setAction(plan, Action.STAY, "JointCW return completed; the group performs the final crossing");
      } else {
        memory.mode = Mode.PHASE1_CW;
        memory.role = Role.NONE;
        memory.stage = Stage.FINAL_CROSSING;
        memory.jointPartnerId = null;
        memory.jointGroupIds = [];
        memory.expectReturn = false;
        memory.ownPebbleOutstanding = false;
        setAction(plan, Action.STAY, "single returning agent completes the certified crossing alone");
      }
      return;
    }

    if (isPhase2Round(memory) || sourceModes.has(Mode.PHASE2_RETURN)) {
      memory.phase = 2;
      // Select the new procedure's action after simultaneous pebble recovery,
      // using decide()'s post-recovery view but still in this activation.
      plan.modeActionAfterPebble = true;
      const bcpPresent = memory.mode === Mode.BCP_AGGRESSIVE_LEADER
        || memory.mode === Mode.BCP_RETROGUARD
        || Boolean(peerByMode(view, [Mode.BCP_AGGRESSIVE_LEADER, Mode.BCP_RETROGUARD, Mode.RT_LEADER]));
      if (bcpPresent) {
        configureBCPtoRT(memory, view);
        setAction(plan, Action.STAY, "return at the marked node converts BackwardCP to CautiousPendulum");
      } else if (ids.length >= 3) {
        setStandardRTRole(memory, ids);
        plan.departureThisRound = memory.role === Role.LEADER;
        setAction(plan, Action.STAY, "three co-located agents start CautiousPendulum");
      } else if (ids.length === 2) {
        setBCPRole(memory, ids);
        plan.departureThisRound = memory.role === Role.AGGRESSIVE_LEADER;
        setAction(plan, Action.STAY, "the return meets a waiting agent; both start BackwardCP");
      } else {
        setForward(memory);
        setAction(plan, Action.STAY, "the returning agent is alone and enters Forward after recovering its pebble");
      }
      return;
    }

    if (returnGroupIds.length >= 2) {
      setJointRole(memory, returnGroupIds, Stage.ADVANCE);
      setAction(plan, Action.STAY, "co-located agents form JointCW after the cautious return");
    } else {
      memory.mode = Mode.PHASE1_CW;
      memory.role = Role.NONE;
      memory.stage = Stage.FINAL_CROSSING;
      memory.jointPartnerId = null;
      memory.jointGroupIds = [];
      setAction(plan, Action.STAY, "cautious return completed; prepare the final crossing");
    }
  }

  function enterPhase2(plan, view) {
    const memory = plan.memory;
    memory.phase = 2;
    memory.p2Elapsed = 0;
    memory.expectReturn = false;
    const ids = allIds(memory, view);

    if (
      memory.mode === Mode.RT_LEADER
      || memory.mode === Mode.RT_AVANGUARD
      || memory.mode === Mode.RT_RETROGUARD
    ) return;

    if (ids.length >= 3) {
      setStandardRTRole(memory, ids);
      plan.departureThisRound = memory.role === Role.LEADER;
      return;
    }
    if (ids.length === 2) {
      setBCPRole(memory, ids);
      plan.departureThisRound = memory.role === Role.AGGRESSIVE_LEADER;
      return;
    }

    const isReturner = (
      memory.mode === Mode.PHASE1_CW
      || memory.mode === Mode.FOLLOW_RETURN
      || memory.mode === Mode.JOINT_AVANGUARD
    ) && memory.stage === Stage.PROBE;
    if (isReturner) {
      memory.mode = Mode.PHASE2_RETURN;
      memory.role = Role.NONE;
      memory.stage = Stage.PROBE;
      memory.jointPartnerId = null;
      memory.jointGroupIds = [];
    } else if (view.pebbleCount > 0 || memory.mode === Mode.PHASE1_WAIT) {
      memory.mode = Mode.PHASE2_WAIT;
      memory.role = Role.NONE;
      memory.stage = Stage.WAITING;
      memory.jointPartnerId = null;
      memory.jointGroupIds = [];
    } else {
      setForward(memory);
    }
  }

  function handleLeaderRetroguard(plan, view) {
    const memory = plan.memory;
    if (memory.mode !== Mode.RT_LEADER && memory.mode !== Mode.BCP_AGGRESSIVE_LEADER) return false;

    const returningRetroguard = view.messages.find((message) =>
      (message.mode === Mode.RT_RETROGUARD || message.mode === Mode.BCP_RETROGUARD)
      && message.event === RETRO_EVENT,
    );
    if (returningRetroguard) {
      memory.departure = Math.max(1, memory.departure + 1);
      memory.failedReport = 0;
      memory.reportActive = true;
      plan.departureThisRound = true;
    } else if (memory.reportActive && memory.failedReport >= 2 * memory.n) {
      const claim = claimRetroTarget(memory, "Retroguard failed to report");
      terminate(plan, claim, "failed-report counter reached 2n and no Retroguard is co-located");
      return true;
    }
    return false;
  }

  function finishLeaderCounter(plan, view) {
    const memory = plan.memory;
    if (
      (memory.mode === Mode.RT_LEADER || memory.mode === Mode.BCP_AGGRESSIVE_LEADER)
      && memory.reportActive
      && !plan.departureThisRound
      && !view.ports.clockwise
      && plan.intent.action === Action.MOVE_CW
    ) {
      memory.failedReport += 1;
    }
  }

  function shouldMakeFailedReportAttempt(plan, view) {
    return plan.memory.reportActive
      && !plan.departureThisRound
      && !view.ports.clockwise;
  }

  function startPhase1Meeting(plan, view) {
    const memory = plan.memory;
    const ids = availablePhase1Ids(memory, view);
    if (ids.length >= 2) {
      setJointRole(memory, ids, Stage.READY);
      if (view.ports.clockwise) {
        plan.cautiousDepartureThisRound = true;
      }
      return true;
    }
    return false;
  }

  function planRetroguard(plan, view) {
    const memory = plan.memory;
    const leader = peerByMode(view, [Mode.RT_LEADER, Mode.BCP_AGGRESSIVE_LEADER]);

    if (memory.stage === Stage.RETURNING && leader) {
      if (memory.mode === Mode.BCP_RETROGUARD && leader.mode === Mode.RT_LEADER) {
        memory.mode = Mode.RT_RETROGUARD;
      }
      memory.departure = Math.max(1, memory.departure + 1);
      memory.retroTarget = -memory.departure;
      memory.stage = Stage.OUTBOUND;
    }

    if (memory.stage === Stage.OUTBOUND) {
      if (view.ports.counterClockwise) {
        memory.retroDisplacement -= 1;
        if (memory.retroDisplacement <= memory.retroTarget) memory.stage = Stage.RETURNING;
      }
      setAction(plan, Action.MOVE_CCW, "Retroguard follows the counter-clockwise leg of its departure");
      return;
    }

    if (view.ports.clockwise) memory.retroDisplacement += 1;
    setAction(plan, Action.MOVE_CW, "Retroguard moves clockwise until it reports to the Leader");
  }

  function planModeAction(plan, view) {
    const memory = plan.memory;

    switch (memory.mode) {
      case Mode.PHASE1_CW:
        if (memory.stage === Stage.PROBE) {
          if (view.ports.counterClockwise) memory.stage = Stage.RETURNED;
          setAction(plan, Action.MOVE_CCW, "complete the return of the cautious step");
        } else if (memory.stage === Stage.FINAL_CROSSING) {
          if (view.ports.clockwise) memory.stage = Stage.READY;
          setAction(plan, view.ports.clockwise ? Action.MOVE_CW : Action.STAY, "move to the node certified safe by the probe");
        } else if (view.ports.clockwise) {
          requestPebble(plan, PebbleOperation.DROP_ONE, 20, "mark the safe endpoint before probing");
          plan.dropRequired = true;
          memory.ownPebbleOutstanding = true;
          memory.stage = Stage.PROBE;
          setAction(plan, Action.MOVE_CW, "begin a clockwise cautious step");
        } else {
          setAction(plan, Action.STAY, "clockwise edge is absent before the cautious step");
        }
        break;

      case Mode.FOLLOW_RETURN:
        if (memory.stage === Stage.PROBE) {
          if (view.ports.counterClockwise) memory.stage = Stage.RETURNED;
          setAction(plan, Action.MOVE_CCW, "follow the probing agent back to the known-safe endpoint");
        }
        break;

      case Mode.PHASE1_WAIT:
        if (view.ports.clockwise) memory.expectReturn = true;
        setAction(plan, Action.STAY, "wait at a pebble left by an absent agent");
        break;

      case Mode.JOINT_AVANGUARD:
        if (memory.stage === Stage.ADVANCE) {
          if (view.ports.clockwise) memory.stage = Stage.READY;
          setAction(plan, view.ports.clockwise ? Action.MOVE_CW : Action.STAY, "JointCW final crossing");
        } else if (memory.stage === Stage.PROBE) {
          if (view.ports.counterClockwise) memory.stage = Stage.RETURNED;
          setAction(plan, Action.MOVE_CCW, "JointCW Avanguard returns to the Leader");
        } else if (
          view.ports.clockwise
          && (plan.cautiousDepartureThisRound || jointGroupReady(memory, view))
        ) {
          requestPebble(plan, PebbleOperation.DROP_ONE, 20, "JointCW Avanguard marks the safe endpoint");
          plan.dropRequired = true;
          memory.ownPebbleOutstanding = true;
          memory.stage = Stage.PROBE;
          setAction(plan, Action.MOVE_CW, "JointCW Avanguard probes clockwise");
        } else {
          setAction(plan, Action.STAY, "JointCW waits for every group member and the clockwise edge");
        }
        break;

      case Mode.JOINT_LEADER: {
        if (memory.stage === Stage.ADVANCE) {
          if (view.ports.clockwise) memory.stage = Stage.READY;
          setAction(plan, view.ports.clockwise ? Action.MOVE_CW : Action.STAY, "JointCW Leader makes the final crossing");
        } else {
          if (
            memory.stage === Stage.READY
            && view.ports.clockwise
            && (jointGroupReady(memory, view) || plan.cautiousDepartureThisRound)
          ) {
            memory.stage = Stage.WAITING;
          } else if (memory.stage === Stage.WAITING && view.ports.clockwise) {
            memory.expectReturn = true;
          }
          setAction(plan, Action.STAY, "JointCW Leader waits for the Avanguard");
        }
        break;
      }

      case Mode.RT_AVANGUARD:
        if (memory.stage === Stage.ADVANCE) {
          if (view.ports.clockwise) memory.stage = Stage.READY;
          setAction(plan, view.ports.clockwise ? Action.MOVE_CW : Action.STAY, "RT Avanguard makes the final crossing with the Leader");
        } else if (memory.stage === Stage.PROBE) {
          if (view.ports.counterClockwise) memory.stage = Stage.RETURNED;
          setAction(plan, Action.MOVE_CCW, "RT Avanguard returns from the clockwise probe");
        } else if (view.ports.clockwise) {
          memory.stage = Stage.PROBE;
          setAction(plan, Action.MOVE_CW, "RT Avanguard probes the clockwise neighbour");
        } else {
          setAction(plan, Action.STAY, "RT Avanguard waits for the clockwise edge");
        }
        break;

      case Mode.RT_LEADER: {
        if (memory.stage === Stage.ADVANCE) {
          if (view.ports.clockwise) {
            memory.stage = Stage.READY;
            memory.ell += 1;
          }
          setAction(
            plan,
            Action.MOVE_CW,
            view.ports.clockwise
              ? "RT Leader moves to the certified-safe node"
              : "RT Leader attempts the blocked certified-safe crossing",
          );
        } else {
          const avanguard = peerByMode(view, Mode.RT_AVANGUARD);
          if (
            memory.stage === Stage.READY
            && view.ports.clockwise
            && ((avanguard && avanguard.stage === Stage.READY) || plan.departureThisRound)
          ) {
            memory.stage = Stage.WAITING;
          } else if (memory.stage === Stage.WAITING && view.ports.clockwise) {
            memory.expectReturn = true;
          }
          const blockedAttempt = shouldMakeFailedReportAttempt(plan, view);
          setAction(
            plan,
            blockedAttempt ? Action.MOVE_CW : Action.STAY,
            blockedAttempt
              ? "RT Leader makes a blocked clockwise attempt while monitoring the Retroguard"
              : "RT Leader waits for the Avanguard and monitors the Retroguard",
          );
        }
        break;
      }

      case Mode.RT_RETROGUARD:
      case Mode.BCP_RETROGUARD:
        planRetroguard(plan, view);
        break;

      case Mode.PHASE2_RETURN: {
        const timeout = 4 * memory.n * memory.n;
        if (memory.p2Elapsed >= timeout && !view.ports.counterClockwise) {
          if (view.pebbleCount > 0) {
            const claim = claimClockwiseNeighbour(memory, "Forward encountered the permanent black-hole mark");
            terminate(plan, claim, "enter Forward and identify the clockwise neighbour of the pebble already at this node");
          } else {
            setForward(memory);
            setAction(plan, Action.MOVE_CW, "the 4n^2 rounds ended while the return remained blocked; enter Forward");
          }
        } else {
          if (view.ports.counterClockwise) memory.stage = Stage.RETURNED;
          memory.p2Elapsed += 1;
          setAction(plan, Action.MOVE_CCW, "continue the Phase-2 return attempt");
        }
        break;
      }

      case Mode.PHASE2_WAIT: {
        const timeout = 4 * memory.n * memory.n;
        if (memory.p2Elapsed >= timeout && !view.ports.clockwise) {
          if (view.pebbleCount > 0) requestPebble(plan, PebbleOperation.TAKE_ALL, 0, "remove the temporary pebble at timeout");
          setForward(memory);
          setAction(plan, Action.MOVE_CW, "the 4n^2 rounds ended while separation persisted; enter Forward");
        } else {
          memory.p2Elapsed += 1;
          setAction(plan, Action.STAY, "wait for the Phase-2 returning agent");
        }
        break;
      }

      case Mode.BCP_AGGRESSIVE_LEADER:
        if (view.pebbleCount > 0 || memory.stage === Stage.AT_MARK) {
          memory.stage = Stage.AT_MARK;
          if (view.ports.clockwise) memory.expectReturn = true;
          const blockedAttempt = shouldMakeFailedReportAttempt(plan, view);
          setAction(
            plan,
            blockedAttempt ? Action.MOVE_CW : Action.STAY,
            blockedAttempt
              ? "AggressiveLeader makes a blocked clockwise attempt while waiting at the first pebble"
              : "AggressiveLeader waits at the first pebble",
          );
        } else if (view.ports.clockwise) {
          memory.ell += 1;
          memory.stage = Stage.MOVING;
          setAction(plan, Action.MOVE_CW, "AggressiveLeader moves clockwise without a cautious step");
        } else {
          setAction(plan, Action.MOVE_CW, "AggressiveLeader makes a blocked clockwise movement attempt");
        }
        break;

      case Mode.FORWARD: {
        if (view.pebbleCount > 0) {
          const claim = claimClockwiseNeighbour(memory, "Forward encountered the permanent black-hole mark");
          terminate(plan, claim, "Forward sees a pebble and identifies its clockwise neighbour");
          break;
        }
        const forwardPeers = view.messages.filter((message) => message.mode === Mode.FORWARD);
        if (forwardPeers.length === 1 && allIds(memory, view).length === 2) {
          setBCPRole(memory, allIds(memory, view));
          plan.departureThisRound = memory.role === Role.AGGRESSIVE_LEADER;
          setAction(plan, Action.STAY, "two Forward agents meet and start BackwardCP");
        } else if (forwardPeers.length > 1) {
          setAction(plan, Action.STAY, "unreachable configuration: three Forward agents are co-located");
        } else {
          setAction(plan, Action.MOVE_CW, "Forward moves clockwise without placing a pebble");
        }
        break;
      }

      case Mode.TERMINATED:
        setAction(plan, Action.STAY, "terminated agent has no further action");
        break;

      default:
        setAction(plan, Action.STAY, `unknown local state ${memory.mode}`);
    }
  }

  function computePlan(originalMemory, view) {
    GLSim.validateLocalView(view);
    const memory = GLSim.clone(originalMemory);
    const plan = defaultPlan(memory, "evaluate local rules");
    const selfReturned = isSelfReturned(memory);
    const peerReturned = hasReturn(view);

    if (memory.mode === Mode.TERMINATED) {
      planModeAction(plan, view);
      return plan;
    }

    // The paper gives completed returns and pebble recovery priority over every
    // termination, role-change, timeout, and movement rule.
    if (selfReturned || peerReturned) {
      handleCompletedReturn(plan, view);
      if (plan.memory.mode === Mode.TERMINATED) return plan;
      if (handleLeaderRetroguard(plan, view)) return plan;
      if (!plan.modeActionAfterPebble) {
        planModeAction(plan, view);
        finishLeaderCounter(plan, view);
      }
      return plan;
    }

    if (memory.expectReturn) {
      const claim = claimClockwiseNeighbour(memory, "expected cautious return did not occur");
      terminate(plan, claim, "the edge was present in the preceding round but no return occurred");
      return plan;
    }

    if (handleLeaderRetroguard(plan, view)) return plan;

    if (memory.round === 6 * memory.n + 1 && memory.phase === 1) {
      enterPhase2(plan, view);
    }

    // A Phase-1 agent meeting a probe at its clockwise endpoint follows that
    // probe back before applying ordinary meeting rules.
    if (
      memory.phase === 1
      && signalFor(memory).event !== PROBE_EVENT
      && view.messages.some((message) => message.event === PROBE_EVENT)
      && view.ports.counterClockwise
      && memory.mode !== Mode.RT_LEADER
      && memory.mode !== Mode.RT_AVANGUARD
      && memory.mode !== Mode.RT_RETROGUARD
      && !hasCommittedJointStep(memory)
      && !startsJointStepNow(memory, view)
    ) {
      memory.mode = Mode.FOLLOW_RETURN;
      memory.stage = Stage.PROBE;
      memory.role = Role.NONE;
      memory.jointPartnerId = null;
      memory.jointGroupIds = [];
    }

    if (memory.phase === 1) {
      const pendingProbeHere = signalFor(memory).event === PROBE_EVENT
        || view.messages.some((message) => message.event === PROBE_EVENT);
      const phase1AtMark = memory.mode === Mode.PHASE1_CW
        && (memory.stage === Stage.READY || memory.stage === Stage.FINAL_CROSSING);
      const jointAtMark = (
        memory.mode === Mode.JOINT_LEADER || memory.mode === Mode.JOINT_AVANGUARD
      ) && memory.stage === Stage.READY;
      if ((phase1AtMark || jointAtMark) && view.pebbleCount > 0 && !memory.ownPebbleOutstanding) {
        memory.mode = Mode.PHASE1_WAIT;
        memory.stage = Stage.WAITING;
        memory.role = Role.NONE;
        memory.jointPartnerId = null;
        memory.jointGroupIds = [];
      } else if (
        isAvailableForPhase1Group(memory)
        && !pendingProbeHere
        && availablePhase1Ids(memory, view).length >= 2
      ) {
        startPhase1Meeting(plan, view);
      }
    }

    if (
      memory.phase === 2
      && memory.mode !== Mode.PHASE2_RETURN
      && memory.mode !== Mode.PHASE2_WAIT
      && memory.mode !== Mode.RT_LEADER
      && memory.mode !== Mode.RT_AVANGUARD
      && memory.mode !== Mode.RT_RETROGUARD
      && memory.mode !== Mode.BCP_AGGRESSIVE_LEADER
      && memory.mode !== Mode.BCP_RETROGUARD
      && memory.mode !== Mode.FORWARD
    ) {
      setForward(memory);
    }

    planModeAction(plan, view);
    finishLeaderCounter(plan, view);
    return plan;
  }

  class AgentMachine {
    constructor(options) {
      const config = options || {};
      const id = Number(config.id);
      const n = Number(config.n);
      if (!Number.isInteger(id)) throw new TypeError("Agent id must be an integer");
      if (!Number.isInteger(n) || n <= 3) throw new TypeError("Known ring size n must be an integer greater than 3");
      const cleanMemory = initialMemory(id, n);
      if (config.initialMemory) {
        const allowedKeys = new Set(Object.keys(cleanMemory));
        for (const key of Object.keys(config.initialMemory)) {
          if (!allowedKeys.has(key)) {
            throw new Error(`Unsupported private-memory field: ${key}`);
          }
        }
        Object.assign(cleanMemory, GLSim.clone(config.initialMemory), { id, n });
        if (cleanMemory.terminalClaim !== null) {
          cleanMemory.terminalClaim = GLSim.makeClaim(
            cleanMemory.terminalClaim.clockwiseDistance,
            cleanMemory.terminalClaim.counterClockwiseDistance,
            cleanMemory.terminalClaim.reason,
          );
        }
      }
      this.memory = cleanMemory;
      this.pending = null;
      this.lastTrace = null;
    }

    announce() {
      return signalFor(this.memory);
    }

    prepare(localView) {
      if (this.pending) throw new Error("prepare() called twice without decide()");
      const before = GLSim.clone(this.memory);
      const plan = computePlan(before, localView);
      this.pending = {
        before,
        localView: GLSim.clone(localView),
        plan,
      };
      return GLSim.deepFreeze(GLSim.clone(plan.preparation));
    }

    decide(postPebbleView, pebbleResult) {
      if (!this.pending) throw new Error("decide() called before prepare()");
      GLSim.validateLocalView(postPebbleView);
      const pending = this.pending;
      this.pending = null;
      const result = pebbleResult || {
        requested: PebbleOperation.NONE,
        success: true,
        count: 0,
        reason: "NONE",
      };
      let memory = GLSim.clone(pending.plan.memory);
      let intent = GLSim.clone(pending.plan.intent);

      if (pending.plan.dropRequired && !result.success) {
        memory = GLSim.clone(pending.before);
        intent = {
          action: Action.STAY,
          reason: "the cautious probe cannot start because no carried pebble was dropped",
          claim: null,
        };
      } else {
        if (result.requested === PebbleOperation.DROP_ONE && result.success) {
          memory.carriedPebbles = Math.max(0, memory.carriedPebbles - result.count);
        } else if (result.requested === PebbleOperation.TAKE_ALL && result.success) {
          memory.carriedPebbles += result.count;
          memory.ownPebbleOutstanding = false;
        }
      }

      if (pending.plan.modeActionAfterPebble && memory.mode !== Mode.TERMINATED) {
        const actionPlan = defaultPlan(memory, "select the post-recovery Phase-2 action");
        actionPlan.departureThisRound = pending.plan.departureThisRound;
        actionPlan.cautiousDepartureThisRound = pending.plan.cautiousDepartureThisRound;
        planModeAction(actionPlan, postPebbleView);
        finishLeaderCounter(actionPlan, postPebbleView);
        memory = actionPlan.memory;
        intent = actionPlan.intent;
      }

      memory.round = pending.before.round + 1;
      memory.lastReason = intent.reason;
      this.memory = memory;
      this.lastTrace = GLSim.deepFreeze({
        localRound: pending.before.round,
        before: GLSim.clone(pending.before),
        localView: GLSim.clone(pending.localView),
        preparation: GLSim.clone(pending.plan.preparation),
        pebbleResult: GLSim.clone(result),
        postPebbleView: GLSim.clone(postPebbleView),
        intent: GLSim.clone(intent),
        after: GLSim.clone(memory),
      });
      return GLSim.actionIntent(intent.action, intent.reason, intent.claim);
    }

    snapshot() {
      return GLSim.deepFreeze(GLSim.clone(this.memory));
    }

    getLastTrace() {
      return this.lastTrace ? GLSim.deepFreeze(GLSim.clone(this.lastTrace)) : null;
    }
  }

  Object.assign(GLSim, {
    AgentMachine,
    createAgentMachine: (options) => new AgentMachine(options),
  });
})(globalThis);
