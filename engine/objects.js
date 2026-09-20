// LDOC — hand-drawn scene objects
//
// A library of named shapes (tree, water, sun, server, …) drawn with RoughJS, so
// a diagram can show the thing itself instead of a labelled rectangle.
//
// This is the tractable answer to "draw the objects in my explanation". Geometry
// can't be derived from an arbitrary word — but a word CAN be matched against a
// library of shapes somebody drew. Anything unmatched falls back to a plain box,
// which is what the diagrams already do, so an unknown word is never an error.
//
// Motion here is ambient rather than articulated: objects sway, drift or rotate
// as a whole. That's why they don't need the figure's frame-by-frame posing —
// nothing deforms, so a transform on the group is enough and costs nothing.
//
// Each object still gets TWO pre-drawn variants swapped slowly, purely for the
// line boil. It keeps objects and figures speaking the same visual language;
// without it, a perfectly still tree next to a boiling figure looks pasted on.

const BOIL_FPS = 3.5;

// Words → shape. Order matters: the first match wins, so put specific words
// ahead of ones that could swallow them.
const OBJECT_HINTS = [
  [/\b(cache|caches|redis|memcached)\b/i, 'cache'],
  [/\b(queue|queues|broker|kafka|rabbitmq)\b/i, 'queue'],
  [/\b(router|routers|gateway|switch)\b/i, 'router'],
  [/\b(book|books|textbook|textbooks)\b/i, 'book'],
  [/\b(tree|trees|forest|plant|plants|wood)\b/i,                      'tree'],
  [/\b(leaf|leaves|foliage)\b/i,                                      'leaf'],
  [/\b(water|ocean|sea|river|lake|rain|waves?|liquid)\b/i,            'water'],
  [/\b(sun|sunlight|sunshine|solar|daylight)\b/i,                     'sun'],
  [/\b(cloud|clouds|vapour|vapor|sky|atmosphere)\b/i,                 'cloud'],
  [/\b(mountain|mountains|hill|hills|terrain)\b/i,                    'mountain'],
  [/\b(database|db|datastore|storage|store|table)\b/i,                'database'],
  [/\b(server|backend|host|api|service|cluster)\b/i,                  'server'],
  [/\b(browser|screen|laptop|computer|monitor|phone|device|client)\b/i,'screen'],
];

// Shapes supplied at runtime for words the built-in library doesn't cover.
// Populated by the extension from its cache; empty when running offline, which is
// why an unknown word still falls back to a labelled box rather than failing.
const RUNTIME_SHAPES = new Map();

/** Registers drawn paths for a word, e.g. from the optional AI feature. */
export function registerShape(word, paths) {
  if (!/^[a-z][a-z0-9_-]*$/i.test(word) || !Array.isArray(paths) || paths.length === 0) return;
  RUNTIME_SHAPES.set(word.toLowerCase(), paths);
}

export function detectObject(text) {
  if (!text) return null;
  for (const [pattern, kind] of OBJECT_HINTS) {
    if (pattern.test(text)) return kind;
  }
  // Built-in keywords win over generated ones: a hand-drawn shape is better than
  // a generated one, and this keeps the common case identical offline and online.
  for (const word of RUNTIME_SHAPES.keys()) {
    if (new RegExp(`\\b${word}s?\\b`, 'i').test(text)) return `runtime:${word}`;
  }
  return null;
}

export function objectKinds() {
  return [...new Set(OBJECT_HINTS.map(([, kind]) => kind))];
}

function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h) % 2147483647 || 1;
}

// Every shape is drawn around an origin at its BASE CENTRE and extends upward
// (negative y) — same convention as the figures, so anything can be dropped onto
// a ground line without per-shape offset maths at the call site.
const SHAPES = {
  cache(rc, s, o) {
    return [
      rc.rectangle(-s * .38, -s * .72, s * .76, s * .58, o),
      rc.linearPath([[-s * .3, -s * .08], [s * .44, -s * .08], [s * .44, -s * .65]], o),
      rc.linearPath([[s * .06, -s * .64], [-s * .12, -s * .4], [s * .09, -s * .4], [-s * .05, -s * .2]], o),
    ];
  },

  queue(rc, s, o) {
    const els = [rc.linearPath([[-s * .48, -s * .4], [-s * .48, -s * .13], [s * .48, -s * .13], [s * .48, -s * .4]], o)];
    for (let i = 0; i < 3; i++) els.push(rc.rectangle(s * (-.37 + i * .27), -s * .67, s * .2, s * .44, o));
    els.push(rc.line(-s * .3, -s * .84, s * .3, -s * .84, o));
    els.push(rc.linearPath([[s * .2, -s * .93], [s * .3, -s * .84], [s * .2, -s * .75]], o));
    return els;
  },

  router(rc, s, o) {
    const els = [rc.rectangle(-s * .44, -s * .36, s * .88, s * .3, o)];
    for (const x of [-.3, .3]) els.push(rc.line(s * x, -s * .36, s * x, -s * .82, o));
    for (const x of [-.26, -.04, .18]) els.push(rc.rectangle(s * x, -s * .25, s * .12, s * .09, o));
    return els;
  },

  book(rc, s, o) {
    const els = [rc.path(`M 0 ${-s * .06} Q ${-s * .22} ${-s * .22} ${-s * .46} ${-s * .12} L ${-s * .46} ${-s * .78} Q ${-s * .22} ${-s * .88} 0 ${-s * .72} Q ${s * .22} ${-s * .88} ${s * .46} ${-s * .78} L ${s * .46} ${-s * .12} Q ${s * .22} ${-s * .22} 0 ${-s * .06} Z`, o),
      rc.line(0, -s * .72, 0, -s * .06, o)];
    for (const side of [-1, 1]) for (let row = 0; row < 3; row++) {
      els.push(rc.line(side * s * .1, -s * (.56 - row * .14), side * s * .35, -s * (.61 - row * .14), o));
    }
    return els;
  },

  tree(rc, s, o) {
    const els = [];
    const trunkTop = -s * 0.44;
    els.push(rc.linearPath([[-s * 0.055, 0], [-s * 0.035, trunkTop]], o));
    els.push(rc.linearPath([[s * 0.055, 0], [s * 0.035, trunkTop]], o));
    // Canopy as three overlapping blobs — reads as foliage without needing detail.
    els.push(rc.circle(0, -s * 0.66, s * 0.52, o));
    els.push(rc.circle(-s * 0.24, -s * 0.52, s * 0.36, o));
    els.push(rc.circle(s * 0.24, -s * 0.54, s * 0.34, o));
    return els;
  },

  leaf(rc, s, o) {
    const w = s * 0.32, h = s * 0.9;
    return [
      rc.path(`M 0 0 Q ${w} ${-h * 0.45} 0 ${-h} Q ${-w} ${-h * 0.45} 0 0`, o),
      rc.line(0, 0, 0, -h * 0.88, { ...o, strokeWidth: (o.strokeWidth || 1.5) * 0.7 }),
    ];
  },

  water(rc, s, o) {
    // Stacked wavy lines. Each row is sampled from a sine so the crests line up
    // into something that reads as a body of water rather than random squiggles.
    const els = [];
    const w = s * 1.15;
    for (let row = 0; row < 3; row++) {
      const y = -row * s * 0.17;
      const pts = [];
      for (let i = 0; i <= 8; i++) {
        const t = i / 8;
        pts.push([-w / 2 + t * w, y + Math.sin(t * Math.PI * 2.2 + row) * s * 0.05]);
      }
      els.push(rc.curve(pts, o));
    }
    return els;
  },

  sun(rc, s, o) {
    const els = [rc.circle(0, -s * 0.5, s * 0.5, o)];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const inner = s * 0.32, outer = s * 0.46;
      els.push(rc.line(
        Math.cos(a) * inner, -s * 0.5 + Math.sin(a) * inner,
        Math.cos(a) * outer, -s * 0.5 + Math.sin(a) * outer,
        o
      ));
    }
    return els;
  },

  cloud(rc, s, o) {
    return [
      rc.circle(-s * 0.26, -s * 0.34, s * 0.42, o),
      rc.circle(s * 0.04, -s * 0.46, s * 0.54, o),
      rc.circle(s * 0.32, -s * 0.32, s * 0.40, o),
    ];
  },

  mountain(rc, s, o) {
    return [
      rc.linearPath([
        [-s * 0.6, 0], [-s * 0.2, -s * 0.72], [s * 0.05, -s * 0.34],
        [s * 0.28, -s * 0.86], [s * 0.62, 0],
      ], o),
      // Snowline on the taller peak.
      rc.linearPath([[s * 0.16, -s * 0.56], [s * 0.28, -s * 0.86], [s * 0.4, -s * 0.56]], o),
    ];
  },

  database(rc, s, o) {
    const w = s * 0.78, h = s * 0.78, rx = w / 2, ry = s * 0.13;
    return [
      rc.ellipse(0, -h, w, ry * 2, o),
      rc.line(-rx, -h, -rx, -ry, o),
      rc.line(rx, -h, rx, -ry, o),
      rc.ellipse(0, -ry, w, ry * 2, o),
      rc.ellipse(0, -h + ry * 1.6, w * 0.99, ry * 1.9, o),
    ];
  },

  server(rc, s, o) {
    const w = s * 0.72, h = s * 0.92;
    const els = [rc.rectangle(-w / 2, -h, w, h, o)];
    for (let i = 1; i <= 3; i++) {
      const y = -h + (h / 4) * i;
      els.push(rc.line(-w / 2 + s * 0.07, y, w / 2 - s * 0.07, y, o));
    }
    return els;
  },

  screen(rc, s, o) {
    const w = s * 0.96, h = s * 0.62;
    return [
      rc.rectangle(-w / 2, -h - s * 0.14, w, h, o),
      rc.line(-s * 0.16, -s * 0.14, s * 0.16, -s * 0.14, o), // stand foot
      rc.line(0, -s * 0.14, 0, -s * 0.02, o),
    ];
  },
};

// Ambient motion per kind. `t` is seconds since start; each returns a transform
// applied to the object's inner group. Kept slow — fast ambient motion reads as
// fidgeting and pulls attention away from whatever the diagram is explaining.
const AMBIENT = {
  tree:     t => `rotate(${Math.sin(t * 0.8) * 1.6})`,
  leaf:     t => `rotate(${Math.sin(t * 1.1) * 3.5})`,
  water:    t => `translate(0 ${Math.sin(t * 1.4) * 2.2})`,
  sun:      t => `rotate(${t * 8})`,
  cloud:    t => `translate(${Math.sin(t * 0.45) * 7} ${Math.sin(t * 0.7) * 1.5})`,
  mountain: () => '',
  database: () => '',
  server:   () => '',
  screen:   () => '',
};

/**
 * Draws a named object and appends it to `parent`.
 *
 * Returns { element, stop() }. Call stop() to halt ambient motion — otherwise the
 * rAF loop keeps running after the object is gone.
 */
export function createObject(rc, parent, { kind, id = kind, x = 0, y = 0, size = 90, ink = '#1e1e1e', strokeWidth = 1.5 } = {}) {
  // A generated shape is drawn from supplied path data rather than a builder.
  //
  // It gets LIGHTER roughness than the hand-drawn library. Library shapes are a
  // few well-separated primitives, so heavy jitter reads as confident sketching;
  // generated shapes carry finer detail with curves close together, and the same
  // setting closes those gaps into a scribble. Verified by rendering both.
  const runtimeWord = typeof kind === 'string' && kind.startsWith('runtime:') ? kind.slice(8) : null;
  const runtimePaths = runtimeWord ? RUNTIME_SHAPES.get(runtimeWord) : null;

  const build = runtimePaths
    ? (rcx, s, o) => {
        // Paths are authored against a ~100-unit box; scale to the requested size.
        const k = s / 100;
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('transform', `scale(${k})`);
        for (const d of runtimePaths) {
          g.appendChild(rcx.path(d, { ...o, roughness: 0.4, bowing: 0.6 }));
        }
        return [g];
      }
    : SHAPES[kind];

  if (!build) return null;

  const root = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  root.setAttribute('transform', `translate(${x} ${y})`);
  parent.appendChild(root);

  // Inner group carries ambient motion so it composes with the root's placement
  // instead of overwriting it.
  const mover = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  root.appendChild(mover);

  // Two variants, swapped slowly, for line boil — see the note at the top.
  const variants = [0, 1].map(v => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const opts = {
      stroke: ink, strokeWidth,
      roughness: 1.15, bowing: 1.2,
      seed: hashSeed(`${id}:${kind}:${v}`),
    };
    for (const el of build(rc, size, opts)) g.appendChild(el);
    g.style.display = v === 0 ? '' : 'none';
    mover.appendChild(g);
    return g;
  });

  const ambient = AMBIENT[kind] || (() => '');
  const started = performance.now();
  let lastBoil = started;
  let boilIndex = 0;
  let rafId = null;

  function tick(now) {
    const t = (now - started) / 1000;

    const transform = ambient(t);
    if (transform) mover.setAttribute('transform', transform);

    if (now - lastBoil >= 1000 / BOIL_FPS) {
      lastBoil = now;
      boilIndex = 1 - boilIndex;
      variants.forEach((g, i) => { g.style.display = i === boilIndex ? '' : 'none'; });
    }

    rafId = requestAnimationFrame(tick);
  }
  rafId = requestAnimationFrame(tick);

  return {
    element: root,
    stop() {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    },
  };
}
