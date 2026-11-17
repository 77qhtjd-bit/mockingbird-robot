// Turns detections into wheel speeds: look for people, greet the ones standing still, never chase
// the ones who are walking, and stay put while someone is using the screen.
//
//   SEARCH   spin in place in short steps (spin, then pause so the camera image is sharp).
//            After searchTimeoutMs with nobody in view it rests (REST) and then looks again.
//   WATCH    someone is in view: hold still and watch them for observeMs. The robot is not moving,
//            so any change in the figure's position or size is the person's own movement.
//              standing still -> APPROACH
//              walking        -> keep watching (never chase); if they come close -> GREET
//   APPROACH steer so the person is centered and drive up to them; stop when they fill stopSize
//            of the frame height -> GREET.
//   GREET    stopped in front of a person. The app speaks. Waits greetWaitMs for a touch.
//              touch    -> ENGAGED
//              no touch -> PASS
//   ENGAGED  someone is drawing / using the screen (ctx.interacting): never moves. From any state.
//            When they are done -> PASS.
//   PASS     turn away from the person, drive on a little, then SEARCH again. Meeting someone
//            close on the way stops the robot again (GREET).
//   LOST     the person being approached disappeared: stop, wait lostWaitMs, then SEARCH.
//   REST     nobody found for a while: stand still, look again after restMs or when someone appears.
//
// There is no distance sensor: "close" always means "the figure is tall in the camera image".
// Wheel speeds are percent, -100..100, + = forward. Positive turn = to the right.

export const State = {
  SEARCH: 'search',
  WATCH: 'watch',
  APPROACH: 'approach',
  GREET: 'greet',
  ENGAGED: 'engaged',
  PASS: 'pass',
  LOST: 'lost',
  REST: 'rest',
};

export const DEFAULT_FOLLOW = {
  maxSpeed: 55, // forward speed far from the person (%)
  turnSpeed: 40, // largest steering difference (%)
  searchSpeed: 40, // spin speed while searching and turning away (%)
  kTurn: 1.6, // steering gain on the horizontal offset (-1..1)
  turnDeadband: 0.06, // offset treated as centered
  alignBand: 0.45, // offset at which forward speed drops to zero (turn in place)
  // figure height / frame height at which the robot stops in front of a person. Above ~0.9 the
  // figure runs off the top and bottom of the image and the size stops growing.
  stopSize: 0.85,
  nearFrac: 0.75, // a person this fraction of stopSize tall is "close" (stop for walkers, no approach needed)
  slowFrom: 0.45, // start slowing down at this size
  minFwd: 0.4, // slowest forward speed, as a fraction of maxSpeed
  smooth: 0.5, // detection smoothing (1 = none)
  confirmFrames: 3, // consecutive detections before acting on a person
  lostGraceMs: 400,
  lostWaitMs: 1200,
  searchSpinMs: 300,
  searchPauseMs: 500,
  searchTimeoutMs: 40000,
  restMs: 15000,
  // Standing or walking? Judged only while the robot itself is still.
  settleMs: 300, // ignore frames right after the robot stops (motion blur)
  observeMs: 900, // how long a person must hold still before the robot approaches
  moveCx: 0.07, // sideways movement over observeMs (fraction of frame width) that counts as walking
  moveSize: 0.2, // relative size change over observeMs that counts as walking toward / away
  watchMaxMs: 8000, // a walker who never comes close: look elsewhere after this long
  ignoreMs: 2500, // ...and ignore detections this long so the search can turn away from them
  greetWaitMs: 6000, // wait this long for a touch after greeting
  passTurnMs: 900, // turn away from the person
  passDriveMs: 1200, // then drive on (0 = only turn away)
  passSpeedFrac: 0.7, // speed while driving on, as a fraction of maxSpeed
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const STOP = { left: 0, right: 0 };

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
    this.hist = []; // raw detections while the robot is still: { t, cx, size }
    this.stillSinceT = null;
    this.moving = null; // true = walking, false = standing, null = not known yet
    this.ignoreUntilT = -Infinity;
    this.passDir = 1;
    this.last = STOP;
  }

  go(state, t) {
    this.state = state;
    this.stateT = t;
    if (state === State.SEARCH) this.searchStartT = t;
  }

  // Standing or walking, from the detections collected while the robot was still.
  // null until there are enough of them.
  motion() {
    const h = this.hist;
    const p = this.p;
    if (h.length < 4 || h[h.length - 1].t - h[0].t < p.observeMs * 0.7) return null;
    let x0 = 1;
    let x1 = 0;
    let s0 = Infinity;
    let s1 = 0;
    for (const d of h) {
      x0 = Math.min(x0, d.cx);
      x1 = Math.max(x1, d.cx);
      s0 = Math.min(s0, d.size);
      s1 = Math.max(s1, d.size);
    }
    return x1 - x0 > p.moveCx || s1 / Math.max(s0, 1e-3) > 1 + p.moveSize;
  }

  startPass(t) {
    this.passDir = -this.lastSide; // turn away from the side the person is on
    this.go(State.PASS, t);
  }

  // det: { found, cx (0..1), size (0..1) } ; t: ms ; ctx.interacting: someone is using the screen.
  // Returns { state, left, right, event } — event is 'greet' or 'pass' on the frame it happens.
  update(det, t, ctx = {}) {
    const p = this.p;
    const hasDet = !!(det && det.found);
    if (hasDet) {
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
    const near = confirmed && this.size >= p.stopSize * p.nearFrac;

    // Movement can only be judged while the robot's own wheels are stopped.
    const wasStill = this.last.left === 0 && this.last.right === 0;
    if (!wasStill) {
      this.stillSinceT = null;
      this.hist.length = 0;
    } else if (this.stillSinceT === null) {
      this.stillSinceT = t;
    }
    if (hasDet && wasStill && t - this.stillSinceT >= p.settleMs) this.hist.push({ t, cx: det.cx, size: det.size });
    while (this.hist.length && t - this.hist[0].t > p.observeMs) this.hist.shift();
    this.moving = this.motion();

    let cmd = STOP;
    let event = null;
    const greet = () => {
      this.go(State.GREET, t);
      event = 'greet';
    };

    if (ctx.interacting && this.state !== State.ENGAGED) this.go(State.ENGAGED, t);

    switch (this.state) {
      case State.ENGAGED: {
        if (!ctx.interacting) {
          this.startPass(t);
          event = 'pass';
        }
        break;
      }
      case State.SEARCH: {
        if (found && t >= this.ignoreUntilT) {
          this.go(State.WATCH, t); // hold still: confirm it and see whether it moves
          break;
        }
        if (t - this.searchStartT > p.searchTimeoutMs) {
          this.go(State.REST, t);
          break;
        }
        const phase = (t - this.stateT) % (p.searchSpinMs + p.searchPauseMs);
        if (phase < p.searchSpinMs) cmd = mix(0, this.lastSide * p.searchSpeed);
        break;
      }
      case State.WATCH: {
        if (!found) {
          if (t - this.lastSeenT > p.lostGraceMs) this.go(State.SEARCH, t);
          break;
        }
        if (near) {
          greet(); // close enough already (a walker came up to the robot, or it was close from the start)
          break;
        }
        if (confirmed && this.moving === false) {
          this.go(State.APPROACH, t);
          cmd = this.drive();
          break;
        }
        if (t - this.stateT > p.watchMaxMs) {
          this.ignoreUntilT = t + p.ignoreMs;
          this.go(State.SEARCH, t);
        }
        break;
      }
      case State.APPROACH: {
        if (!found) {
          if (t - this.lastSeenT > p.lostGraceMs) this.go(State.LOST, t);
          else cmd = this.last; // brief dropout: keep going
          break;
        }
        if (this.size >= p.stopSize) {
          greet();
          break;
        }
        cmd = this.drive();
        break;
      }
      case State.GREET: {
        if (t - this.stateT > p.greetWaitMs) {
          this.startPass(t);
          event = 'pass';
        }
        break;
      }
      case State.PASS: {
        const dt = t - this.stateT;
        if (dt < p.passTurnMs) {
          cmd = mix(0, this.passDir * p.searchSpeed);
        } else if (dt < p.passTurnMs + p.passDriveMs) {
          if (near) {
            greet(); // someone is right in front: stop instead of driving into them
            break;
          }
          cmd = mix(p.maxSpeed * p.passSpeedFrac, 0);
        } else {
          this.lastSide = this.passDir; // keep searching away from the person just passed
          this.go(State.SEARCH, t);
        }
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
      case State.REST: {
        if (confirmed) this.go(State.WATCH, t);
        else if (t - this.stateT > p.restMs) this.go(State.SEARCH, t);
        break;
      }
      default:
        break;
    }
    this.last = cmd;
    return { state: this.state, left: cmd.left, right: cmd.right, event };
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
