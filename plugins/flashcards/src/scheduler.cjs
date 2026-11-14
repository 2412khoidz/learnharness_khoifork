'use strict';

// Selectively adapted from ts-fsrs 5.2.3 (FSRS-6), MIT, Open Spaced Repetition.
// See ../FSRS-LICENSE.txt. No Date prototype extensions or runtime dependencies.
const W = Object.freeze([
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194,
  0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629,
  1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
]);
const WEIGHT_BOUNDS = Object.freeze([
  [0.01, 50], [0.01, 50], [0.01, 50], [0.01, 50],
  [1, 10], [0.01, 5], [0.01, 8], [0, 0.75],
  [0, 4], [0, 0.8], [0.01, 3.5], [0.01, 5],
  [0.01, 0.5], [0.01, 1], [0, 5], [0, 1],
  [1, 6], [0, 2], [0, 2], [0, 0.8], [0.1, 0.8],
]);
const MIN_OPTIMIZER_REVIEWS = 30;
const MINUTE = 60000;
const DAY = 86400000;
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const round8 = (v) => +v.toFixed(8);
const DECAY = -W[20];
const FACTOR = round8(Math.exp(Math.pow(DECAY, -1) * Math.log(0.9)) - 1);

function isValidWeights(weights) {
  return Array.isArray(weights) && weights.length === 21 && weights.every((n, i) => {
    const [min, max] = WEIGHT_BOUNDS[i];
    return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
  });
}

function resolveWeights(settings) {
  return isValidWeights(settings?.weights) ? settings.weights : W;
}

function decayFactor(w) {
  if (w === W) return { decay: DECAY, factor: FACTOR };
  const decay = -w[20];
  const factor = round8(Math.exp(Math.pow(decay, -1) * Math.log(0.9)) - 1);
  return { decay, factor };
}

function timestamp(now) {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) {
    throw new RangeError('Expected a finite epoch-millisecond timestamp');
  }
  return now;
}

function dayBounds(now, startHour = 4) {
  timestamp(now);
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
    throw new RangeError('dayStart must be an integer from 0 to 23');
  }
  const start = new Date(now);
  start.setHours(startHour, 0, 0, 0);
  if (+start > now) {
    start.setDate(start.getDate() - 1);
    start.setHours(startHour, 0, 0, 0);
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  end.setHours(startHour, 0, 0, 0);
  return { start: +start, end: +end };
}

function studyDay(now, startHour = 4) {
  const date = new Date(dayBounds(now, startHour).start);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function ordinal(now, startHour) {
  const date = new Date(dayBounds(now, startHour).start);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
}

function reviewDue(now, days, dayStart) {
  const date = new Date(dayBounds(now, dayStart).start);
  date.setDate(date.getDate() + days);
  // Restore the requested rollover even if the starting date crossed a DST gap.
  date.setHours(dayStart, 0, 0, 0);
  return +date;
}

function settingsFor(settings) {
  const retention = settings.retention ?? 0.9;
  if (!Number.isFinite(retention) || retention <= 0 || retention > 1) {
    throw new RangeError('retention must be in (0, 1]');
  }
  const learningSteps = settings.learningSteps ?? [1, 10];
  const relearningSteps = settings.relearningSteps ?? [10];
  for (const steps of [learningSteps, relearningSteps]) {
    if (!Array.isArray(steps) || steps.some((step) => !Number.isFinite(step) || step <= 0)) {
      throw new RangeError('Learning steps must be arrays of positive minutes');
    }
  }
  const dayStart = settings.dayStart ?? 4;
  dayBounds(0, dayStart);
  const w = resolveWeights(settings);
  const { decay, factor } = decayFactor(w);
  return {
    learningSteps, relearningSteps, dayStart,
    w, decay, factor,
    fuzz: Boolean(settings.fuzz),
    modifier: round8((Math.pow(retention, 1 / decay) - 1) / factor),
  };
}

function createSchedule(now = Date.now()) {
  return {
    due: timestamp(now), stability: 0, difficulty: 0, elapsed_days: 0,
    scheduled_days: 0, reps: 0, lapses: 0, learning_steps: 0,
    state: 0, last_review: null,
  };
}

function initDifficulty(rating, w = W) {
  return round8(w[4] - Math.exp((rating - 1) * w[5]) + 1);
}

function nextDifficulty(difficulty, rating, w = W) {
  const delta = round8(-w[6] * (rating - 3) * (10 - difficulty) / 9);
  return clamp(round8(w[7] * initDifficulty(4, w) + (1 - w[7]) * (difficulty + delta)), 1, 10);
}

function shortStability(stability, rating, w = W) {
  const increase = Math.pow(stability, -w[19]) * Math.exp(w[17] * (rating - 3 + w[18]));
  return round8(clamp(stability * (rating >= 3 ? Math.max(increase, 1) : increase), 0.001, 36500));
}

function reviewStability(schedule, rating, elapsed, w = W) {
  const { difficulty: d, stability: s } = schedule;
  const { decay, factor } = decayFactor(w);
  const r = round8(Math.pow(1 + factor * elapsed / s, decay));
  if (rating === 1) {
    const forgotten = round8(clamp(w[11] * Math.pow(d, -w[12]) *
      (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]), 0.001, 36500));
    return clamp(round8(s / Math.exp(w[17] * w[18])), 0.001, forgotten);
  }
  const hard = rating === 2 ? w[15] : 1;
  const easy = rating === 4 ? w[16] : 1;
  return round8(clamp(s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) *
    (Math.exp((1 - r) * w[10]) - 1) * hard * easy), 0.001, 36500));
}

function interval(stability, settings) {
  return clamp(Math.round(stability * settings.modifier), 1, 36500);
}

function hashSeed(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function applyFuzz(days, schedule, now, options, rating = 0) {
  if (!options.fuzz || days < 3) return days;
  const delta = Math.max(1, Math.round(days * 0.05));
  const u = hashSeed(`${schedule?.last_review ?? ''}:${now}:${schedule?.reps ?? 0}:${schedule?.lapses ?? 0}:${rating}`);
  return clamp(Math.round(days + (u * 2 - 1) * delta), 1, 36500);
}

/** Live continuous retrievability R(t) in [0, 1] at timestamp `now`. */
function retrievability(schedule, now = Date.now(), settings = {}) {
  timestamp(now);
  if (!schedule || schedule.state === 0 || schedule.last_review == null || !schedule.stability || schedule.stability <= 0) {
    return 0;
  }
  const w = resolveWeights(settings);
  const { decay, factor } = decayFactor(w);
  const elapsedDays = Math.max(0, (now - schedule.last_review) / DAY);
  return clamp(round8(Math.pow(1 + factor * elapsedDays / schedule.stability, decay)), 0, 1);
}

// Reference BasicLearningStepsStrategy, using numeric minutes rather than strings.
function learningInfo(schedule, rating, settings) {
  const steps = schedule.state === 2 || schedule.state === 3
    ? settings.relearningSteps : settings.learningSteps;
  let step = schedule.learning_steps || 0;
  if (schedule.state === 1 && rating >= 3) step += 1;
  if (steps.length === 0 || step >= steps.length) return { minutes: 0, step: 0 };
  if (schedule.state === 2) return { minutes: steps[step], step: 0 };
  if (rating === 1) return { minutes: steps[0], step: 0 };
  if (rating === 2) {
    return { minutes: Math.round(steps.length === 1 ? steps[0] * 1.5 : (steps[0] + steps[1]) / 2), step };
  }
  if (rating === 3 && steps[step + 1]) return { minutes: Math.round(steps[step + 1]), step: step + 1 };
  return { minutes: 0, step: 0 };
}

function applySteps(next, previous, rating, now, settings) {
  const { minutes, step } = learningInfo(previous, rating, settings);
  if (minutes > 0) {
    next.learning_steps = step;
    next.scheduled_days = Math.floor(minutes / 1440);
    next.state = minutes < 1440 ? (previous.state === 2 ? 3 : previous.state || 1) : 2;
    next.due = now + Math.round(minutes) * MINUTE;
  } else {
    next.learning_steps = 0;
    next.state = 2;
    next.scheduled_days = applyFuzz(interval(next.stability, settings), previous, now, settings, rating);
    next.due = reviewDue(now, next.scheduled_days, settings.dayStart);
  }
}

function rate(schedule, rating, now = Date.now(), settings = {}) {
  timestamp(now);
  if (!Number.isInteger(rating) || rating < 1 || rating > 4) throw new RangeError('rating must be 1–4');
  if (!schedule || !Number.isInteger(schedule.state) || schedule.state < 0 || schedule.state > 3) {
    throw new RangeError('Invalid schedule state');
  }
  const options = settingsFor(settings);
  const w = options.w;
  const steps = schedule.state === 2 || schedule.state === 3
    ? options.relearningSteps : options.learningSteps;
  if (steps.length && schedule.learning_steps >= steps.length) {
    // Settings edits take effect when graded, never by moving an outstanding due.
    schedule = { ...schedule, learning_steps: steps.length - 1 };
  }
  const elapsed = schedule.state === 0 || schedule.last_review == null ? 0 :
    Math.max(0, ordinal(now, options.dayStart) - ordinal(schedule.last_review, options.dayStart));
  const next = { ...schedule, elapsed_days: elapsed, reps: schedule.reps + 1, last_review: now };
  if (schedule.state === 0) {
    next.stability = Math.max(w[rating - 1], 0.1);
    next.difficulty = clamp(initDifficulty(rating, w), 1, 10);
  } else {
    next.difficulty = nextDifficulty(schedule.difficulty, rating, w);
    next.stability = schedule.state === 2
      ? reviewStability(schedule, rating, elapsed, w) : shortStability(schedule.stability, rating, w);
  }
  if (schedule.state !== 2 || rating === 1) {
    if (schedule.state === 2) next.lapses += 1;
    applySteps(next, schedule, rating, now, options);
  } else {
    // Compute all passing intervals together to preserve the reference ordering.
    const rawHard = interval(reviewStability(schedule, 2, elapsed, w), options);
    const rawGood = interval(reviewStability(schedule, 3, elapsed, w), options);
    const rawEasy = interval(reviewStability(schedule, 4, elapsed, w), options);
    const hard = applyFuzz(Math.min(rawHard, rawGood), schedule, now, options, 2);
    const good = Math.max(applyFuzz(rawGood, schedule, now, options, 3), hard + 1);
    const easy = Math.max(applyFuzz(rawEasy, schedule, now, options, 4), good + 1);
    next.scheduled_days = { 2: hard, 3: good, 4: easy }[rating];
    next.state = 2;
    next.learning_steps = 0;
    next.due = reviewDue(now, next.scheduled_days, options.dayStart);
  }
  if (next.state === 2) next.dueDay = studyDay(next.due, options.dayStart);
  else delete next.dueDay;
  return next;
}

function preview(schedule, now = Date.now(), settings = {}) {
  return Object.fromEntries([1, 2, 3, 4].map((rating) => [rating, rate(schedule, rating, now, settings)]));
}

function buildTrainingTrajectories(reviews) {
  const byProp = new Map();
  for (const r of reviews ?? []) {
    if (!r || typeof r.propositionId !== 'string' || !Number.isFinite(r.at) || ![1, 2, 3, 4].includes(r.rating)) continue;
    let list = byProp.get(r.propositionId);
    if (!list) { list = []; byProp.set(r.propositionId, list); }
    list.push({ rating: r.rating, at: r.at });
  }
  const trajectories = [];
  let longTermCount = 0;
  for (const list of byProp.values()) {
    list.sort((a, b) => a.at - b.at);
    if (list.length < 2) continue;
    trajectories.push(list);
    for (let i = 1; i < list.length; i++) {
      if ((list[i].at - list[i - 1].at) / DAY >= 0.5) longTermCount++;
    }
  }
  return { trajectories, longTermCount };
}

function evaluateObjective(w, trajectories, regLambda = 0.015) {
  const { decay, factor } = decayFactor(w);
  let bceSum = 0;
  let count = 0;
  for (const list of trajectories) {
    let s = Math.max(w[list[0].rating - 1], 0.1);
    let d = clamp(initDifficulty(list[0].rating, w), 1, 10);
    let lastAt = list[0].at;
    for (let i = 1; i < list.length; i++) {
      const item = list[i];
      const dt = Math.max(0, (item.at - lastAt) / DAY);
      if (dt >= 0.5) {
        const pred = clamp(Math.pow(1 + factor * dt / s, decay), 1e-6, 1 - 1e-6);
        const y = item.rating > 1 ? 1 : 0;
        bceSum += -(y * Math.log(pred) + (1 - y) * Math.log(1 - pred));
        count++;
        s = reviewStability({ difficulty: d, stability: s }, item.rating, dt, w);
      } else {
        s = shortStability(s, item.rating, w);
      }
      d = nextDifficulty(d, item.rating, w);
      lastAt = item.at;
    }
  }
  const meanBce = count > 0 ? bceSum / count : 0;
  let penalty = 0;
  for (let i = 0; i < 21; i++) {
    const scale = Math.max(Math.abs(W[i]), 0.1);
    const diff = (w[i] - W[i]) / scale;
    penalty += diff * diff;
  }
  return { meanBce, totalLoss: meanBce + regLambda * (penalty / 21), count };
}

/**
 * Pure-JS FSRS-6 personal parameter optimizer trained on a user's chronological
 * review history using bounded coordinate search with L2 shrinkage toward default W.
 */
function optimizeParameters(reviews, options = {}) {
  const minRequired = Number.isInteger(options.minRequired) && options.minRequired >= 1
    ? options.minRequired
    : MIN_OPTIMIZER_REVIEWS;
  const reviewCount = Array.isArray(reviews) ? reviews.length : 0;
  const { trajectories, longTermCount } = buildTrainingTrajectories(reviews);
  const startWeights = isValidWeights(options.initialWeights) ? [...options.initialWeights] : [...W];

  if (reviewCount < minRequired || longTermCount < 10) {
    return {
      ok: false,
      reviewCount,
      minRequired,
      evaluatedTransitions: longTermCount,
      weights: [...W],
      defaultWeights: [...W],
      lossBefore: 0,
      lossAfter: 0,
      improvementPct: 0,
    };
  }

  const baseEval = evaluateObjective(W, trajectories);
  let best = [...startWeights];
  let bestEval = evaluateObjective(best, trajectories);
  if (baseEval.totalLoss <= bestEval.totalLoss) {
    best = [...W];
    bestEval = baseEval;
  }

  const stepRatios = [0.35, 0.14, 0.05, 0.015];
  // Prioritize weights that most strongly drive stability/difficulty/forgetting curve.
  const activeIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15, 16, 20];

  for (const ratio of stepRatios) {
    let improved = true;
    let passes = 0;
    while (improved && passes < 4) {
      improved = false;
      passes++;
      for (const idx of activeIndices) {
        const [minB, maxB] = WEIGHT_BOUNDS[idx];
        const mag = Math.max(Math.abs(best[idx]), Math.abs(W[idx]), 0.05);
        const delta = mag * ratio;
        for (const dir of [-1, 1]) {
          const candidateVal = clamp(best[idx] + dir * delta, minB, maxB);
          if (Math.abs(candidateVal - best[idx]) < 1e-7) continue;
          const prev = best[idx];
          best[idx] = candidateVal;
          const candEval = evaluateObjective(best, trajectories);
          if (candEval.totalLoss + 1e-9 < bestEval.totalLoss) {
            bestEval = candEval;
            improved = true;
          } else {
            best[idx] = prev;
          }
        }
      }
    }
  }

  const rounded = best.map((v, i) => {
    const [minB, maxB] = WEIGHT_BOUNDS[i];
    return clamp(Number(v.toFixed(4)), minB, maxB);
  });
  const finalEval = evaluateObjective(rounded, trajectories);
  if (finalEval.meanBce >= baseEval.meanBce) {
    return {
      ok: true,
      reviewCount,
      minRequired,
      evaluatedTransitions: longTermCount,
      weights: [...W],
      defaultWeights: [...W],
      lossBefore: +baseEval.meanBce.toFixed(6),
      lossAfter: +baseEval.meanBce.toFixed(6),
      improvementPct: 0,
    };
  }

  const improvementPct = baseEval.meanBce > 0
    ? +(((baseEval.meanBce - finalEval.meanBce) / baseEval.meanBce) * 100).toFixed(2)
    : 0;

  return {
    ok: true,
    reviewCount,
    minRequired,
    evaluatedTransitions: longTermCount,
    weights: rounded,
    defaultWeights: [...W],
    lossBefore: +baseEval.meanBce.toFixed(6),
    lossAfter: +finalEval.meanBce.toFixed(6),
    improvementPct,
  };
}

function chooseCue(cues, random = Math.random) {
  if (!cues.length) return null;
  const weight = (cue) => ({ 1: 4, 2: 3, 3: 2, 4: 1 }[cue.latestRating] ?? 3);
  const total = cues.reduce((sum, cue) => sum + weight(cue), 0);
  let target = random() * total;
  for (const cue of cues) {
    target -= weight(cue);
    if (target < 0) return cue;
  }
  return cues[cues.length - 1];
}

function isDue(schedule, now = Date.now(), startHour = 4) {
  const today = studyDay(now, startHour);
  // Logical review dates survive timezone and rollover-setting changes. Older
  // schedules without dueDay retain their original epoch cutoff until graded.
  if (schedule.state === 2 && schedule.dueDay) return today >= schedule.dueDay;
  return schedule.due <= now;
}

module.exports = {
  W,
  WEIGHT_BOUNDS,
  MIN_OPTIMIZER_REVIEWS,
  isValidWeights,
  createSchedule,
  rate,
  preview,
  retrievability,
  optimizeParameters,
  chooseCue,
  studyDay,
  dayBounds,
  isDue,
};
