/*
 * prs.js
 *
 * Pure PR ("milestone") logic. No storage, no DOM: give it sessions, get
 * milestones back. The app saves the results through storage.js.
 *
 * Rules
 *  - Two kinds of milestone: a weight PR (heaviest typed weight so far) and a
 *    rep PR (most reps so far at exactly the same typed weight).
 *  - Typed weight only: blank (bodyweight) counts as 0, so +10 beats
 *    bodyweight, and -20 (less assistance) beats -30.
 *  - Baseline: the first two sessions that contain at least one main set of an
 *    exercise never produce milestones for it. Evaluation starts with the 3rd
 *    such session, however many sets the first two had.
 *  - Every main set is compared with every earlier main set of that exercise,
 *    including earlier sets in the same session.
 *  - A set that beats the max weight only gets the weight PR, not a rep PR too.
 *  - A rep PR needs at least one earlier set at the same weight.
 *  - Ties are not PRs. Weights within 0.01 kg count as equal, so kg/lb
 *    rounding never makes a false PR.
 *  - Drop sets are ignored completely: they never make PRs, never count as
 *    history, and never count toward the baseline.
 *  - Sessions are ordered by their date, then start time; sets by log order.
 */
(function (global) {
  'use strict';

  const TOLERANCE_KG = 0.01;
  const BASELINE_SESSIONS = 2;

  const typedWeight = (set) => (set.weightKg == null ? 0 : set.weightKg);
  const sameWeight = (a, b) => Math.abs(a - b) <= TOLERANCE_KG;

  function sortSessions(sessions) {
    return sessions.slice().sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : (a.startedAt || '').localeCompare(b.startedAt || ''));
  }

  const mainSetsOf = (session, exerciseId) =>
    (session.sets || []).filter((s) => s.kind !== 'drop' && !s.parentId && s.exerciseId === exerciseId);

  /**
   * Every milestone for one exercise across all sessions, oldest first.
   * Each: { exerciseId, sessionId, setId, type: 'weight'|'reps', weightKg,
   *         reps, date, loggedAt, previous: { weightKg, reps } }
   * weightKg is the typed weight (null stays null for bodyweight).
   */
  function computeMilestones(sessions, exerciseId) {
    const out = [];
    const history = [];      // { w, reps } of all earlier main sets
    let sessionCount = 0;

    for (const session of sortSessions(sessions)) {
      const sets = mainSetsOf(session, exerciseId);
      if (!sets.length) continue;
      sessionCount++;
      const evaluate = sessionCount > BASELINE_SESSIONS;

      for (const set of sets) {
        const w = typedWeight(set);
        if (evaluate && history.length) {
          const best = Math.max(...history.map((h) => h.w));
          if (w > best + TOLERANCE_KG) {
            out.push(record('weight', set, session, exerciseId, {
              weightKg: best,
              reps: Math.max(...history.filter((h) => sameWeight(h.w, best)).map((h) => h.reps)),
            }));
          } else {
            const atWeight = history.filter((h) => sameWeight(h.w, w));
            if (atWeight.length) {
              const bestReps = Math.max(...atWeight.map((h) => h.reps));
              if (set.reps > bestReps) {
                out.push(record('reps', set, session, exerciseId, { weightKg: w, reps: bestReps }));
              }
            }
          }
        }
        history.push({ w, reps: set.reps });
      }
    }
    return out;
  }

  function record(type, set, session, exerciseId, previous) {
    return {
      exerciseId,
      sessionId: session.id,
      setId: set.id,
      type,
      weightKg: set.weightKg == null ? null : set.weightKg,
      reps: set.reps,
      date: session.date,
      loggedAt: set.loggedAt || '',
      previous,
    };
  }

  /** Milestones earned by one set (empty array if none). Used for the live banner. */
  function milestonesForSet(sessions, exerciseId, setId) {
    return computeMilestones(sessions, exerciseId).filter((m) => m.setId === setId);
  }

  /** Every exercise that appears in any main set. */
  function exerciseIdsIn(sessions) {
    const ids = new Set();
    for (const s of sessions) for (const set of s.sets || []) if (set.kind !== 'drop') ids.add(set.exerciseId);
    return [...ids];
  }

  /** Milestones for every exercise, oldest first. Used after an import or sample load. */
  function computeAllMilestones(sessions) {
    return exerciseIdsIn(sessions)
      .flatMap((id) => computeMilestones(sessions, id))
      .sort((a, b) => (a.date + a.loggedAt).localeCompare(b.date + b.loggedAt));
  }

  /** Heaviest typed weight per session for the weight chart: [{ date, sessionId, weightKg, reps }] */
  function maxWeightSeries(sessions, exerciseId) {
    const out = [];
    for (const session of sortSessions(sessions)) {
      const sets = mainSetsOf(session, exerciseId);
      if (!sets.length) continue;
      let top = sets[0];
      for (const s of sets) {
        const d = typedWeight(s) - typedWeight(top);
        if (d > TOLERANCE_KG || (Math.abs(d) <= TOLERANCE_KG && s.reps > top.reps)) top = s;
      }
      out.push({ date: session.date, sessionId: session.id, weightKg: top.weightKg == null ? null : top.weightKg, reps: top.reps });
    }
    return out;
  }

  /** Most reps per session at one typed weight, for the reps chart: [{ date, sessionId, reps }] */
  function repsAtWeightSeries(sessions, exerciseId, weightKg) {
    const target = weightKg == null ? 0 : weightKg;
    const out = [];
    for (const session of sortSessions(sessions)) {
      const reps = mainSetsOf(session, exerciseId)
        .filter((s) => sameWeight(typedWeight(s), target))
        .map((s) => s.reps);
      if (reps.length) out.push({ date: session.date, sessionId: session.id, reps: Math.max(...reps) });
    }
    return out;
  }

  /**
   * Distinct typed weights used for an exercise, heaviest first, for the
   * weight picker: [{ weightKg, sets, lastDate }]. Weights within 0.01 kg merge.
   */
  function weightsUsed(sessions, exerciseId) {
    const groups = [];
    for (const session of sortSessions(sessions)) {
      for (const s of mainSetsOf(session, exerciseId)) {
        const w = typedWeight(s);
        let g = groups.find((x) => sameWeight(x.w, w));
        if (!g) { g = { w, weightKg: s.weightKg == null ? null : s.weightKg, sets: 0, lastDate: session.date }; groups.push(g); }
        g.sets++;
        g.lastDate = session.date;
      }
    }
    return groups.sort((a, b) => b.w - a.w).map(({ weightKg, sets, lastDate }) => ({ weightKg, sets, lastDate }));
  }

  const PRs = {
    TOLERANCE_KG,
    BASELINE_SESSIONS,
    computeMilestones,
    milestonesForSet,
    computeAllMilestones,
    maxWeightSeries,
    repsAtWeightSeries,
    weightsUsed,
  };

  global.PRs = PRs;
  if (typeof module !== 'undefined' && module.exports) module.exports = PRs;
})(typeof window !== 'undefined' ? window : globalThis);
