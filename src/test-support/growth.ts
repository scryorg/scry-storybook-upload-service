// Copied from scryorg/scry-build-processing-service#84 (src/test-support/growth.ts, e15c4d2; F147/F156/F158/F161/F175). Keep in sync.
/**
 * Test helper: how much does a function's cost grow when its input grows? Used to assert
 * "linear, and bounded by a cap" without any absolute-millisecond bound (ledger F147: those fail on
 * slow shared runners and on a loaded box).
 *
 * Two things make the ratio trustworthy under load (ledger F158: with plain wall-clock samples a
 * linear scrubber read up to 20x on an 8x input at box load ~150, against a bound of 24):
 *  - CPU time (process.cpuUsage), not wall-clock time. A preempted process stops accruing CPU time,
 *    so a busy runner cannot inflate one side of the ratio. Heavy inputs (8 ms+ per call) are the
 *    ones that get preempted, which is why wall-clock inflated the BIG side only.
 *  - Many interleaved samples, minimum kept per size, and up to MAX_ATTEMPTS re-measurements: a real
 *    superlinear function fails every attempt, a noisy spike does not repeat three times.
 * Measured on this box at load ~155 (70 scrub cases, 6 runs): linear max 9.6x on an 8x input
 * (expected 8), weak quadratic (n^2/64 work) up to 26x, strong quadratic (n^2/8) up to 62x.
 */

const SAMPLES = 12;
const BATCH_TARGET_MS = 4;
const MAX_REPS = 1 << 14;
const MAX_ATTEMPTS = 3;

/**
 * CPU milliseconds of this process (user + system), never wall-clock. process.cpuUsage() (getrusage
 * RUSAGE_SELF) advances in microseconds; process.threadCpuUsage() was measured to advance in coarse
 * steps (~250 us, and often not at all across a 4 ms batch), which made cheap cases read 0.
 */
function cpuMs(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

interface Plan {
  run: () => void;
  reps: number;
  best: number;
}

/**
 * Picks how many calls make one sample. The batch size is calibrated on wall time (it is only a size,
 * nothing is asserted on it) so every sample covers >= BATCH_TARGET_MS and the CPU clock's granularity
 * cannot dominate a cheap call (a 5 microsecond call would otherwise read as 0).
 */
function plan(fn: () => unknown): Plan {
  let reps = 1;
  for (;;) {
    const t0 = performance.now();
    for (let i = 0; i < reps; i++) fn();
    if (performance.now() - t0 >= BATCH_TARGET_MS || reps >= MAX_REPS) break;
    reps *= 2;
  }
  return { run: () => void fn(), reps, best: Number.POSITIVE_INFINITY };
}

function sample(p: Plan): void {
  const t = cpuMs();
  for (let i = 0; i < p.reps; i++) p.run();
  const perCall = (cpuMs() - t) / p.reps;
  if (perCall > 0) p.best = Math.min(p.best, perCall); // 0: the clock did not tick, which is no information
}

function measureOnce(fn: (input: string) => unknown, small: string, big: string): number {
  const a = plan(() => fn(small));
  const b = plan(() => fn(big));
  for (let s = 0; s < SAMPLES; s++) {
    sample(a);
    sample(b);
  }
  // no sample ever read above 0: the clock never ticked, so there is nothing to compare
  return Number.isFinite(a.best) && Number.isFinite(b.best) ? b.best / a.best : Number.NaN;
}

/**
 * cost(big input) / cost(small input), where both inputs come from `make(size)`. Returns the lowest
 * ratio seen over up to MAX_ATTEMPTS measurements, stopping early once one is below `bound`.
 * Linear cost reads about big/small; quadratic about (big/small)^2. Infinity (the clock never
 * ticked) never passes `toBeLessThan`, so an unmeasurable case fails loudly instead of silently passing.
 */
export function growth(fn: (input: string) => unknown, make: (size: number) => string, small: number, big: number, bound: number): number {
  const a = make(small);
  const b = make(big);
  fn(a); // warm up: JIT and regex compilation are not part of the cost being compared
  fn(b);
  let lowest = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && lowest >= bound; attempt++) {
    const ratio = measureOnce(fn, a, b);
    if (!Number.isNaN(ratio)) lowest = Math.min(lowest, ratio);
  }
  return lowest;
}
