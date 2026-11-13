// Turns detections into wheel speeds: search for the figure, drive to it, stop in front of it.
//
//   SEARCH   spin in place in short steps (spin, then pause so the camera image is sharp),
//            toward the side where the figure was last seen. Gives up after searchTimeoutMs.
//   APPROACH steer so the figure is centered; drive forward only when roughly centered and
//            slow down as the figure grows. Stops when the figure is stopSize of the frame high.
//   LOST     figure gone for lostGraceMs: stop, wait lostWaitMs, then SEARCH again.
//   ARRIVED  stopped in front of the figure. If the figure is moved away (looks clearly
//            smaller for rearmMs) it approaches again.
//   GAVE_UP  search timed out; stopped until restarted.
//
// Wheel speeds are percent, -100..100, + = forward. Positive turn = to the right.

export const State = {
  SEARCH: 'search',
  APPROACH: 'approach',
  LOST: 'lost',
  ARRIVED: 'arrived',
  GAVE_UP: 'gave_up',
};

export const DEFAULT_FOLLOW = {
  maxSpeed: 55, // forward speed far from the figure (%)
  turnSpeed: 40, // largest steering difference (%)
  searchSpeed: 40, // spin speed while searching (%)
  kTurn: 1.6, // steering gain on the horizontal offset (-1..1)
  turnDeadband: 0.06, // offset treated as centered
  alignBand: 0.45, // offset at which forward speed drops to zero (turn in place)
  stopSize: 0.6, // figure height / frame height at which the robot stops
  slowFrom: 0.3, // start slowing down at this size
  minFwd: 0.4, // slowest forward speed, as a fraction of maxSpeed
  smooth: 0.5, // detection smoothing (1 = none)
  confirmFrames: 3, // consecutive detections before approaching
  lostGraceMs: 400,
  lostWaitMs: 1200,
  searchSpinMs: 300,
  searchPauseMs: 500,
  searchTimeoutMs: 40000,
  rearmFrac: 0.7,
  rearmMs: 1500,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Forward + turn -> left/right, scaled down together so neither wheel exceeds 100.
export function mix(fwd, turn) {
  let left = fwd + turn;
  let right = fwd - turn;
  const m = Math.max(100, Math.abs(left), Math.abs(right));
  left = (left * 100) / m;
  right = (right * 100) / m;
  return { left: Math.round(left), right: Math.round(right) };
}

export class FollowController {
  constructor(params = {}) {
    this.p = { ...DEFAULT_FOLLOW, ...params };
    this.reset(0);
  }

  setParams(params) {
    Object.assign(this.p, params);
  }

  reset(t) {
    this.state = State.SEARCH;
    this.stateT = t;
    this.searchStartT = t;
    this.seen = 0;
    this.lastSeenT = -Infinity;
    this.lastSide = 1;
    this.ex = 0;
    this.size = 0;
    this.smallSinceT = null;
    this.last = { left: 0, right: 0 };
  }

  go(state, t) {
    this.state = state;
    this.stateT = t;
    if (state === State.SEARCH) this.searchStartT = t;
    this.smallSinceT = null;
  }

  // det: { found, cx (0..1), size (0..1) } ; t: ms. Returns { state, left, right }.
  update(det, t) {
    const p = this.p;
    if (det && det.found) {
      const ex = det.cx * 2 - 1;
      if (this.seen === 0) {
        this.ex = ex;
        this.size = det.size;
      } else {
        this.ex += p.smooth * (ex - this.ex);
        this.size += p.smooth * (det.size - this.size);
      }
      this.seen++;
      this.lastSeenT = t;
      if (Math.abs(this.ex) > 0.1) this.lastSide = Math.sign(this.ex);
    } else {
      this.seen = 0;
    }
    const found = this.seen > 0;
    const confirmed = this.seen >= p.confirmFrames;

    let cmd = { left: 0, right: 0 };
    switch (this.state) {
      case State.SEARCH: {
        if (confirmed) {
          this.go(State.APPROACH, t);
          cmd = this.drive();
          break;
        }
        if (t - this.searchStartT > p.searchTimeoutMs) {
          this.go(State.GAVE_UP, t);
          break;
        }
        if (found) break; // hold still so the next frames can confirm it
        const phase = (t - this.stateT) % (p.searchSpinMs + p.searchPauseMs);
        if (phase < p.searchSpinMs) cmd = mix(0, this.lastSide * p.searchSpeed);
        break;
      }
      case State.APPROACH: {
        if (!found) {
          if (t - this.lastSeenT > p.lostGraceMs) this.go(State.LOST, t);
          else cmd = this.last; // brief dropout: keep going
          break;
        }
        if (this.size >= p.stopSize) {
          this.go(State.ARRIVED, t);
          break;
        }
        cmd = this.drive();
        break;
      }
      case State.LOST: {
        if (confirmed) {
          this.go(State.APPROACH, t);
          cmd = this.drive();
        } else if (t - this.stateT > p.lostWaitMs) {
          this.go(State.SEARCH, t);
        }
        break;
      }
      case State.ARRIVED: {
        if (confirmed && this.size < p.stopSize * p.rearmFrac) {
          if (this.smallSinceT === null) this.smallSinceT = t;
          else if (t - this.smallSinceT > p.rearmMs) {
            this.go(State.APPROACH, t);
            cmd = this.drive();
          }
        } else {
          this.smallSinceT = null;
        }
        break;
      }
      default:
        break;
    }
    this.last = cmd;
    return { state: this.state, ...cmd };
  }

  drive() {
    const p = this.p;
    const off = Math.abs(this.ex) < p.turnDeadband ? 0 : this.ex;
    const turn = clamp(p.kTurn * off, -1, 1) * p.turnSpeed;
    const align = clamp(1 - Math.abs(this.ex) / p.alignBand, 0, 1);
    const far = clamp((p.stopSize - this.size) / Math.max(0.01, p.stopSize - p.slowFrom), 0, 1);
    const fwd = p.maxSpeed * align * (p.minFwd + (1 - p.minFwd) * far);
    return mix(fwd, turn);
  }
}

// Manual driving: joystick / keys (x = turn right, y = forward, both -1..1) -> wheels.
export function manualDrive(x, y, speed = 60) {
  const fwd = clamp(y, -1, 1) * speed;
  // Turning while driving backwards would feel mirrored; keep the joystick direction intuitive.
  const turn = clamp(x, -1, 1) * speed * 0.7 * (y < -0.2 ? -1 : 1);
  return mix(fwd, turn);
}
