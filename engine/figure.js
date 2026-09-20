// LDOC — hand-drawn articulated figures
//
// Draws a simple human figure and animates it procedurally: a skeleton is posed
// from an angle formula, and the posed skeleton is drawn with RoughJS.
//
// WHY FRAME-BY-FRAME RATHER THAN LIVE REPOSING:
// RoughJS generates a fixed jittered path per call, so re-posing a figure every
// frame would mean re-running that generation 60x/second — expensive, and the
// jitter would shimmer distractingly. Instead every pose in a cycle is generated
// ONCE up front and playback just swaps which frame is visible.
//
// That is also how real hand-drawn animation works: each frame is redrawn, which
// is precisely why the lines wobble slightly between frames. Giving each frame its
// own RoughJS seed reproduces that "line boil" for free rather than faking it.
//
// Playback runs at ~11fps rather than 60. Traditional animation is drawn "on twos"
// (12fps) and reading as hand-made depends on it — a perfectly smooth 60fps figure
// looks computed, not drawn.

const FPS = 11;

// Words that mean "this actor is a person". Deliberately excludes "client", which
// in a networking diagram means a browser, not a human.
const PERSON_HINT = /\b(user|person|people|customer|student|visitor|reader|human|employee|teacher|doctor|alice|bob|carol|dave|eve)\b/i;

export function looksLikePerson(text) {
  return PERSON_HINT.test(text || '');
}

// Positions of every joint for one moment of a cycle.
//
// The figure's origin is between the feet, and it extends upward (negative y),
// so it can be dropped at a ground position without offset maths at the call site.
//
//   phase — 0..2π position within the cycle
//   mode  — 'walk' | 'idle' | 'point'
function poseSkeleton(height, phase, mode) {
  const h = height;

  const thighLen = h * 0.24;
  const shinLen  = h * 0.21;
  const upperArm = h * 0.19;
  const foreArm  = h * 0.17;

  const hipY      = -h * 0.45;
  const shoulderY = -h * 0.78;
  const headR     = h * 0.09;

  // Walking bobs the body twice per stride (once per footfall); idle breathes once.
  const bob = mode === 'walk'
    ? Math.abs(Math.sin(phase)) * h * 0.018
    : Math.sin(phase) * h * 0.012;

  const hip      = [0, hipY + bob];
  const shoulder = [0, shoulderY + bob];
  const head     = [0, shoulderY - headR - h * 0.04 + bob, headR];

  const legs = [];
  const arms = [];

  for (let side = 0; side < 2; side++) {
    const offset = side * Math.PI; // legs are half a cycle apart

    let thighA, kneeBend, armA;
    if (mode === 'walk') {
      thighA   = Math.sin(phase + offset) * 0.52;
      kneeBend = Math.max(0, Math.sin(phase + offset + Math.PI * 0.35)) * 0.6;
      armA     = -Math.sin(phase + offset) * 0.42; // arms counter-swing the legs
    } else if (mode === 'point') {
      thighA   = side === 0 ? 0.06 : -0.06;
      kneeBend = 0.05;
      // One arm comes up and out; the other rests.
      armA     = side === 0 ? -2.1 : 0.18;
    } else {
      thighA   = side === 0 ? 0.05 : -0.05;
      kneeBend = 0.04;
      armA     = (side === 0 ? -0.18 : 0.18) + Math.sin(phase) * 0.04;
    }

    // Angles are measured from straight-down, so cos drives y and sin drives x.
    const knee = [
      hip[0] + Math.sin(thighA) * thighLen,
      hip[1] + Math.cos(thighA) * thighLen,
    ];
    const shinA = thighA - kneeBend;
    const foot = [
      knee[0] + Math.sin(shinA) * shinLen,
      knee[1] + Math.cos(shinA) * shinLen,
    ];
    legs.push([hip, knee, foot]);

    const elbow = [
      shoulder[0] + Math.sin(armA) * upperArm,
      shoulder[1] + Math.cos(armA) * upperArm,
    ];
    const foreA = armA + (mode === 'point' && side === 0 ? -0.35 : 0.28);
    const hand = [
      elbow[0] + Math.sin(foreA) * foreArm,
      elbow[1] + Math.cos(foreA) * foreArm,
    ];
    arms.push([shoulder, elbow, hand]);
  }

  return { head, spine: [shoulder, hip], legs, arms };
}

function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h) % 2147483647 || 1;
}

// Draws one posed skeleton as a RoughJS group.
function drawPose(rc, skeleton, seed, ink, strokeWidth) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const opts = { stroke: ink, strokeWidth, roughness: 1.15, bowing: 1.4, seed };

  const [hx, hy, hr] = skeleton.head;
  g.appendChild(rc.circle(hx, hy, hr * 2, opts));
  g.appendChild(rc.line(
    skeleton.spine[0][0], skeleton.spine[0][1],
    skeleton.spine[1][0], skeleton.spine[1][1], opts
  ));
  for (const limb of [...skeleton.arms, ...skeleton.legs]) {
    g.appendChild(rc.linearPath(limb, opts));
  }
  return g;
}

/**
 * Builds an animated figure and appends it to `parent`.
 *
 * Every frame of every mode is generated up front and hidden; playback only
 * toggles visibility, so it costs nothing per frame.
 *
 * Returns { element, play(mode), stop() }.
 */
export function createFigure(rc, parent, { id = 'figure', x = 0, y = 0, height = 96, ink = '#1e1e1e', strokeWidth = 1.6 } = {}) {
  const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  root.setAttribute('transform', `translate(${x} ${y})`);
  parent.appendChild(root);

  // Walk needs a full stride; idle only breathes, so fewer frames read fine and
  // keep the boil from becoming a distracting flicker.
  const cycles = {
    walk:  { frames: 8, loop: true },
    idle:  { frames: 4, loop: true },
    point: { frames: 3, loop: true },
  };

  const built = {};
  for (const [mode, { frames }] of Object.entries(cycles)) {
    built[mode] = [];
    for (let f = 0; f < frames; f++) {
      const phase = (f / frames) * Math.PI * 2;
      const skeleton = poseSkeleton(height, phase, mode);
      // A distinct seed per frame is what produces the natural line boil.
      const g = drawPose(rc, skeleton, hashSeed(`${id}:${mode}:${f}`), ink, strokeWidth);
      g.style.display = 'none';
      root.appendChild(g);
      built[mode].push(g);
    }
  }

  let currentMode = null;
  let frameIndex = 0;
  let rafId = null;
  let lastAdvance = 0;

  function showFrame(mode, index) {
    for (const m of Object.keys(built)) {
      built[m].forEach((g, i) => {
        g.style.display = (m === mode && i === index) ? '' : 'none';
      });
    }
  }

  function tick(now) {
    if (!currentMode) return;
    if (now - lastAdvance >= 1000 / FPS) {
      lastAdvance = now;
      frameIndex = (frameIndex + 1) % built[currentMode].length;
      showFrame(currentMode, frameIndex);
    }
    rafId = requestAnimationFrame(tick);
  }

  function play(mode = 'idle') {
    if (!built[mode]) mode = 'idle';
    currentMode = mode;
    frameIndex = 0;
    showFrame(mode, 0);
    if (rafId === null) {
      lastAdvance = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  }

  function stop() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    currentMode = null;
  }

  play('idle');

  return { element: root, play, stop };
}
