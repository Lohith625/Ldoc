// LDOC 2D Renderer
// Takes parsed animation block and renders it as a beautiful 2D SVG animation.
// Handles network:flow style — actors in a row, packets flying between them.
//
// Node boxes are drawn with RoughJS (https://roughjs.com) for a hand-drawn/sketchy
// look instead of geometrically perfect shapes — deterministic, small, algorithmic
// jitter within controlled bounds (not an ML model), fits the same "compiled not
// generated" architecture as the rest of the renderer.
// Vendored locally (not loaded from a CDN) because VS Code webviews block external
// resource loads under CSP — the extension serves this file via asWebviewUri instead.
import rough from './vendor/rough.esm.js';
import { createFigure, looksLikePerson } from './figure.js';
import { createObject, detectObject } from './objects.js';

// Excalidraw-style theme: dark charcoal strokes on every shape (not colored per
// type), color used only as a light hachure fill tint. White background, thin
// clean strokes, subtle roughness — matching RoughJS's own reference examples
// rather than the earlier heavy/colorful sketch look.
const INK = '#1e1e1e'; // Excalidraw's default stroke color is a near-black charcoal, not pure #000

// Fixed canvas every template lays out against. The rendered <svg> scales this to
// whatever space it's given (see makeResponsiveSvg), so the drawing fills and
// centres itself at any panel width.
//
// Deliberately NOT measured from the container. Measuring meant the layout depended
// on how wide the panel happened to be at the moment of rendering — the same
// document could lay out differently between two runs, which quietly broke the
// same-input-same-output guarantee the rest of the renderer is built on.
const DESIGN_W = 760;
const DESIGN_H = 440;

const COLORS = {
  send:      { fillTint: '#a78bfa', text: INK },  // violet tint
  reply:     { fillTint: '#f472b6', text: INK },  // rose tint
  connect:   { fillTint: '#2dd4bf', text: INK },  // teal tint
  state:     { fillTint: '#4ade80' },                // green tint
  highlight: { fillTint: '#fbbf24' },                // amber tint
  node: {
    client:  { fillTint: '#a78bfa' },
    server:  { fillTint: '#2dd4bf' },
    network: { fillTint: '#fb923c' },
    node:    { fillTint: '#60a5fa' },
  }
};

// Standard Penner-style easing curves. Names follow the in/out/inOut convention:
// "in"    = slow start, accelerates (good for things leaving/exiting)
// "out"   = fast start, decelerates into place (good for things arriving/settling — most natural default)
// "inOut" = slow-fast-slow (good for continuous motion between two states)
const ease = {
  linear:     t => t,

  inSine:     t => 1 - Math.cos((t * Math.PI) / 2),
  outSine:    t => Math.sin((t * Math.PI) / 2),
  inOutSine:  t => -(Math.cos(Math.PI * t) - 1) / 2,

  inQuad:     t => t * t,
  outQuad:    t => 1 - (1 - t) * (1 - t),
  inOutQuad:  t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2,

  inCubic:    t => t * t * t,
  outCubic:   t => 1 - Math.pow(1 - t, 3),
  inOutCubic: t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,

  inQuart:    t => t * t * t * t,
  outQuart:   t => 1 - Math.pow(1 - t, 4),
  inOutQuart: t => t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2,

  // "Back" curves overshoot slightly past the target before settling — reads as
  // snappy/characterful rather than mechanical. c controls how much overshoot.
  inBack:     t => { const c1 = 1.70158, c3 = c1 + 1; return c3 * t * t * t - c1 * t * t; },
  outBack:    t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  inOutBack:  t => {
    const c1 = 1.70158, c2 = c1 * 1.525;
    return t < 0.5
      ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
      : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
  },

  // "Elastic" curves spring past the target and wobble before settling — good for
  // small, attention-grabbing pops (a node appearing), overkill for large/frequent motion.
  outElastic: t => {
    const c4 = (2 * Math.PI) / 3;
    return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },

  // "Expo" — very slow start / very sharp finish (or reverse). Good for dramatic reveals.
  outExpo:    t => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
  inExpo:     t => t === 0 ? 0 : Math.pow(2, 10 * t - 10),
};

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function tweenP(dur, fn, cb) {
  return new Promise(r => {
    const s = performance.now();
    function tick(n) {
      const t = clamp((n - s) / dur, 0, 1);
      cb(fn(t), t);
      t < 1 ? requestAnimationFrame(tick) : r();
    }
    requestAnimationFrame(tick);
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

// "Self-drawing" line/shape reveal: any stroked SVG element (path, rect, line, circle)
// can be made to look hand-drawn by setting stroke-dasharray to its own total length
// (one giant dash exactly as long as the shape) and animating stroke-dashoffset from
// that length down to 0 — the dash appears to "slide into view" from the start point,
// reading as the shape being traced. This is a real, deterministic SVG technique
// (not a canned CSS "animation"), same idea used for whiteboard-style hand-drawn reveals.
async function drawStroke(el, dur, easeFn = ease.outQuad) {
  const len = el.getTotalLength ? el.getTotalLength() : estimatePerimeter(el);
  el.setAttribute('stroke-dasharray', len);
  el.setAttribute('stroke-dashoffset', len);
  el.setAttribute('stroke-opacity', 1);
  await tweenP(dur, easeFn, v => {
    el.setAttribute('stroke-dashoffset', len * (1 - v));
  });
}

// Self-drawing reveal for a RoughJS shape. A RoughJS shape is a <g> of several
// jittery sub-paths, so it can't be dash-animated as one element — but each child
// path individually CAN be, and animating them together reads as the shape being
// sketched. This is what makes a rough box look genuinely hand-drawn in motion,
// not just faded in.
async function drawRoughStroke(roughGroup, dur, easeFn = ease.outQuad) {
  const paths = Array.from(roughGroup.querySelectorAll('path'));
  const lengths = paths.map(p => {
    const len = p.getTotalLength();
    p.setAttribute('stroke-dasharray', len);
    p.setAttribute('stroke-dashoffset', len);
    return len;
  });
  roughGroup.style.opacity = 1;

  await tweenP(dur, easeFn, v => {
    paths.forEach((p, idx) => {
      p.setAttribute('stroke-dashoffset', lengths[idx] * (1 - v));
    });
  });
}

// A 2D "camera". SVG has no camera, so we get one by putting the whole scene in a
// <g> and animating its transform: scaling up = pushing in, translating = panning.
// UI chrome (narration) is deliberately kept OUTSIDE this group so it stays put
// instead of zooming away with the scene.
//
// The transform reads right-to-left: move the world so the point we're looking at
// sits at the origin, scale around that, then shift to the centre of the canvas.
function makeCamera(worldGroup, W, H) {
  const state = { x: W / 2, y: H / 2, zoom: 1 };

  function apply() {
    worldGroup.setAttribute(
      'transform',
      `translate(${W / 2} ${H / 2}) scale(${state.zoom}) translate(${-state.x} ${-state.y})`
    );
  }

  async function moveTo(x, y, zoom, dur, easeFn = ease.inOutCubic) {
    const from = { ...state };
    await tweenP(dur, easeFn, v => {
      state.x = lerp(from.x, x, v);
      state.y = lerp(from.y, y, v);
      state.zoom = lerp(from.zoom, zoom, v);
      apply();
    });
  }

  function reset() {
    state.x = W / 2; state.y = H / 2; state.zoom = 1;
    apply();
  }

  apply();
  return { moveTo, reset, state };
}

// How much motion a block has EARNED, decided from its structure alone.
//
// Camera moves and arced paths make a long journey feel like a journey — but spent
// on a four-message exchange they're just fidgeting. So they aren't free: a block
// has to be big enough to justify them.
//
// The honest limit of this: structure is all that's actually knowable here. It can
// tell "long journey" from "short transaction", which is the distinction that was
// actually wrong. It CANNOT tell an important topic from a mundane one — a TCP
// handshake and a lunch order are structurally identical, and no deterministic rule
// separates them. That would take a model judging meaning, which would cost the
// same-input-same-output guarantee the whole renderer is built on.
function motionProfile(block) {
  const actorCount = Object.keys(block.actors).length;

  if (actorCount === 0) {
    // Process flow — the number of stages is the whole story.
    const stages = block.steps.filter(s => s.type === 'narrate' || s.type === 'state').length;
    return { cinematic: stages >= 5 };
  }

  // Sequence — count real exchanges; narration lines aren't journeys.
  const messages = block.steps.filter(
    s => s.type === 'send' || s.type === 'reply' || s.type === 'connect'
  ).length;
  return { cinematic: messages >= 6 || actorCount >= 4 };
}

// What an actor should be DRAWN as. Checked in this order because a person is more
// specific than a thing: "user" would otherwise be swallowed by a generic match.
// Falls back to 'box', so an unrecognised actor is never an error — just a less
// specific picture, which is exactly what the diagrams drew before.
function actorVisual(actor) {
  const text = `${actor.id} ${actor.label || ''}`;
  if (looksLikePerson(text)) return { kind: 'figure' };
  const object = detectObject(text);
  if (object) return { kind: 'object', object };
  return { kind: 'box' };
}

// Is this a one-way flow rather than a conversation?
//
// A conversation has replies and goes both ways — that's what the timeline in the
// sequence template is FOR. A flow only ever runs outward: nothing talks back to
// the sun. Rendering "sun sends ENERGY to tree" as a labelled packet sliding along
// a timeline borrows a networking idiom for something that isn't a network.
function isOneWayFlow(block) {
  const steps = block.steps.filter(
    s => (s.type === 'send' || s.type === 'reply' || s.type === 'connect') && s.to
  );
  if (steps.length === 0) return false;
  if (steps.some(s => s.type === 'reply')) return false;

  const pairs = new Set(steps.map(s => `${s.from}>${s.to}`));
  return !steps.some(s => pairs.has(`${s.to}>${s.from}`));
}

// Draws an actor as whatever it should look like, anchored on a ground line.
// Shared by the sequence and scene templates so the two can't drift apart.
function drawActorVisual(rc, parent, actor, cx, groundY, size) {
  const visual = actorVisual(actor);
  const holder = svgEl('g', { opacity: 0 });
  parent.appendChild(holder);

  let live = null;
  if (visual.kind === 'box') {
    const w = size * 1.7, h = size * 0.85;
    holder.appendChild(rc.rectangle(cx - w / 2, groundY - h, w, h, {
      stroke: INK, strokeWidth: 1.5, roughness: 1.1, bowing: 1,
      seed: hashSeed(actor.id),
    }));
  } else if (visual.kind === 'figure') {
    live = createFigure(rc, holder, { id: actor.id, x: cx, y: groundY, height: size * 1.15 });
  } else {
    live = createObject(rc, holder, { kind: visual.object, id: actor.id, x: cx, y: groundY, size });
  }

  return { holder, kind: visual.kind, live };
}

// Scales an element around an arbitrary point. Needed because objects and figures
// carry their own translate() to position themselves — assigning style.transform
// would REPLACE that translate rather than compose with it, dropping them to the
// top-left corner. Doing it as an attribute transform keeps placement intact.
function scaleAround(el, cx, cy, s) {
  el.setAttribute('transform', `translate(${cx} ${cy}) scale(${s}) translate(${-cx} ${-cy})`);
}

// Point along a quadratic bezier — used to arc packets between actors instead of
// sliding them along a dead-straight line.
function bezierPoint(x1, y1, cx, cy, x2, y2, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * x1 + 2 * mt * t * cx + t * t * x2,
    y: mt * mt * y1 + 2 * mt * t * cy + t * t * y2,
  };
}

// Wraps a line of text into at most maxLines <tspan> rows — SVG <text> does not
// wrap on its own, so long step descriptions would otherwise overflow their box.
function wrapText(text, maxCharsPerLine, maxLines = 2) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  const overflow = lines.length > maxLines;
  if (overflow) lines.length = maxLines;

  // Anything that didn't fit gets folded onto the last line with an ellipsis.
  if (overflow && lines.length) {
    lines[lines.length - 1] += '…';
  }
  return lines;
}

// Fallback perimeter estimate for elements without getTotalLength (older/edge cases) —
// not needed for <path>/<circle>, kept as a safety net for <rect>-like shapes.
function estimatePerimeter(el) {
  const w = parseFloat(el.getAttribute('width')  || 0);
  const h = parseFloat(el.getAttribute('height') || 0);
  return w && h ? 2 * (w + h) : 200;
}

// RoughJS's jitter is randomized by default — without a fixed seed, the same actor
// would sketch differently on every render, breaking the "same input -> same output,
// always" determinism principle the rest of the renderer relies on. Deriving a seed
// from the actor's id keeps each node's hand-drawn look stable across re-renders/replays.
function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 2147483647 || 1;
}

// ── SVG factory ───────────────────────────────────────────────────────────────
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// The root <svg> for a template.
//
// Sized in PERCENT with a fixed viewBox rather than in pixels. A pixel width is
// measured once at render time, so when the preview panel is later widened the
// drawing keeps its old size and sits stranded against the left edge.
//
// With a viewBox plus preserveAspectRatio the internal coordinate system stays
// exactly as laid out — no layout maths changes — while the drawing scales to the
// space available and 'xMidYMid' keeps it centred at any panel width.
function makeResponsiveSvg(W, H) {
  return svgEl('svg', {
    width: '100%',
    height: '100%',
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'xMidYMid meet',
  });
}

// A cycle is structurally identical to a linear process — same statements, same
// shape. The only thing that separates them is that one loops, and "it loops" is
// not visible in the structure at all.
//
// The signal used instead is the one people write anyway: a closing line like
// "and the cycle repeats". That keeps the author describing what happens rather
// than tagging a style, which is the principle the whole renderer follows. Only
// the LAST stage is checked, and it's consumed as a marker rather than drawn —
// it's a note about the shape of the process, not a step in it.
//
// Heuristic, and knowingly so: a final stage that happens to contain "cycle"
// without meaning to loop would be misread. The cost is a circular diagram
// instead of a linear one, which is a survivable wrong answer.
const CYCLE_HINT = /\b(repeats?|cycles?|loops?|starts? again|begins? again|back to the start|over again)\b/i;

// Stage text for the no-actor templates. parser.js turns anything it doesn't
// recognise as an action into a 'narrate' step, so plain statements arrive here.
function extractStages(block) {
  return block.steps
    .filter(s => s.type === 'narrate' || s.type === 'state')
    .map(s => s.text || s.label)
    .filter(Boolean);
}

// Returns the stages minus the marker line if this reads as a cycle, else null.
function asCycle(stages) {
  if (stages.length < 4) return null; // 3 boxes minimum once the marker is dropped
  if (!CYCLE_HINT.test(stages[stages.length - 1])) return null;
  return stages.slice(0, -1);
}

// ── Main entry point ──────────────────────────────────────────────────────────
// Picks a visual template from the SHAPE of the parsed block, not from any tag the
// author has to write (a locked decision — authors describe what happens, the
// renderer decides how to draw it):
//
//   actors + messages that go BOTH ways     -> sequence diagram (a conversation)
//   actors + messages that only go one way  -> scene (a flow between things)
//   exactly two actors and NO messages      -> comparison (two panels)
//   statements ending in "and it repeats"   -> cycle (ring of stages)
//   no actors, just a run of statements     -> process flow (chain of stages)
//
// The actor signal is reliable because parser.js only creates actors from
// "name: Label" lines, and only produces send/reply/connect steps when a line
// names two actors. The cycle signal is a heuristic — see CYCLE_HINT above.
//
// Two named things with nothing happening between them aren't communicating —
// they're being held up against each other. That's a comparison, and it's a
// structural fact rather than a guess.
export function render2D(block, container) {
  container.innerHTML = '';

  const actors = Object.values(block.actors);
  if (actors.length > 0) {
    if (block.steps.some(step => step.type === 'includes')) return renderMindMap(block, container);
    const pipeline = asPipeline(block);
    if (pipeline) return renderPipeline(pipeline, container);
    const messages = block.steps.filter(
      s => s.type === 'send' || s.type === 'reply' || s.type === 'connect'
    ).length;
    const isIllustration = block.steps.some(s => s.type === 'contains' || s.type === 'produces');

    // Containment or outputs mean the diagram is a labelled illustration, so it
    // belongs in the scene template regardless of message shape. Checked before the
    // comparison rule, which would otherwise claim any two-actor block with no messages.
    if (isIllustration) return renderScene(block, container);
    if (actors.length === 2 && messages === 0) return renderCompare(actors, container);
    if (isOneWayFlow(block)) return renderScene(block, container);
    return renderSequence(block, container);
  }

  // A fork has to be checked before the linear templates: flattening a branch into
  // a chain doesn't just lose information, it asserts something false — that both
  // outcomes happen one after the other.
  if (block.steps.some(s => s.type === 'branch')) return renderBranchFlow(block, container);

  const stages = extractStages(block);
  const cycleStages = asCycle(stages);
  if (cycleStages) return renderCycle(cycleStages, container);

  return renderProcessFlow(block, container);
}

function mindMapTree(block) {
  const nodes = new Map(Object.values(block.actors).map(actor => [actor.id, { actor, children: [], depth: 0 }]));
  const parents = new Set();
  for (const step of block.steps) {
    if (step.type !== 'includes' || !nodes.has(step.from) || !nodes.has(step.to)) throw new Error('Mind maps need only includes relationships between defined participants.');
    if (parents.has(step.to)) throw new Error('Each mind-map topic must have one parent.');
    parents.add(step.to); nodes.get(step.from).children.push(nodes.get(step.to));
  }
  const roots = [...nodes.values()].filter(node => !parents.has(node.actor.id));
  if (roots.length !== 1) throw new Error('A mind map needs one root topic and no cycles.');
  const seen = new Set();
  function visit(node, depth) {
    if (seen.has(node)) throw new Error('Mind maps cannot contain cycles.');
    seen.add(node); node.depth = depth;
    node.children.forEach(child => visit(child, depth + 1));
  }
  visit(roots[0], 0);
  if (seen.size !== nodes.size) throw new Error('Connect every topic to the root.');
  return roots[0];
}

// Each branch has its own size and distance from the centre. Resolve only the
// boxes that compete for space, including space used by another branch's link.
function layoutOutlineBranches(branches, width, rootWidth, rootH) {
  const gap = 32, margin = 24;
  const boxes = branches.map((branch, i) => {
    const angle = (branches.length <= 2 ? 0 : -Math.PI / 2) + i * Math.PI * 2 / branches.length;
    const dx = Math.cos(angle), dy = Math.sin(angle), w = branch.width || width;
    const clearance = Math.min((rootWidth / 2 + w / 2 + gap) / (Math.abs(dx) || 1e-9), (rootH / 2 + branch.height / 2 + gap) / (Math.abs(dy) || 1e-9));
    const radius = clearance + 42 + Math.max(0, branch.height - 120) * .15;
    return { dx, dy, radius, width: w, height: branch.height, cx: 0, cy: 0 };
  });
  const overlaps = (a, b) => Math.abs(a.cx - b.cx) < (a.width + b.width) / 2 + gap && Math.abs(a.cy - b.cy) < (a.height + b.height) / 2 + gap;
  // Segment from the central topic to a different topic must not pass through a box.
  function blocksLink(box, target) {
    let lo = 0, hi = 1;
    for (const [center, half, end] of [[box.cx, box.width / 2 + 8, target.cx], [box.cy, box.height / 2 + 8, target.cy]]) {
      if (Math.abs(end) < 1e-8) { if (Math.abs(center) > half) return false; continue; }
      const a = (center - half) / end, b = (center + half) / end;
      lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
      if (lo > hi) return false;
    }
    return hi > 0 && lo < 1;
  }
  for (let attempt = 0; attempt < 600; attempt++) {
    boxes.forEach(box => { box.cx = box.dx * box.radius; box.cy = box.dy * box.radius; });
    const move = new Set();
    boxes.forEach((box, i) => {
      boxes.forEach((other, j) => {
        if (i === j) return;
        if (overlaps(box, other)) { move.add(i); move.add(j); }
        else if (blocksLink(box, other)) move.add(i);
      });
    });
    if (!move.size) break;
    if (attempt === 599) throw new Error('This outline is too dense to lay out clearly. Split it into smaller maps.');
    move.forEach(i => { boxes[i].radius = boxes[i].radius * 1.06 + 4; });
  }
  const halfW = Math.max(rootWidth / 2, ...boxes.map(box => Math.abs(box.cx) + box.width / 2)) + margin;
  const halfH = Math.max(rootH / 2, ...boxes.map(box => Math.abs(box.cy) + box.height / 2)) + margin;
  boxes.forEach((box, i) => { branches[i].x = halfW + box.cx - box.width / 2; branches[i].y = halfH + box.cy - box.height / 2; });
  return { W: halfW * 2, H: halfH * 2, rootX: halfW, rootY: halfH - rootH / 2 };
}

function renderOutlineMap(tree, container) {
  const baseWidth = 236;
  const wrap = (text, chars) => wrapText(text.replace(new RegExp(`(\\S{${chars}})(?=\\S)`, 'g'), '$1 '), chars, Infinity);
  const titleLines = wrap(tree.actor.label, 20);
  const rootH = titleLines.length * 28 + 24;
  const rootWidth = Math.max(180, Math.max(...titleLines.map(line => line.length)) * 12 + 36);
  const branches = tree.children.map(node => {
    const labels = [];
    const gather = parent => { labels.push(parent.actor.label); parent.children.forEach(gather); };
    gather(node);
    const longest = Math.max(...labels.map(label => label.length));
    const width = Math.min(360, Math.max(baseWidth, baseWidth + Math.max(0, longest - 32) * 1.2, node.actor.label.length * 9 + 32));
    const heading = wrap(node.actor.label, Math.max(12, Math.floor((width - 32) / 10)));
    const items = [];
    function collect(parent, depth) {
      parent.children.forEach(child => {
        const indent = Math.min(depth * 10, width / 3);
        items.push({ id: child.actor.id, indent, lines: wrap(child.actor.label, Math.max(8, Math.floor((width - 50 - indent) / 8.5))) });
        collect(child, depth + 1);
      });
    }
    collect(node, 0);
    return { node, width, heading, items, height: 30 + heading.length * 27 + items.reduce((sum, item) => sum + item.lines.length * 24 + 10, 0) };
  });
  const { W, H, rootX, rootY } = layoutOutlineBranches(branches, baseWidth, rootWidth, rootH);
  const svg = makeResponsiveSvg(W, H), rc = rough.svg(svg);
  svg.dataset.template = 'outline-mindmap';
  svg.style.display = 'block';
  svg.appendChild(svgEl('rect', { width: W, height: H, fill: '#fdfbf6' }));
  const root = svgEl('g', { opacity: 0, 'data-topic': tree.actor.id });
  root.appendChild(rc.rectangle((W - rootWidth) / 2, rootY, rootWidth, rootH, { stroke: INK, strokeWidth: 1.6, roughness: 1, seed: hashSeed(tree.actor.label), fill: '#e6efe9', fillStyle: 'solid' }));
  const textLines = (parent, lines, x, startY, size, anchor = 'start') => {
    const text = svgEl('text', { x, y: startY, fill: INK, 'font-family': "'Caveat', cursive", 'font-size': size, 'font-weight': 600, 'text-anchor': anchor });
    lines.forEach((line, i) => { const span = svgEl('tspan', { x, dy: i ? size + 3 : 0 }); span.textContent = line; text.appendChild(span); });
    parent.appendChild(text);
  };
  textLines(root, titleLines, W / 2, rootY + 32, 25, 'middle');
  svg.appendChild(root);
  branches.forEach(branch => {
    const width = branch.width;
    const cx = branch.x + width / 2, cy = branch.y + branch.height / 2;
    const centerY = rootY + rootH / 2, dx = cx - rootX, dy = cy - centerY;
    const start = Math.min(rootWidth / 2 / (Math.abs(dx) || 1e-9), rootH / 2 / (Math.abs(dy) || 1e-9));
    const end = Math.min(width / 2 / (Math.abs(dx) || 1e-9), branch.height / 2 / (Math.abs(dy) || 1e-9));
    const link = rc.line(rootX + dx * start, centerY + dy * start, cx - dx * end, cy - dy * end, { stroke: INK, strokeWidth: 1.25, roughness: .8, seed: hashSeed('outline-link' + branch.node.actor.id) });
    link.style.opacity = 0; svg.appendChild(link);
    const group = svgEl('g', { opacity: 0, 'data-topic': branch.node.actor.id, 'data-outline-branch': 'true', 'data-box-x': branch.x, 'data-box-y': branch.y, 'data-box-width': width, 'data-box-height': branch.height });
    const box = rc.rectangle(branch.x, branch.y, width, branch.height, { stroke: INK, strokeWidth: 1.3, roughness: 1, seed: hashSeed(branch.node.actor.id), fill: '#fdfbf6', fillStyle: 'solid' });
    group.appendChild(box);
    textLines(group, branch.heading, cx, branch.y + 30, 24, 'middle');
    let textY = branch.y + 30 + branch.heading.length * 27 + 8;
    branch.items.forEach(item => {
      const itemGroup = svgEl('g', { 'data-topic': item.id });
      itemGroup.appendChild(rc.circle(branch.x + 15 + item.indent, textY - 6, 3, { stroke: INK, fill: INK, fillStyle: 'solid', roughness: .4, seed: hashSeed(item.id) }));
      textLines(itemGroup, item.lines, branch.x + 27 + item.indent, textY, 21);
      group.appendChild(itemGroup); textY += item.lines.length * 24 + 10;
    });
    svg.appendChild(group); branch.group = group; branch.link = link;
  });
  container.style.height = 'auto'; container.style.aspectRatio = `${W} / ${H}`;
  container.appendChild(svg);
  let playing = false;
  async function play() {
    if (playing) return;
    playing = true;
    try {
      root.setAttribute('opacity', 0);
      branches.forEach(branch => { branch.group.setAttribute('opacity', 0); branch.link.style.opacity = 0; });
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (reduced) { root.setAttribute('opacity', 1); branches.forEach(branch => { branch.group.setAttribute('opacity', 1); branch.link.style.opacity = 1; }); return; }
      await tweenP(350, ease.outCubic, t => root.setAttribute('opacity', t));
      for (const branch of branches) {
        if (!svg.isConnected) break;
        branch.link.style.opacity = 1;
        await drawRoughStroke(branch.link, 350, ease.outQuad);
        await tweenP(300, ease.outCubic, t => branch.group.setAttribute('opacity', t));
      }
    } finally { playing = false; }
  }
  play(); return play;
}

function renderMindMap(block, container) {
  if (block.outline) return renderOutlineMap(mindMapTree(block), container);
  const root = mindMapTree(block), nodes = [], colors = ['#167d8d', '#8a5aaf', '#b46a27', '#447c47'];
  let leaf = 0, maxDepth = 0;
  function layout(node, color) {
    node.color = color;
    node.children.forEach((child, i) => layout(child, node.depth === 0 ? colors[i % colors.length] : color));
    node.y = node.children.length ? (node.children[0].y + node.children.at(-1).y) / 2 : 50 + leaf++ * 78;
    node.x = 120 + node.depth * 285;
    maxDepth = Math.max(maxDepth, node.depth); nodes.push(node);
  }
  layout(root, INK);
  const W = 240 + maxDepth * 285, H = Math.max(300, leaf * 78 + 22);
  const svg = makeResponsiveSvg(W, H), rc = rough.svg(svg);
  svg.dataset.template = 'mindmap';
  svg.appendChild(svgEl('rect', { width: W, height: H, fill: '#fdfbf6' }));
  container.style.aspectRatio = `${W} / ${H}`; container.style.height = 'auto';
  const links = new Map();
  for (const parent of nodes) for (const child of parent.children) {
    const path = svgEl('path', { d: `M ${parent.x + 96} ${parent.y} C ${parent.x + 142} ${parent.y}, ${child.x - 142} ${child.y}, ${child.x - 96} ${child.y}`, fill: 'none', stroke: child.color, 'stroke-width': 2.4, opacity: 0 });
    svg.appendChild(path); links.set(child, path);
  }
  for (const node of nodes) {
    const group = svgEl('g', { opacity: 0 }); group.dataset.topic = node.actor.id;
    group.appendChild(svgEl('rect', { x: node.x - 96, y: node.y - 28, width: 192, height: 56, rx: 14, fill: node.depth ? '#f3f5f1' : '#e1f0ec' }));
    group.appendChild(rc.rectangle(node.x - 96, node.y - 28, 192, 56, { stroke: node.color, strokeWidth: node.depth ? 1.2 : 2, roughness: .7, seed: hashSeed(node.actor.id) }));
    const lines = wrapText(node.actor.label, 23, 2);
    const text = svgEl('text', { x: node.x, y: node.y - (lines.length - 1) * 11, fill: INK, 'font-family': "'Caveat', cursive", 'font-size': 22, 'font-weight': 600, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
    lines.forEach((line, i) => { const span = svgEl('tspan', { x: node.x, dy: i ? 22 : 0 }); span.textContent = line; text.appendChild(span); });
    group.appendChild(text); svg.appendChild(group); node.group = group;
  }
  container.appendChild(svg);
  let playing = false;
  async function play() {
    if (playing) return;
    playing = true;
    try {
      nodes.forEach(node => node.group.setAttribute('opacity', 0));
      links.forEach(link => link.setAttribute('opacity', 0));
      for (let depth = 0; depth <= maxDepth; depth++) {
        if (!svg.isConnected) break;
        const level = nodes.filter(node => node.depth === depth);
        await Promise.all(level.map(async node => {
          const link = links.get(node);
          if (link) { link.setAttribute('opacity', 1); await drawStroke(link, 450, ease.inOutCubic); }
          await tweenP(350, ease.outCubic, t => node.group.setAttribute('opacity', t));
        }));
        await wait(250);
      }
    } finally { playing = false; }
  }
  play(); return play;
}

// A simple technical handoff has an order. Keep natural scenes spatial, and
// only use cards when every participant belongs to one unambiguous chain.
function asPipeline(block) {
  const actors = Object.values(block.actors);
  if (actors.length < 2 || actors.length > 6) return null;
  if (actors.some(actor => /^(tree|leaf|water|sun|cloud|mountain)$/.test(detectObject(`${actor.id} ${actor.label}`)))) return null;
  const outgoing = new Map(), incoming = new Set();
  for (const step of block.steps) {
    let to = step.to;
    let label = step.label || '';
    if (step.type === 'produces') {
      to = label.toLowerCase();
      label = 'Output';
    } else if (!['send', 'connect'].includes(step.type)) return null;
    if (!block.actors[step.from] || !block.actors[to] || outgoing.has(step.from) || incoming.has(to)) return null;
    outgoing.set(step.from, { to, label });
    incoming.add(to);
  }
  const starts = actors.filter(actor => !incoming.has(actor.id));
  if (starts.length !== 1) return null;
  const chain = [], seen = new Set();
  let actor = starts[0], caption = 'Start';
  while (actor && !seen.has(actor.id)) {
    seen.add(actor.id);
    chain.push({ actor, caption });
    const edge = outgoing.get(actor.id);
    if (!edge) break;
    caption = edge.label;
    actor = block.actors[edge.to];
  }
  return chain.length === actors.length && outgoing.size === actors.length - 1 ? chain : null;
}

function renderPipeline(chain, container) {
  const W = DESIGN_W, columns = chain.length <= 3 ? chain.length : 2;
  const rows = Math.ceil(chain.length / columns), margin = 34, gapX = 64, gapY = 64;
  const cardW = (W - margin * 2 - gapX * (columns - 1)) / columns, cardH = 200;
  const H = margin * 2 + rows * cardH + (rows - 1) * gapY;
  const svg = makeResponsiveSvg(W, H), rc = rough.svg(svg);
  svg.dataset.template = 'pipeline';
  svg.appendChild(svgEl('rect', { width: W, height: H, fill: '#fdfbf6' }));
  container.style.aspectRatio = `${W} / ${H}`;
  container.style.height = 'auto';
  container.appendChild(svg);
  const accent = '#167d8d';
  const cards = chain.map(({ actor, caption }, i) => {
    const row = Math.floor(i / columns), column = row % 2 ? columns - 1 - i % columns : i % columns;
    const x = margin + column * (cardW + gapX), y = margin + row * (cardH + gapY);
    const group = svgEl('g', { opacity: .15 });
    group.dataset.actor = actor.id;
    const backdrop = svgEl('rect', { x, y, width: cardW, height: cardH, rx: 14, fill: '#f2f7f5' });
    group.appendChild(backdrop);
    group.appendChild(rc.rectangle(x, y, cardW, cardH, { stroke: INK, strokeWidth: 1.2, roughness: .65, seed: hashSeed(`pipeline:${actor.id}`) }));
    const badge = svgEl('circle', { cx: x + 24, cy: y + 24, r: 13, fill: accent });
    group.appendChild(badge);
    const number = svgEl('text', { x: x + 24, y: y + 24, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'system-ui,sans-serif', 'font-size': 13, fill: 'white' });
    number.textContent = i + 1;
    group.appendChild(number);
    const drawing = drawActorVisual(rc, group, actor, x + cardW / 2, y + 109, 76);
    drawing.holder.setAttribute('opacity', 1);
    const title = svgEl('text', { x: x + cardW / 2, y: y + 132, 'text-anchor': 'middle', 'font-family': "'Caveat', cursive", 'font-size': 24, 'font-weight': 600, fill: INK });
    wrapText(actor.label || actor.id, Math.floor((cardW - 30) / 11), 2).forEach((line, j) => {
      const span = svgEl('tspan', { x: x + cardW / 2, dy: j ? 23 : 0 }); span.textContent = line; title.appendChild(span);
    });
    group.appendChild(title);
    const action = svgEl('text', { x: x + cardW / 2, y: y + 177, 'text-anchor': 'middle', 'font-family': "'Caveat', cursive", 'font-size': 19, fill: accent });
    wrapText(caption, Math.floor((cardW - 30) / 9), 1).forEach(line => { action.textContent = line; });
    group.appendChild(action);
    svg.appendChild(group);
    return { group, backdrop, x, y, row, live: drawing.live };
  });
  const links = cards.slice(1).map((card, i) => {
    const from = cards[i], sameRow = card.row === from.row, forward = card.x > from.x;
    const x1 = sameRow ? from.x + (forward ? cardW : 0) : from.x + cardW / 2;
    const y1 = sameRow ? from.y + cardH / 2 : from.y + cardH;
    const x2 = sameRow ? card.x + (forward ? 0 : cardW) : card.x + cardW / 2;
    const y2 = sameRow ? card.y + cardH / 2 : card.y;
    const group = svgEl('g', { opacity: 0 });
    group.appendChild(svgEl('path', { d: `M ${x1} ${y1} L ${x2} ${y2}`, stroke: accent, 'stroke-width': 2, fill: 'none' }));
    const dx = sameRow ? (forward ? 1 : -1) : 0, dy = sameRow ? 0 : 1;
    group.appendChild(svgEl('path', { d: `M ${x2 - dx * 9 - dy * 5} ${y2 - dy * 9 + dx * 5} L ${x2} ${y2} L ${x2 - dx * 9 + dy * 5} ${y2 - dy * 9 - dx * 5}`, stroke: accent, 'stroke-width': 2, fill: 'none' }));
    const dot = svgEl('circle', { cx: x1, cy: y1, r: 4, fill: accent, opacity: 0 });
    group.appendChild(dot); svg.appendChild(group);
    return { group, dot, x1, y1, x2, y2 };
  });
  let playing = false;
  async function play() {
    if (playing) return;
    playing = true;
    try {
      cards.forEach(card => { card.group.setAttribute('opacity', .15); card.backdrop.setAttribute('fill', '#f2f7f5'); });
      links.forEach(link => link.group.setAttribute('opacity', 0));
      for (let i = 0; i < cards.length; i++) {
        if (!svg.isConnected) break;
        if (i) {
          const link = links[i - 1]; link.group.setAttribute('opacity', 1); link.dot.setAttribute('opacity', 1);
          await tweenP(550, ease.inOutCubic, t => { link.dot.setAttribute('cx', link.x1 + (link.x2 - link.x1) * t); link.dot.setAttribute('cy', link.y1 + (link.y2 - link.y1) * t); });
          link.dot.setAttribute('opacity', 0);
          cards[i - 1].backdrop.setAttribute('fill', '#f2f7f5');
        }
        cards[i].backdrop.setAttribute('fill', '#e1f0ec');
        await tweenP(400, ease.outCubic, t => cards[i].group.setAttribute('opacity', .15 + t * .85));
        await wait(450);
      }
    } finally {
      cards.forEach(card => card.live?.stop());
      playing = false;
    }
  }
  play();
  return play;
}

// ── Template: sequence diagram (actors in a row, packets flying between them) ──
function renderSequence(block, container) {
  const actors = Object.values(block.actors);
  if (actors.length === 0) return;

  // Short exchanges stay flat and quick; only longer/wider ones earn arcs and camera work.
  const { cinematic } = motionProfile(block);

  // Layout
  const W = DESIGN_W;
  const NODE_W = 120, NODE_H = 64;
  const NODE_Y = 80;
  // Objects and figures put their label BELOW the shape rather than inside a box,
  // so the timeline starts lower than it used to, to leave room for it.
  const NODE_BOTTOM = NODE_Y + NODE_H;
  const TIMELINE_TOP = NODE_BOTTOM + 42;

  // How many timeline rows this diagram needs.
  //
  // Row spacing used to be a hardcoded 44px clamped at the bottom of the timeline.
  // That worked for three or four messages and collapsed past it: with six messages
  // the last three all pinned to the same y and drew on top of each other, with the
  // state banner landing in the pile.
  const rowSteps = block.steps.filter(
    s => s.type === 'send' || s.type === 'reply' || s.type === 'connect' || s.type === 'state'
  ).length;

  // The canvas GROWS for long exchanges rather than squeezing rows together — a
  // packet box is ~22px tall, so below roughly a 26px gap the labels start colliding
  // and the diagram becomes unreadable however neatly it's spaced. The responsive
  // viewBox scales the taller canvas down to the panel, so a long sequence renders
  // smaller but stays legible instead of overlapping.
  const COMFORTABLE_GAP = 34;
  const neededH = TIMELINE_TOP + 12 + rowSteps * COMFORTABLE_GAP + 80;
  const H = Math.max(DESIGN_H, neededH);

  const TIMELINE_BOT = H - 80;
  const rowSpan = TIMELINE_BOT - TIMELINE_TOP - 16;
  const ROW_GAP = Math.max(26, Math.min(44, rowSpan / Math.max(rowSteps, 1)));

  // Space actors evenly
  const spacing = W / (actors.length + 1);
  actors.forEach((a, i) => { a._x = spacing * (i + 1); a._y = NODE_Y; });

  // Build SVG
  const svg = makeResponsiveSvg(W, H);
  const rc = rough.svg(svg); // RoughJS drawer — its methods return <g> nodes we insert directly

  // Defs — arrow markers (no glow filter — Excalidraw-style shapes are plain, flat)
  const defs = svgEl('defs');

  // Arrow markers — dark ink like the lines themselves (Excalidraw arrows aren't
  // colored per type, just plain dark strokes).
  for (const type of ['send', 'reply', 'connect']) {
    const marker = svgEl('marker', {
      id: `arrow-${type}`, markerWidth: '8', markerHeight: '8',
      refX: '6', refY: '3', orient: 'auto'
    });
    const path = svgEl('path', { d: 'M0,0 L0,6 L8,3 z', fill: INK });
    marker.appendChild(path);
    defs.appendChild(marker);
  }
  svg.appendChild(defs);

  // Paper backdrop sits OUTSIDE the camera group so it always covers the canvas —
  // if it moved with the camera, panning would reveal blank space at the edges.
  const bgRect = svgEl('rect', { width: W, height: H, fill: '#fdfbf6' });
  svg.appendChild(bgRect);

  // Everything the camera can move over lives in here. Narration is appended to the
  // svg after this group, so it both stays fixed and renders on top.
  const world = svgEl('g');
  svg.appendChild(world);
  const camera = makeCamera(world, W, H);

  // Dot grid, drawn well past the canvas edges so pans/pull-backs never run off it.
  for (let gx = -W; gx < W * 2; gx += 40) {
    for (let gy = -H; gy < H * 2; gy += 40) {
      const dot = svgEl('circle', { cx: gx, cy: gy, r: 1, fill: '#00000012' });
      world.appendChild(dot);
    }
  }

  // Timeline lines (vertical dashed, one per actor)
  const timelineLines = actors.map(a => {
    const l = svgEl('line', {
      x1: a._x, y1: TIMELINE_TOP,
      x2: a._x, y2: TIMELINE_BOT,
      stroke: '#c9c3b8', 'stroke-width': 1.5,
      'stroke-dasharray': '4 6', opacity: 0
    });
    world.appendChild(l);
    return l;
  });

  // Node groups (render later so they're on top)
  const nodeGroups = {};
  const nodeRects  = {}; // the drawn thing: a rough box, an object, or a figure
  const nodeDecor  = {}; // labels — faded in after the shape appears
  const nodeKinds  = {}; // 'box' | 'object' | 'figure' — reveal/pulse differ per kind
  const nodeLive   = []; // objects/figures with running animation loops, for cleanup

  actors.forEach(a => {
    const visual = actorVisual(a);
    const g = svgEl('g', { opacity: 1 });

    // Label fades in after the shape draws.
    const decor = svgEl('g', { opacity: 0 });

    let shape;
    if (visual.kind === 'box') {
      // Excalidraw-style: dark charcoal stroke, no fill (transparent interior so
      // label text stays readable), subtle roughness. Plain outline, no glow.
      shape = rc.rectangle(
        a._x - NODE_W / 2, a._y, NODE_W, NODE_H,
        {
          stroke: INK, strokeWidth: 1.5,
          roughness: 1.1, bowing: 1,
          seed: hashSeed(a.id), // same actor id always sketches the same way
        }
      );
      shape.style.opacity = 0;
      g.appendChild(shape);
    } else {
      // Objects and figures position themselves via their own translate(), so they
      // get a holder to sit in — see scaleAround() for why we don't touch their
      // transform directly.
      shape = svgEl('g', { opacity: 0 });
      g.appendChild(shape);

      const built = visual.kind === 'figure'
        ? createFigure(rc, shape, { id: a.id, x: a._x, y: NODE_BOTTOM, height: NODE_H * 1.15 })
        : createObject(rc, shape, { kind: visual.object, id: a.id, x: a._x, y: NODE_BOTTOM, size: NODE_H * 1.05 });

      if (built) nodeLive.push(built);
    }

    // Label. Inside the box when there is one; underneath the shape otherwise,
    // since an object has no interior to write in.
    const labelLines = visual.kind === 'box' ? wrapText(a.label || a.id, 12, 2) : [a.label || a.id];
    const labelY = visual.kind === 'box'
      ? a._y + NODE_H / 2 - (labelLines.length > 1 ? 11 : 4)
      : NODE_BOTTOM + 20;

    const label = svgEl('text', {
      x: a._x, y: labelY,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: INK, 'font-size': visual.kind === 'box' ? 20 : 22, 'font-weight': 600,
      'font-family': "'Caveat', cursive", 'letter-spacing': '0.02em'
    });
    labelLines.forEach((line, i) => {
      const span = svgEl('tspan', { x: a._x, dy: i ? 22 : 0 });
      span.textContent = line; label.appendChild(span);
    });
    decor.appendChild(label);

    // Role sub-label only makes sense under a box — under an object it would
    // crowd the name, and the picture already says what the thing is.
    if (visual.kind === 'box' && labelLines.length === 1 && a.role !== 'node') {
      const sub = svgEl('text', {
        x: a._x, y: a._y + NODE_H / 2 + 16,
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        fill: '#1e1e1e70', 'font-size': 10, 'letter-spacing': '0.1em',
        'font-family': 'Inter, system-ui, sans-serif',
        'text-transform': 'uppercase'
      });
      sub.textContent = a.role.toUpperCase();
      decor.appendChild(sub);
    }

    g.appendChild(decor);
    world.appendChild(g);
    nodeGroups[a.id] = g;
    nodeRects[a.id]  = shape;
    nodeDecor[a.id]  = decor;
    nodeKinds[a.id]  = visual.kind;
  });

  // Narration area
  const narrationBg = svgEl('rect', {
    x: 20, y: H - 52, width: W - 40, height: 36,
    rx: 8, fill: 'rgba(0,0,0,0.03)', opacity: 0
  });
  svg.appendChild(narrationBg);

  const narrationText = svgEl('text', {
    x: W / 2, y: H - 30,
    'text-anchor': 'middle', 'dominant-baseline': 'central',
    fill: '#57534e', 'font-size': 17,
    'font-family': "'Caveat', cursive", 'font-weight': 600,
    opacity: 0
  });
  svg.appendChild(narrationText);

  container.appendChild(svg);

  // ── Animation sequence ──────────────────────────────────────────────────────
  let stepY = TIMELINE_TOP + 12; // current Y position on timeline

  async function sequence() {
    // Keep all participants visible; packets and pulses carry the attention.
    camera.reset();

    // Nodes appear, then their label settles in.
    //
    // A box sketches its own outline (drawRoughStroke walks the RoughJS group's
    // child paths). Objects and figures fade and scale up instead: they hold many
    // pre-drawn variants/frames with most of them hidden, so dash-revealing every
    // path inside would touch frames nobody is looking at.
    for (const a of actors) {
      const decor = nodeDecor[a.id];
      const shape = nodeRects[a.id];
      const kind = nodeKinds[a.id];

      // Reset to pre-draw state — replay re-runs this on the same DOM elements
      // rather than rebuilding them.
      decor.setAttribute('opacity', 0);
      shape.style.opacity = 0;

      if (kind === 'box') {
        shape.style.transformOrigin = `${a._x}px ${a._y + NODE_H / 2}px`;
        shape.style.transformBox = 'fill-box';
        shape.style.transform = 'scale(1)';
        await drawRoughStroke(shape, 420, ease.outQuad);
      } else {
        await tweenP(420, ease.outBack, v => {
          shape.style.opacity = Math.min(v * 1.6, 1);
          // Grows from the ground up, so it reads as arriving in place rather
          // than swelling from its middle.
          scaleAround(shape, a._x, NODE_BOTTOM, 0.72 + 0.28 * v);
        });
      }

      await tweenP(300, ease.outCubic, v => {
        decor.setAttribute('opacity', v);
      });
    }

    // Pull back to take in the whole diagram before the exchange starts.
    if (cinematic) camera.moveTo(W / 2, H / 2, 1, 900, ease.inOutCubic);

    // Timeline lines fade in
    await wait(200);
    await tweenP(500, ease.outCubic, v => {
      timelineLines.forEach(l => l.setAttribute('opacity', v * 0.5));
    });

    await wait(400);

    // Play each step. Beat length after each step varies by weight — a state
    // change or highlight is a bigger moment and earns a longer pause to let it
    // land, while ordinary sends stay snappy. Uniform pacing is what makes
    // sequential animation feel mechanical; varying it is what makes it feel directed.
    for (const step of block.steps) {
      await playStep(step);
      await wait(stepBeat(step));
    }

    // Closing pull-back: settle on the finished diagram as a whole.
    if (cinematic) camera.moveTo(W / 2, H / 2, 1, 800, ease.inOutCubic);
    await wait(600);
  }

  function stepBeat(step) {
    if (step.type === 'state') return 550;
    if (step.type === 'highlight') return 400;
    if (step.type === 'narrate') return 200;
    return 280; // send / reply / connect — keep these snappy so a sequence doesn't drag
  }

  async function playStep(step) {
    if (step.type === 'narrate') {
      return showNarration(step.text);
    }
    if (step.type === 'pause') {
      return wait(800);
    }
    if (step.type === 'state') {
      return playState(step);
    }
    if (step.type === 'highlight') {
      return pulseNode(step.actor, COLORS.highlight.fillTint);
    }
    if (step.type === 'send' || step.type === 'reply') {
      return playPacket(step);
    }
    if (step.type === 'connect') {
      return playConnect(step);
    }
  }

  async function playPacket(step) {
    const fromActor = block.actors[step.from];
    const toActor   = step.to ? block.actors[step.to] : null;
    if (!fromActor) return;

    const theme = COLORS[step.type] || COLORS.send;
    const y = stepY;
    stepY += ROW_GAP;

    const fromX = fromActor._x;
    const toX   = toActor ? toActor._x : fromX + 200;

    // Timeline dot at source
    const dotStart = svgEl('circle', {
      cx: fromX, cy: y, r: 4.5,
      fill: INK, opacity: 0
    });
    world.appendChild(dotStart);
    await tweenP(250, ease.outBack, v => {
      dotStart.setAttribute('opacity', v);
      dotStart.setAttribute('r', 3 + v * 1.5);
    });

    const dx = toX - fromX;
    // Sequence arrows are ALWAYS straight.
    //
    // Curves were applied here when a block qualified as "cinematic", and they were
    // wrong for this template: a sequence diagram is read as a grid of who-said-what-
    // when, and bowed arrows fight that. Curves belong where the path itself carries
    // meaning — a cycle's ring, a scene's flow. A zero arc height puts the bezier
    // control point on the line, so the same path code draws a straight connector.
    const arcHeight = 0;
    const ctrlX = (fromX + toX) / 2;
    const ctrlY = y - (step.type === 'reply' ? -arcHeight : arcHeight);

    const arrowLine = svgEl('path', {
      d: `M ${fromX} ${y} Q ${ctrlX} ${ctrlY} ${toX} ${y}`,
      fill: 'none',
      stroke: INK, 'stroke-width': 1.8,
      'marker-end': `url(#arrow-${step.type === 'reply' ? 'reply' : step.type === 'connect' ? 'connect' : 'send'})`,
      opacity: 0
    });
    world.appendChild(arrowLine);

    // Measured from the real path, so the self-draw reveal matches the curve's
    // actual length instead of the straight-line distance.
    const lineLen = arrowLine.getTotalLength();
    arrowLine.setAttribute('stroke-dasharray', lineLen);
    arrowLine.setAttribute('stroke-dashoffset', lineLen);

    // The message name, left permanently above its arrow.
    //
    // Previously the label existed only on the travelling packet, which then faded
    // out and took the label with it — so the finished diagram was a stack of bare
    // arrows that said nothing about what was actually sent. A sequence diagram's
    // whole content is who said WHAT to whom; the label has to outlive the motion.
    const restingLabel = svgEl('text', {
      x: (fromX + toX) / 2, y: y - 13,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: INK, 'font-size': 16, 'font-weight': 700,
      'font-family': "'Caveat', cursive", 'letter-spacing': '0.03em',
      opacity: 0,
    });
    restingLabel.textContent = step.label;
    world.appendChild(restingLabel);

    // Packet orb
    const packetG = svgEl('g', { opacity: 0 });
    packetG.setAttribute('transform', `translate(${fromX}, ${y})`);

    const packetBg = svgEl('ellipse', {
      rx: 34, ry: 14, cx: 0, cy: 0,
      fill: theme.fillTint, opacity: 0.25
    });
    const packetRect = svgEl('rect', {
      x: -32, y: -11, width: 64, height: 22,
      rx: 11, fill: '#fdfbf6',
      stroke: INK, 'stroke-width': 1.5
    });
    const packetLabel = svgEl('text', {
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: INK, 'font-size': 16, 'font-weight': 700,
      'font-family': "'Caveat', cursive", 'letter-spacing': '0.04em'
    });
    packetLabel.textContent = step.label;
    packetG.appendChild(packetBg);
    packetG.appendChild(packetRect);
    packetG.appendChild(packetLabel);
    world.appendChild(packetG);

    showNarration(
      step.type === 'reply'
        ? `${fromActor.label} replies ${step.label}${toActor ? ' → ' + toActor.label : ''}`
        : `${fromActor.label} sends ${step.label}${toActor ? ' → ' + toActor.label : ''}`
    );

    // Anticipation: a small pull-back before launching forward — the single most
    // recognizable "hand-tuned" motion cue (classical animation principle). Reads
    // as the packet "winding up" before it commits to the send.
    const anticipationPx = Math.sign(toX - fromX) * -6;
    await tweenP(120, ease.outQuad, v => {
      packetG.setAttribute('transform', `translate(${fromX + anticipationPx * v}, ${y}) scale(${1 - v * 0.06})`);
    });

    // Follow the connector, keeping the message readable in either direction.
    arrowLine.setAttribute('opacity', 1);

    await tweenP(650, ease.outQuart, v => {
      arrowLine.setAttribute('stroke-dashoffset', lineLen * (1 - v));

      const p = bezierPoint(fromX + anticipationPx, y, ctrlX, ctrlY, toX, y, v);

      // Squash/stretch: stretched along travel mid-flight, settling on arrival.
      const stretch = 1 + Math.sin(v * Math.PI) * 0.12;
      packetG.setAttribute(
        'transform',
        `translate(${p.x}, ${p.y}) scale(${stretch}, ${1 / stretch})`
      );
      packetG.setAttribute('opacity', v < 0.08 ? v / 0.08 : 1);
    });

    // Tiny settle bounce on arrival instead of stopping dead.
    await tweenP(150, ease.outBack, v => {
      const s = 1 - (1 - v) * 0.08;
      packetG.setAttribute('transform', `translate(${toX}, ${y}) scale(${s})`);
    });

    // Dot at destination
    if (toActor) {
      const dotEnd = svgEl('circle', {
        cx: toX, cy: y, r: 4.5,
        fill: INK, opacity: 0
      });
      world.appendChild(dotEnd);
      await tweenP(220, ease.outBack, v => {
        dotEnd.setAttribute('opacity', v);
        dotEnd.setAttribute('r', 3 + v * 1.5);
      });

      // Pulse the receiving node
      pulseNode(step.to, theme.fillTint);
    }

    // The packet hands its label to the arrow: as the travelling orb fades, the
    // resting label fades in above the line. The name is never absent from the
    // frame, and what remains afterwards is a readable diagram rather than a
    // stack of anonymous arrows.
    await tweenP(300, ease.outCubic, v => {
      packetG.setAttribute('opacity', 1 - v);
      restingLabel.setAttribute('opacity', v);
    });
    packetG.remove();
  }

  async function playState(step) {
    const color = COLORS.state.fillTint;

    // All nodes give a quick scale-bounce as the "state changed" cue (no glow —
    // Excalidraw-style shapes don't have neon halos).
    for (const a of actors) pulseNode(a.id, color);

    // Banner across timeline — a small RoughJS-drawn box, same sketchy style as the nodes.
    const bannerY = stepY + 10;
    stepY += ROW_GAP;

    const banner = svgEl('g', { opacity: 0 });
    const bw = 220;
    const bRect = rc.rectangle(W/2 - bw/2, bannerY - 13, bw, 26, {
      stroke: INK, strokeWidth: 1.5,
      roughness: 1.1, bowing: 1,
    });
    const bText = svgEl('text', {
      x: W/2, y: bannerY,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: INK, 'font-size': 17, 'font-weight': 700,
      'font-family': "'Caveat', cursive", 'letter-spacing': '0.04em'
    });
    bText.textContent = step.label.toUpperCase();
    banner.appendChild(bRect); banner.appendChild(bText);
    world.appendChild(banner);

    await tweenP(500, ease.outBack, v => banner.setAttribute('opacity', v));
    showNarration(step.label);
    await wait(800);
  }

  async function playConnect(step) {
    const fromActor = block.actors[step.from];
    const toActor   = block.actors[step.to];
    if (!fromActor || !toActor) return;
    const theme = COLORS.connect;
    const y = stepY;
    stepY += ROW_GAP;

    const dx = toActor._x - fromActor._x;
    const lineLen = Math.abs(dx);

    const line = svgEl('line', {
      x1: fromActor._x, y1: y, x2: toActor._x, y2: y,
      stroke: INK, 'stroke-width': 2,
      'stroke-dasharray': lineLen, 'stroke-dashoffset': lineLen,
      'marker-end': 'url(#arrow-connect)', opacity: 0
    });
    world.appendChild(line);
    line.setAttribute('opacity', 1);

    showNarration(`${fromActor.label} connects to ${toActor.label}`);
    await tweenP(700, ease.outCubic, v => {
      line.setAttribute('stroke-dashoffset', lineLen * (1 - v));
    });

    const dotEnd = svgEl('circle', { cx: toActor._x, cy: y, r: 5, fill: INK, opacity: 0 });
    world.appendChild(dotEnd);
    await tweenP(250, ease.outBack, v => dotEnd.setAttribute('opacity', v));
    pulseNode(step.to, theme.fillTint);
  }

  // Gives a node a quick scale "flinch" — used when it receives a packet or gets
  // highlighted. No glow/halo (Excalidraw-style shapes are plain); the bounce is
  // the feedback.
  //
  // Boxes flinch via CSS transform. Objects and figures must use scaleAround()
  // instead: they carry their own translate(), and a style transform would replace
  // it rather than compose with it, throwing them to the corner mid-pulse.
  async function pulseNode(actorId, color) {
    const shape = nodeRects[actorId];
    if (!shape) return;
    const actor = block.actors[actorId];
    const isBox = nodeKinds[actorId] === 'box';

    const applyScale = s => {
      if (isBox) shape.style.transform = `scale(${s})`;
      else if (actor) scaleAround(shape, actor._x, NODE_BOTTOM, s);
    };

    await tweenP(180, ease.outQuad, v => applyScale(1 + v * 0.08));
    await tweenP(300, ease.outCubic, v => applyScale(1.08 - v * 0.08));
  }

  async function showNarration(text) {
    narrationText.setAttribute('opacity', 0);
    narrationBg.setAttribute('opacity', 0);
    narrationText.textContent = text;
    await tweenP(350, ease.outCubic, v => {
      narrationText.setAttribute('opacity', v * 0.75);
      narrationBg.setAttribute('opacity', v * 0.8);
    });
  }

  function lerpColor(hex1, hex2, t) {
    const parse = h => [
      parseInt(h.slice(1,3),16),
      parseInt(h.slice(3,5),16),
      parseInt(h.slice(5,7),16)
    ];
    const [r1,g1,b1] = parse(hex1);
    const [r2,g2,b2] = parse(hex2);
    const r = Math.round(lerp(r1,r2,t)).toString(16).padStart(2,'0');
    const g = Math.round(lerp(g1,g2,t)).toString(16).padStart(2,'0');
    const b = Math.round(lerp(b1,b2,t)).toString(16).padStart(2,'0');
    return `#${r}${g}${b}`;
  }

  // Run it
  sequence();

  // Return a replay function
  return () => { sequence(); };
}

// ── Template: process flow (a chain of stages, no actors) ─────────────────────
// For "how something works, step by step" content — the structure most explainer
// topics actually have. Every non-actor line becomes a stage in a vertical chain,
// each box sketching itself in, with an arrow drawing down to the next.
function renderProcessFlow(block, container) {
  // parser.js turns any line it doesn't recognise as an action into a 'narrate'
  // step, so a block of plain statements arrives here as narrate steps.
  const stages = block.steps
    .filter(s => s.type === 'narrate' || s.type === 'state')
    .map(s => s.text || s.label)
    .filter(Boolean);

  if (stages.length === 0) return;

  // Only longer flows earn the extra camera flourish. Note this is separate from
  // panning: panning a chain that overflows the canvas is a necessity, not drama,
  // and happens regardless of whether the block is "cinematic".
  const { cinematic } = motionProfile(block);

  const W = DESIGN_W;
  const H = DESIGN_H;

  // Boxes keep a comfortable, readable size no matter how many stages there are.
  // Earlier this shrank everything to fit the canvas, which made long flows
  // unreadable — now the chain is allowed to run taller than the canvas and the
  // camera pans down it instead.
  const PAD = 34;
  const n = stages.length;
  const gap = 34;
  const boxH = 58;
  const boxW = Math.min(560, W - 90);
  const boxX = (W - boxW) / 2;
  const totalH = boxH * n + gap * (n - 1);

  // Short chains fit on screen and stay centred (no pan). Long ones start at the
  // top and get followed downward.
  const fitsOnScreen = totalH <= H - PAD * 2;
  const startY = fitsOnScreen ? (H - totalH) / 2 : PAD;

  const svg = makeResponsiveSvg(W, H);
  const rc = rough.svg(svg);

  // Backdrop stays outside the camera group so panning never reveals blank edges.
  const bg = svgEl('rect', { width: W, height: H, fill: '#fdfbf6' });
  svg.appendChild(bg);

  const world = svgEl('g');
  svg.appendChild(world);
  const camera = makeCamera(world, W, H);

  // Build every stage up front (hidden), then reveal them in order.
  const built = stages.map((text, idx) => {
    const y = startY + idx * (boxH + gap);

    const box = rc.rectangle(boxX, y, boxW, boxH, {
      stroke: INK, strokeWidth: 1.5,
      roughness: 1.1, bowing: 1,
      seed: hashSeed(text + idx),
    });
    box.style.opacity = 0;
    world.appendChild(box);

    // Step number, sitting just outside the box on the left.
    const num = svgEl('text', {
      x: boxX - 18, y: y + boxH / 2,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: INK, 'font-size': 17, 'font-weight': 700,
      'font-family': "'Caveat', cursive", opacity: 0
    });
    num.textContent = String(idx + 1);
    world.appendChild(num);

    // Stage text, wrapped to at most two lines.
    const lines = wrapText(text, Math.floor(boxW / 9), 2);
    const label = svgEl('text', {
      x: boxX + boxW / 2, y: y + boxH / 2,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: INK, 'font-size': 17, 'font-weight': 600,
      'font-family': "'Caveat', cursive", opacity: 0
    });
    lines.forEach((lineText, li) => {
      const tspan = svgEl('tspan', {
        x: boxX + boxW / 2,
        dy: li === 0 ? (lines.length > 1 ? -9 : 0) : 18,
      });
      tspan.textContent = lineText;
      label.appendChild(tspan);
    });
    world.appendChild(label);

    // Connector down to the next stage (none after the last).
    let arrow = null;
    if (idx < n - 1) {
      const cx = W / 2;
      const y1 = y + boxH;
      const y2 = y + boxH + gap;
      arrow = rc.line(cx, y1, cx, y2 - 5, {
        stroke: INK, strokeWidth: 1.5, roughness: 1.2, bowing: 1,
        seed: hashSeed('arrow' + idx),
      });
      arrow.style.opacity = 0;
      world.appendChild(arrow);

      const head = svgEl('path', {
        d: `M${cx - 4},${y2 - 7} L${cx + 4},${y2 - 7} L${cx},${y2} z`,
        fill: INK, opacity: 0
      });
      world.appendChild(head);
      arrow._head = head;
    }

    return { box, num, label, arrow, y };
  });

  container.appendChild(svg);

  async function sequence() {
    // Reset — replay reuses the same DOM rather than rebuilding it.
    built.forEach(({ box, num, label, arrow }) => {
      box.style.opacity = 0;
      num.setAttribute('opacity', 0);
      label.setAttribute('opacity', 0);
      if (arrow) {
        arrow.style.opacity = 0;
        arrow._head.setAttribute('opacity', 0);
      }
    });

    camera.reset();
    await wait(250);

    for (let idx = 0; idx < built.length; idx++) {
      const { box, num, label, arrow, y } = built[idx];

      // Follow the chain downward as it builds. Short chains fit on screen, so the
      // camera stays put and nothing distracting happens; long ones get panned, which
      // is what lets the boxes stay full-size instead of shrinking to fit.
      // The slight push-in on top of the pan is the part that's decorative.
      if (!fitsOnScreen) {
        camera.moveTo(W / 2, y + boxH / 2, cinematic ? 1.05 : 1, 520, ease.inOutCubic);
      }

      // The box sketches itself in, then its text appears.
      await drawRoughStroke(box, 420, ease.outQuad);
      await tweenP(260, ease.outCubic, v => {
        label.setAttribute('opacity', v);
        num.setAttribute('opacity', v * 0.65);
      });

      if (arrow) {
        await wait(80);
        await drawRoughStroke(arrow, 220, ease.outQuad);
        await tweenP(140, ease.outBack, v => arrow._head.setAttribute('opacity', v));
      }
      await wait(120);
    }

    // Closing move: pull back far enough to take in the finished chain.
    if (!fitsOnScreen) {
      const fitZoom = Math.min(1, (H - PAD * 2) / totalH);
      camera.moveTo(W / 2, startY + totalH / 2, fitZoom, 1100, ease.inOutCubic);
    }
  }

  sequence();
  return () => { sequence(); };
}

// ── Template: cycle (a ring of stages that returns to its start) ──────────────
// For processes whose end feeds back into their beginning — water cycle, cell
// cycle, feedback loops. Drawn as a ring precisely so the "returns to the start"
// property is visible in the shape itself rather than stated in words.
function renderCycle(stages, container) {
  const n = stages.length;
  if (n < 3) return;

  const W = DESIGN_W;
  const H = DESIGN_H;
  const cx = W / 2;
  const cy = H / 2;

  const svg = makeResponsiveSvg(W, H);
  const rc = rough.svg(svg);

  const bg = svgEl('rect', { width: W, height: H, fill: '#fdfbf6' });
  svg.appendChild(bg);

  const world = svgEl('g');
  svg.appendChild(world);
  const camera = makeCamera(world, W, H);

  // Ring geometry. The radius is pulled in from the canvas edge far enough that a
  // box sitting on the ring still fits, since boxes straddle the radius line.
  const boxW = Math.min(150, Math.max(96, (2 * Math.PI * (Math.min(W, H) * 0.3)) / n * 0.78));
  const boxH = 46;
  const R = Math.min(W * 0.5 - boxW * 0.55 - 12, H * 0.5 - boxH - 18);

  // Stage i sits at angle i, starting at the top and running clockwise — the
  // direction people read a cycle diagram by default.
  const angleAt = i => -Math.PI / 2 + (i / n) * Math.PI * 2;
  const pointAt = (a, radius = R) => ({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });

  const built = stages.map((text, idx) => {
    const a = angleAt(idx);
    const c = pointAt(a);

    const box = rc.rectangle(c.x - boxW / 2, c.y - boxH / 2, boxW, boxH, {
      stroke: INK, strokeWidth: 1.5,
      roughness: 1.1, bowing: 1,
      seed: hashSeed(text + idx),
    });
    box.style.opacity = 0;
    world.appendChild(box);

    const lines = wrapText(text, Math.floor(boxW / 7.5), 2);
    const label = svgEl('text', {
      x: c.x, y: c.y,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: INK, 'font-size': 17, 'font-weight': 600,
      'font-family': "'Caveat', cursive", opacity: 0
    });
    lines.forEach((lineText, li) => {
      const tspan = svgEl('tspan', {
        x: c.x,
        dy: li === 0 ? (lines.length > 1 ? -8 : 0) : 16,
      });
      tspan.textContent = lineText;
      label.appendChild(tspan);
    });
    world.appendChild(label);

    // Arc to the next stage, bowing outward so it follows the ring. Every stage
    // gets one — including the last, whose arc closes the loop back to stage 0.
    const aNext = angleAt(idx + 1);
    const pad = (Math.PI * 2 / n) * 0.30; // clearance so arcs start/end clear of the boxes
    const from = pointAt(a + pad);
    const to = pointAt(aNext - pad);
    const mid = pointAt((a + aNext) / 2, R * 1.14);

    const arc = rc.path(`M ${from.x} ${from.y} Q ${mid.x} ${mid.y} ${to.x} ${to.y}`, {
      stroke: INK, strokeWidth: 1.5, roughness: 1.1, bowing: 1,
      seed: hashSeed('arc' + idx),
    });
    arc.style.opacity = 0;
    world.appendChild(arc);

    // Arrowhead, rotated to the arc's tangent as it arrives.
    const tangent = Math.atan2(to.y - mid.y, to.x - mid.x) * (180 / Math.PI);
    const head = svgEl('path', {
      d: 'M -5 -4 L 5 0 L -5 4 z',
      fill: INK, opacity: 0,
      transform: `translate(${to.x} ${to.y}) rotate(${tangent})`,
    });
    world.appendChild(head);

    return { box, label, arc, head };
  });

  container.appendChild(svg);

  async function sequence() {
    built.forEach(({ box, label, arc, head }) => {
      box.style.opacity = 0;
      label.setAttribute('opacity', 0);
      arc.style.opacity = 0;
      head.setAttribute('opacity', 0);
    });
    camera.reset();

    await wait(250);

    for (const { box, label, arc, head } of built) {
      await drawRoughStroke(box, 380, ease.outQuad);
      await tweenP(240, ease.outCubic, v => label.setAttribute('opacity', v));
      await drawRoughStroke(arc, 260, ease.outQuad);
      await tweenP(130, ease.outBack, v => head.setAttribute('opacity', v));
    }

    // Once the ring closes, a slow pull-back reads as "and this keeps going" —
    // the loop being whole is the point of the diagram.
    await camera.moveTo(cx, cy, 0.94, 900, ease.inOutCubic);
  }

  sequence();
  return () => { sequence(); };
}

// ── Template: comparison (two things held side by side) ───────────────────────
// Reached when a block names exactly two things and nothing happens between them.
// Each actor's label is split on commas into the points being compared, so
// "Before: slow, manual, error-prone" becomes a panel with three bullets.
function renderCompare(actors, container) {
  const W = DESIGN_W;

  const MARGIN = 42;
  const GAP = 26;
  const panelW = (W - MARGIN * 2 - GAP) / 2;

  // A before/after comparison is not neutral — one side is the problem and the
  // other is the fix, and the picture should say so. Detected from the words the
  // author already wrote rather than any styling directive; anything else stays
  // even-handed, since "Postgres vs MySQL" has no better side.
  const BEFORE_WORDS = /^(before|old|current|today|previously|was|legacy|v1)$/i;
  const AFTER_WORDS = /^(after|new|now|proposed|becomes|will|modern|v2)$/i;
  const looksDirectional =
    BEFORE_WORDS.test(actors[0].id) && AFTER_WORDS.test(actors[1].id);

  const sides = actors.map((a, i) => ({
    title: a.id.charAt(0).toUpperCase() + a.id.slice(1),
    points: (a.label || '').split(',').map(s => s.trim()).filter(Boolean)
      .map(point => wrapText(point, Math.floor((panelW - 64) / 9), Infinity)),
    // Marks read faster than colour and survive being printed or screenshotted.
    mark: looksDirectional ? (i === 0 ? '✗' : '✓') : '•',
    tint: looksDirectional ? (i === 0 ? '#c2410c' : '#15803d') : INK,
  }));

  // Both panels share a height so they read as a fair comparison — sized to
  // whichever side has more points, not each to its own content.
  const HEAD_H = 54;
  const pointHeight = lines => Math.max(34, lines.length * 23 + 12);
  const panelH = HEAD_H + Math.max(...sides.map(s => s.points.reduce((sum, lines) => sum + pointHeight(lines), 0)), 34) + 26;
  const H = Math.max(DESIGN_H, panelH + MARGIN * 2);
  const panelY = (H - panelH) / 2;
  const svg = makeResponsiveSvg(W, H);
  const rc = rough.svg(svg);
  svg.appendChild(svgEl('rect', { width: W, height: H, fill: '#fdfbf6' }));

  const built = sides.map((side, idx) => {
    const x = MARGIN + idx * (panelW + GAP);

    const box = rc.rectangle(x, panelY, panelW, panelH, {
      stroke: INK, strokeWidth: 1.5,
      roughness: 1.1, bowing: 1,
      seed: hashSeed(side.title),
    });
    box.style.opacity = 0;
    svg.appendChild(box);

    const contents = svgEl('g', { opacity: 0 });

    const title = svgEl('text', {
      x: x + panelW / 2, y: panelY + 30,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: side.tint, 'font-size': 27, 'font-weight': 700,
      'font-family': "'Caveat', cursive",
    });
    title.textContent = side.title;
    contents.appendChild(title);

    // Rule under the heading, drawn rough so it matches the panel's hand.
    const rule = rc.line(x + 16, panelY + HEAD_H - 8, x + panelW - 16, panelY + HEAD_H - 8, {
      stroke: INK, strokeWidth: 1, roughness: 1.4, bowing: 1,
      seed: hashSeed('rule' + side.title),
    });
    rule.setAttribute('opacity', 0.45);
    contents.appendChild(rule);

    let py = panelY + HEAD_H + 18;
    side.points.forEach(lines => {

      const mark = svgEl('text', {
        x: x + 26, y: py,
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        fill: side.tint, 'font-size': 17, 'font-weight': 700,
        'font-family': "'Segoe UI',system-ui,sans-serif",
      });
      mark.textContent = side.mark;
      contents.appendChild(mark);

      const text = svgEl('text', {
        x: x + 44, y: py,
        'dominant-baseline': 'central',
        fill: INK, 'font-size': 19, 'font-weight': 600,
        'font-family': "'Caveat', cursive",
      });
      lines.forEach((line, i) => {
        const span = svgEl('tspan', { x: x + 44, dy: i ? 23 : 0 });
        span.textContent = line;
        text.appendChild(span);
      });
      contents.appendChild(text);
      py += pointHeight(lines);
    });

    svg.appendChild(contents);
    return { box, contents };
  });

  container.appendChild(svg);

  async function sequence() {
    built.forEach(({ box, contents }) => {
      box.style.opacity = 0;
      contents.setAttribute('opacity', 0);
    });

    await wait(250);

    // One side at a time — a comparison lands better when you read the first
    // panel before the second appears to answer it.
    for (const { box, contents } of built) {
      await drawRoughStroke(box, 420, ease.outQuad);
      await tweenP(280, ease.outCubic, v => contents.setAttribute('opacity', v));
      await wait(200);
    }
  }

  sequence();
  return () => { sequence(); };
}

// ── Template: scene (things in a space, with flow between them) ───────────────
// For one-way relationships: sunlight reaching a leaf, water feeding a root.
// There is no back-and-forth and no ordering, so a timeline would be the wrong
// picture — what matters is WHERE things are and WHAT moves between them.
//
// So instead of packets on a rail: objects placed in the frame, and continuous
// streams of particles running along the paths between them.
function renderScene(block, container) {
  const actors = Object.values(block.actors);
  const edges = block.steps
    .filter(s => (s.type === 'send' || s.type === 'connect') && s.to)
    .filter(s => block.actors[s.from] && block.actors[s.to])
    .map(s => ({ from: s.from, to: s.to, label: s.label || '' }));

  // Detail callouts: "leaf contains chloroplasts" magnifies part of the diagram in
  // a circle beside it. Standard scientific-illustration convention.
  const details = block.steps
    .filter(s => s.type === 'contains' && block.actors[s.from])
    .map(s => ({ from: s.from, label: s.label }));

  // Outputs: "plant produces GLUCOSE" — a flow leaving the diagram rather than
  // travelling between two named things.
  const outputs = block.steps
    .filter(s => s.type === 'produces' && block.actors[s.from])
    .map(s => ({ from: s.from, label: s.label }));

  // A diagram of nothing but callouts or outputs is still worth drawing.
  if (actors.length === 0 || (edges.length === 0 && details.length === 0 && outputs.length === 0)) return;

  const W = DESIGN_W;
  const H = DESIGN_H;

  const svg = makeResponsiveSvg(W, H);
  const rc = rough.svg(svg);
  svg.appendChild(svgEl('rect', { width: W, height: H, fill: '#fdfbf6' }));
  const world = svgEl('g');
  svg.appendChild(world);
  const camera = makeCamera(world, W, H);

  // ── Layout: place things where they BELONG, not where the graph puts them ──
  //
  // This used to lay actors out by how far downstream they were — sources in a
  // left column, targets to the right. Topologically correct and completely wrong
  // to look at: it put the sun beside the plant instead of above it.
  //
  // A scene is a picture of the world, so position comes from what a thing IS.
  // The sun is in the sky; groundwater is under the ground; a plant stands between
  // them. That's inferable from the object kind already detected for drawing, so it
  // costs the author nothing.
  const BAND = { sky: 0, ground: 1, below: 2 };

  function bandFor(actor) {
    const kind = detectObject(`${actor.id} ${actor.label || ''}`);
    if (kind === 'sun' || kind === 'cloud') return BAND.sky;
    if (kind === 'water') return BAND.below;
    return BAND.ground;
  }

  const bands = [[], [], []];
  for (const a of actors) bands[bandFor(a)].push(a);

  const MARGIN_X = 96;
  const size = 84;

  // Vertical placement per band. Collapsed toward the middle when a band is empty,
  // so a diagram with no sky doesn't leave a hole at the top.
  const usedBands = bands.map(b => b.length > 0);
  const bandY = [H * 0.24, H * 0.54, H * 0.83];
  if (!usedBands[0] && !usedBands[2]) bandY[1] = H * 0.5;

  const pos = {};
  bands.forEach((row, bandIndex) => {
    row.forEach((a, i) => {
      let x;
      if (row.length === 1) {
        // A lone sun sits upper-LEFT rather than centred — light coming from the
        // upper left is the convention every illustration of this kind follows.
        x = bandIndex === BAND.sky ? W * 0.24 : W * 0.5;
      } else {
        x = MARGIN_X + (i / (row.length - 1)) * (W - MARGIN_X * 2);
      }
      pos[a.id] = { x, y: bandY[bandIndex] };
    });
  });

  // A ground line, drawn only when something sits above it and something below —
  // which is exactly when it carries meaning (roots under soil) rather than being
  // decoration.
  let groundLine = null;
  if (usedBands[1] && usedBands[2]) {
    const gy = (bandY[1] + bandY[2]) / 2 + size * 0.18;
    groundLine = rc.line(W * 0.12, gy, W * 0.88, gy, {
      stroke: INK, strokeWidth: 1.5, roughness: 1.4, bowing: 1.6, seed: hashSeed('ground'),
    });
    groundLine.style.opacity = 0;
    world.appendChild(groundLine);
  }

  // ── Things ─────────────────────────────────────────────────────────────────
  const nodes = actors.map(a => {
    const p = pos[a.id];
    const groundY = p.y + size * 0.5;
    const drawn = drawActorVisual(rc, world, a, p.x, groundY, size);

    const label = svgEl('text', {
      x: p.x, y: groundY + 20,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: INK, 'font-size': 17, 'font-weight': 600,
      'font-family': "'Caveat', cursive", opacity: 0,
    });
    label.textContent = a.label || a.id;
    world.appendChild(label);

    return { actor: a, ...drawn, label, p, groundY };
  });

  // ── Streams ────────────────────────────────────────────────────────────────
  // Each edge gets a path and a pool of particles that ride it on a loop. The
  // path itself stays faint: the movement is the message, not the line.
  const PARTICLES_PER_STREAM = 7;

  const streams = edges.map((e, ei) => {
    const a = pos[e.from], b = pos[e.to];
    // Bow the path slightly so two streams into the same target stay distinct.
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 + (ei % 2 === 0 ? -1 : 1) * 26;

    const guide = svgEl('path', {
      d: `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`,
      fill: 'none', stroke: INK, 'stroke-width': 1.1,
      'stroke-dasharray': '3 7', opacity: 0,
    });
    world.appendChild(guide);

    const dots = [];
    for (let i = 0; i < PARTICLES_PER_STREAM; i++) {
      const dot = svgEl('circle', { r: 3.2, fill: INK, opacity: 0 });
      world.appendChild(dot);
      dots.push(dot);
    }

    const label = svgEl('text', {
      x: mx, y: my - 10,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: INK, 'font-size': 17, 'font-weight': 600,
      'font-family': "'Caveat', cursive", opacity: 0,
    });
    label.textContent = e.label;
    world.appendChild(label);

    return { a, b, mx, my, guide, dots, label };
  });

  // ── Outputs ────────────────────────────────────────────────────────────────
  // Same flowing particles as an input, but leaving the diagram instead of arriving
  // at another named thing. They fan to the RIGHT because the band layout puts the
  // sky upper-left and the below-ground band underneath, so the right side is where
  // the free space reliably is.
  const outStreams = outputs.map((o, oi) => {
    const src = pos[o.from];
    // Spread the fan around horizontal: one output goes straight out, several
    // splay apart so their labels don't stack.
    const spread = outputs.length === 1 ? 0 : (oi / (outputs.length - 1) - 0.5) * 1.15;
    const angle = -spread;
    const reach = Math.min(190, W - src.x - 70);

    const endX = src.x + Math.cos(angle) * reach;
    const endY = src.y + Math.sin(angle) * reach;
    const mx = (src.x + endX) / 2;
    const my = (src.y + endY) / 2 - 16;

    const guide = svgEl('path', {
      d: `M ${src.x} ${src.y} Q ${mx} ${my} ${endX} ${endY}`,
      fill: 'none', stroke: INK, 'stroke-width': 1.1,
      'stroke-dasharray': '3 7', opacity: 0,
    });
    world.appendChild(guide);

    const dots = [];
    for (let i = 0; i < PARTICLES_PER_STREAM; i++) {
      const dot = svgEl('circle', { r: 3.2, fill: INK, opacity: 0 });
      world.appendChild(dot);
      dots.push(dot);
    }

    // The label sits at the far end — an output is named by where it arrives, not
    // by the middle of its path.
    const label = svgEl('text', {
      x: endX, y: endY - 16,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: INK, 'font-size': 16, 'font-weight': 600,
      'font-family': "'Caveat', cursive", opacity: 0,
    });
    label.textContent = o.label;
    world.appendChild(label);

    return { a: src, b: { x: endX, y: endY }, mx, my, guide, dots, label };
  });

  // Inputs and outputs animate through exactly the same loop from here on.
  const allStreams = streams.concat(outStreams);

  // ── Detail callouts ────────────────────────────────────────────────────────
  // A magnified circle beside the thing it belongs to, joined by a curved leader.
  //
  // Placement pushes AWAY from the canvas centre: the source object is somewhere in
  // the middle of the layout, so the free space is at the edges. Alternating sides
  // keeps two callouts on the same object from landing on each other.
  const callouts = details.map((d, di) => {
    const src = pos[d.from];
    const R = 52;

    const awayX = src.x < W / 2 ? -1 : 1;
    const awayY = di % 2 === 0 ? -1 : 1;
    const cx = clamp(src.x + awayX * 150, R + 14, W - R - 14);
    const cy = clamp(src.y + awayY * 96, R + 14, H - R - 26);

    // Leader from the edge of the source toward the edge of the circle, bowed so it
    // reads as pointing rather than connecting.
    const ang = Math.atan2(cy - src.y, cx - src.x);
    const startX = src.x + Math.cos(ang) * (size * 0.42);
    const startY = src.y + Math.sin(ang) * (size * 0.42);
    const endX = cx - Math.cos(ang) * R;
    const endY = cy - Math.sin(ang) * R;
    const bowX = (startX + endX) / 2 + Math.sin(ang) * 34;
    const bowY = (startY + endY) / 2 - Math.cos(ang) * 34;

    const leader = rc.path(`M ${startX} ${startY} Q ${bowX} ${bowY} ${endX} ${endY}`, {
      stroke: INK, strokeWidth: 1.4, roughness: 1.2, bowing: 1,
      seed: hashSeed('leader' + di),
    });
    leader.style.opacity = 0;
    world.appendChild(leader);

    const ring = rc.circle(cx, cy, R * 2, {
      stroke: INK, strokeWidth: 1.6, roughness: 1.1, bowing: 1,
      seed: hashSeed('ring' + d.label),
    });
    ring.style.opacity = 0;
    world.appendChild(ring);

    // Contents. If the named thing is in the object library it's drawn; otherwise
    // the name alone fills the circle — an unknown term is never an error, just a
    // plainer picture.
    const inner = svgEl('g', { opacity: 0 });
    world.appendChild(inner);

    const kind = detectObject(d.label);
    let live = null;
    if (kind) {
      live = createObject(rc, inner, { kind, id: 'detail' + di, x: cx, y: cy + R * 0.44, size: R * 0.92 });
    }

    const caption = svgEl('text', {
      x: cx, y: kind ? cy + R + 16 : cy,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: INK, 'font-size': 17, 'font-weight': 600,
      'font-family': "'Caveat', cursive",
    });
    wrapText(d.label, kind ? 18 : 13, 2).forEach((t, li, arr) => {
      const tspan = svgEl('tspan', {
        x: cx,
        dy: li === 0 ? (arr.length > 1 ? -8 : 0) : 17,
      });
      tspan.textContent = t;
      inner.appendChild(caption);
      caption.appendChild(tspan);
    });

    return { leader, ring, inner, cx, cy, srcX: src.x, srcY: src.y };
  });

  container.appendChild(svg);

  let flowRaf = null;
  function runFlow(startedAt) {
    function tick(now) {
      const t = (now - startedAt) / 1000;
      for (const s of allStreams) {
        s.dots.forEach((dot, i) => {
          // Evenly spaced along the path, looping — a steady stream rather than
          // discrete deliveries, because the relationship is continuous.
          const phase = ((t * 0.32) + i / PARTICLES_PER_STREAM) % 1;
          const p = bezierPoint(s.a.x, s.a.y, s.mx, s.my, s.b.x, s.b.y, phase);
          dot.setAttribute('cx', p.x);
          dot.setAttribute('cy', p.y);
          // Fade in and out at the ends so particles don't pop at the edges.
          const edgeFade = Math.min(1, Math.min(phase, 1 - phase) / 0.16);
          dot.setAttribute('opacity', 0.72 * edgeFade);
        });
      }
      flowRaf = requestAnimationFrame(tick);
    }
    flowRaf = requestAnimationFrame(tick);
  }

  async function sequence() {
    if (flowRaf !== null) { cancelAnimationFrame(flowRaf); flowRaf = null; }
    nodes.forEach(n => { n.holder.setAttribute('opacity', 0); n.label.setAttribute('opacity', 0); });
    allStreams.forEach(s => {
      s.guide.setAttribute('opacity', 0);
      s.label.setAttribute('opacity', 0);
      s.dots.forEach(d => d.setAttribute('opacity', 0));
    });
    callouts.forEach(c => {
      c.leader.style.opacity = 0;
      c.ring.style.opacity = 0;
      c.inner.setAttribute('opacity', 0);
    });
    if (groundLine) groundLine.style.opacity = 0;
    camera.reset();

    await wait(220);

    // The ground is drawn first — it's the surface everything else stands on, so
    // establishing it before the objects is what makes them read as placed rather
    // than floating.
    if (groundLine) await drawRoughStroke(groundLine, 500, ease.outQuad);

    // Things arrive first, so the space is established before anything moves in it.
    for (const n of nodes) {
      await tweenP(380, ease.outBack, v => {
        n.holder.setAttribute('opacity', Math.min(v * 1.6, 1));
        scaleAround(n.holder, n.p.x, n.groundY, 0.74 + 0.26 * v);
      });
      await tweenP(220, ease.outCubic, v => n.label.setAttribute('opacity', v));
    }

    await wait(120);

    // Then the paths, then the flow along them.
    await tweenP(420, ease.outCubic, v => {
      allStreams.forEach(s => {
        s.guide.setAttribute('opacity', v * 0.28);
        s.label.setAttribute('opacity', v * 0.85);
      });
    });

    runFlow(performance.now());

    // Callouts come last, once the diagram they annotate exists.
    //
    // The camera pushes in on the thing being magnified BEFORE its circle is drawn.
    // That ordering is the whole effect: the viewer is moved to the leaf, and only
    // then does the detail open out of it — rather than a circle appearing beside a
    // diagram they were still looking at as a whole.
    for (const c of callouts) {
      await wait(260);

      // Frame the source and its callout together, so both stay on screen.
      const midX = (c.srcX + c.cx) / 2;
      const midY = (c.srcY + c.cy) / 2;
      await camera.moveTo(midX, midY, 1.5, 900, ease.inOutCubic);

      await drawRoughStroke(c.leader, 340, ease.outQuad);
      await drawRoughStroke(c.ring, 460, ease.outQuad);
      await tweenP(320, ease.outCubic, v => c.inner.setAttribute('opacity', v));
      await wait(700); // hold on the detail before leaving it
    }

    // Pull back to the whole picture at the end, so the last thing seen is how the
    // parts fit together.
    if (callouts.length) {
      await camera.moveTo(W / 2, H / 2, 1, 1000, ease.inOutCubic);
    }
  }

  sequence();
  return () => { sequence(); };
}

// ── Template: branch (a process that forks) ──────────────────────────────────
// For "if X then Y, otherwise Z" — the shape most explanations of logic take.
// Stages before the fork run as a normal chain; the condition then splits into
// two outcomes side by side, so the reader can see that only ONE of them happens.
function renderBranchFlow(block, container) {
  const branchStep = block.steps.find(s => s.type === 'branch');
  const elseStep = block.steps.find(s => s.type === 'branchElse');
  if (!branchStep) return;

  // Everything stated before the fork, in order.
  const branchIndex = block.steps.indexOf(branchStep);
  const leadIn = block.steps
    .slice(0, branchIndex)
    .filter(s => s.type === 'narrate' || s.type === 'state')
    .map(s => s.text || s.label)
    .filter(Boolean);

  const W = DESIGN_W;
  const H = DESIGN_H;

  const svg = makeResponsiveSvg(W, H);
  const rc = rough.svg(svg);
  svg.appendChild(svgEl('rect', { width: W, height: H, fill: '#fdfbf6' }));
  const world = svgEl('g');
  svg.appendChild(world);
  const camera = makeCamera(world, W, H);

  // Row budget: lead-in stages, the condition, then the outcome pair.
  const rows = leadIn.length + 2;
  const gap = 30;
  const boxH = Math.max(44, Math.min(56, (H - 68 - gap * (rows - 1)) / rows));
  const totalH = rows * boxH + gap * (rows - 1);
  const startY = Math.max(30, (H - totalH) / 2);

  const chainW = Math.min(420, W - 180);
  const chainX = (W - chainW) / 2;

  const drawn = [];

  function box(x, y, w, h, text, seedKey, fontSize = 16) {
    const shape = rc.rectangle(x, y, w, h, {
      stroke: INK, strokeWidth: 1.5, roughness: 1.1, bowing: 1,
      seed: hashSeed(seedKey),
    });
    shape.style.opacity = 0;
    world.appendChild(shape);

    const label = svgEl('text', {
      x: x + w / 2, y: y + h / 2,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      fill: INK, 'font-size': fontSize, 'font-weight': 600,
      'font-family': "'Caveat', cursive", opacity: 0,
    });
    const lines = wrapText(text, Math.floor(w / (fontSize * 0.5)), 2);
    lines.forEach((t, li) => {
      const tspan = svgEl('tspan', { x: x + w / 2, dy: li === 0 ? (lines.length > 1 ? -8 : 0) : 17 });
      tspan.textContent = t;
      label.appendChild(tspan);
    });
    world.appendChild(label);

    return { shape, label };
  }

  function connector(x1, y1, x2, y2, seedKey, tag) {
    const midY = (y1 + y2) / 2;
    const line = rc.path(`M ${x1} ${y1} Q ${x1} ${midY} ${x2} ${y2}`, {
      stroke: INK, strokeWidth: 1.5, roughness: 1.2, bowing: 1,
      seed: hashSeed(seedKey),
    });
    line.style.opacity = 0;
    world.appendChild(line);

    const head = svgEl('path', {
      d: `M ${x2 - 4} ${y2 - 7} L ${x2 + 4} ${y2 - 7} L ${x2} ${y2} z`,
      fill: INK, opacity: 0,
    });
    world.appendChild(head);

    // "yes" / "no" is what makes the fork read as a decision rather than two
    // unrelated boxes that happen to sit side by side.
    let mark = null;
    if (tag) {
      mark = svgEl('text', {
        x: (x1 + x2) / 2 + (x2 < x1 ? -16 : 16), y: midY,
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        fill: INK, 'font-size': 14, 'font-weight': 600,
        'font-family': "'Caveat', cursive", opacity: 0,
      });
      mark.textContent = tag;
      world.appendChild(mark);
    }

    return { line, head, mark };
  }

  // Lead-in chain.
  let y = startY;
  let prevBottom = null;
  for (let i = 0; i < leadIn.length; i++) {
    const b = box(chainX, y, chainW, boxH, leadIn[i], 'lead' + i);
    const conn = prevBottom === null ? null
      : connector(W / 2, prevBottom, W / 2, y, 'leadconn' + i, null);
    drawn.push({ kind: 'stage', box: b, conn });
    prevBottom = y + boxH;
    y += boxH + gap;
  }

  // The condition.
  const condBox = box(chainX, y, chainW, boxH, branchStep.condition + '?', 'cond', 17);
  const condConn = prevBottom === null ? null
    : connector(W / 2, prevBottom, W / 2, y, 'condconn', null);
  drawn.push({ kind: 'stage', box: condBox, conn: condConn });
  const condBottom = y + boxH;
  y += boxH + gap;

  // The two outcomes, side by side — the layout is the point: only one happens.
  const outW = Math.min(300, (W - 90) / 2 - 14);
  const leftX = W / 2 - outW - 16;
  const rightX = W / 2 + 16;

  const yesBox = box(leftX, y, outW, boxH, branchStep.text, 'yes');
  const yesConn = connector(W / 2 - 20, condBottom, leftX + outW / 2, y, 'yesconn', 'yes');

  let noBox = null, noConn = null;
  if (elseStep) {
    noBox = box(rightX, y, outW, boxH, elseStep.text, 'no');
    noConn = connector(W / 2 + 20, condBottom, rightX + outW / 2, y, 'noconn', 'no');
  }

  container.appendChild(svg);

  async function revealBox(b) {
    await drawRoughStroke(b.shape, 380, ease.outQuad);
    await tweenP(240, ease.outCubic, v => b.label.setAttribute('opacity', v));
  }

  async function revealConn(c) {
    if (!c) return;
    await drawRoughStroke(c.line, 220, ease.outQuad);
    await tweenP(140, ease.outBack, v => {
      c.head.setAttribute('opacity', v);
      if (c.mark) c.mark.setAttribute('opacity', v);
    });
  }

  async function sequence() {
    const all = [...drawn.map(d => d.box), yesBox, noBox].filter(Boolean);
    all.forEach(b => { b.shape.style.opacity = 0; b.label.setAttribute('opacity', 0); });
    [...drawn.map(d => d.conn), yesConn, noConn].filter(Boolean).forEach(c => {
      c.line.style.opacity = 0;
      c.head.setAttribute('opacity', 0);
      if (c.mark) c.mark.setAttribute('opacity', 0);
    });
    camera.reset();

    await wait(220);

    for (const d of drawn) {
      await revealConn(d.conn);
      await revealBox(d.box);
    }

    // Each path is traced separately. Showing both at once would undercut the
    // one thing the diagram exists to say: these are alternatives, not steps.
    await wait(220);
    await revealConn(yesConn);
    await revealBox(yesBox);

    if (noBox) {
      await wait(320);
      await revealConn(noConn);
      await revealBox(noBox);
    }
  }

  sequence();
  return () => { sequence(); };
}
