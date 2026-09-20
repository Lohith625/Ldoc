// LDOC Parser
// Reads a .ldoc file and returns a structured animation description.
// No dependencies. Runs in browser or Node.

export function parse(source) {
  let fenced = false;
  const rawLines = source.split(/\r?\n/).filter(raw => {
    const line = raw.trim();
    if (line.startsWith('```')) { fenced = !fenced; return false; }
    return !fenced && line !== '';
  });
  const lines = rawLines.map(line => line.trim());

  const doc = {
    title: '',
    description: '',
    animations: [],  // one per @animate...@end block
  };

  let i = 0;

  // Title — only if the document actually opens with a heading.
  //
  // This used to scan FORWARD for the first '#' line anywhere in the document. When
  // a file had no heading at all, that scan ran to the end and every @animate block
  // after it was skipped — a file with an animation but no title silently rendered
  // nothing. Checking only the first line keeps a headless document parseable.
  if (lines.length > 0 && lines[0].startsWith('#')) {
    doc.title = lines[0].replace(/^#+\s*/, '').trim();
    i = 1;
  }

  // Description — lines before first @animate
  const descLines = [];
  while (i < lines.length && !lines[i].startsWith('@animate')) {
    descLines.push(lines[i]);
    i++;
  }
  doc.description = descLines.join(' ').trim();

  // Parse each @animate block
  while (i < lines.length) {
    if (lines[i].startsWith('@animate')) {
      i++;
      const block = parseAnimateBlock(lines, i, rawLines);
      doc.animations.push(block.result);
      i = block.nextIndex;
    } else {
      i++;
    }
  }

  return doc;
}

function parseAnimateBlock(lines, start, rawLines) {
  if (/^#\s+/.test(lines[start] || '')) {
    const block = { actors: {}, steps: [], outline: true };
    const root = 'topic0';
    block.actors[root] = { id: root, label: lines[start].replace(/^#\s+/, ''), role: 'node' };
    const stack = [root];
    let i = start + 1, count = 1;
    while (i < lines.length && !lines[i].startsWith('@end')) {
      const match = rawLines[i].match(/^( *)(?:-|\*)\s+(.+)$/);
      if (!match || match[1].length % 2) throw new Error('Mind maps use bullets indented with two spaces per level.');
      const depth = match[1].length / 2 + 1;
      if (depth > stack.length) throw new Error('A nested bullet needs a parent at the previous level.');
      const id = `topic${count++}`;
      block.actors[id] = { id, label: match[2].trim(), role: 'node' };
      block.steps.push({ type: 'includes', from: stack[depth - 1], to: id });
      stack[depth] = id; stack.length = depth + 1;
      i++;
    }
    if (count < 2) throw new Error('Add at least one bullet below the mind-map heading.');
    return { result: block, nextIndex: i + 1 };
  }
  const block = {
    actors: {},   // { id: { label, role } }
    steps: [],    // sequence of actions
  };

  let i = start;

  // First pass — collect actor definitions (lines with colon before any action lines)
  while (i < lines.length && !lines[i].startsWith('@end')) {
    const line = lines[i];
    // Actor definition: "name: Label"  (colon, no action keywords)
    const actorMatch = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (actorMatch) {
      const id = actorMatch[1].toLowerCase();
      block.actors[id] = { id, label: actorMatch[2].trim(), role: inferRole(id) };
      i++;
      continue;
    }

    // Action line
    const step = parseStep(line, block.actors);
    if (step) block.steps.push(step);
    i++;
  }

  return { result: block, nextIndex: i + 1 }; // skip @end
}

// ── Step parser ───────────────────────────────────────────────────────────────
function parseStep(line, actors) {
  const lower = line.toLowerCase();
  const includes = line.match(/^(\w+)\s+includes?\s+(\w+)$/i);
  if (includes) return { type: 'includes', from: includes[1].toLowerCase(), to: includes[2].toLowerCase() };

  // "X sends LABEL to Y"
  const sendMatch = line.match(/^(\w+)\s+sends?\s+(.+?)\s+to\s+(\w+)$/i);
  if (sendMatch) {
    return {
      type: 'send',
      from: sendMatch[1].toLowerCase(),
      label: sendMatch[2].trim(),
      to: sendMatch[3].toLowerCase(),
    };
  }

  // "X replies LABEL to Y"
  const replyMatch = line.match(/^(\w+)\s+repl(?:ies|y)\s+(.+?)\s+to\s+(\w+)$/i);
  if (replyMatch) {
    return {
      type: 'reply',
      from: replyMatch[1].toLowerCase(),
      label: replyMatch[2].trim(),
      to: replyMatch[3].toLowerCase(),
    };
  }

  // "X sends LABEL" (no destination — broadcast)
  const sendNoDestMatch = line.match(/^(\w+)\s+sends?\s+(.+)$/i);
  if (sendNoDestMatch && !lower.includes(' to ')) {
    return {
      type: 'send',
      from: sendNoDestMatch[1].toLowerCase(),
      label: sendNoDestMatch[2].trim(),
      to: null,
    };
  }

  // "X connects to Y" / "X connects Y"
  const connectMatch = line.match(/^(\w+)\s+connects?\s+(?:to\s+)?(\w+)$/i);
  if (connectMatch) {
    return { type: 'connect', from: connectMatch[1].toLowerCase(), to: connectMatch[2].toLowerCase() };
  }

  // "X and Y are connected" / "connection established" / "X established"
  if (/connection\s+established|connected|handshake\s+complete/i.test(line)) {
    return { type: 'state', state: 'connected', label: line };
  }

  // "X contains Y" / "X holds Y" -> a detail callout: Y is drawn magnified in a
  // circle beside X, joined by a curved leader.
  //
  // This is a CONTAINMENT relationship, structurally distinct from flow (x sends
  // to y) and conversation (x replies to y) — which is what lets the renderer pick
  // a different picture for it without the author saying so.
  //
  // The target is free text rather than an actor reference: "leaf contains
  // chloroplasts" describes what is inside, and that thing needn't be a participant
  // in the diagram.
  const containsMatch = line.match(/^(\w+)\s+(?:contains?|holds?)\s+(.+)$/i);
  if (containsMatch) {
    return {
      type: 'contains',
      from: containsMatch[1].toLowerCase(),
      label: containsMatch[2].trim(),
    };
  }

  // "if CONDITION then OUTCOME" / "otherwise OUTCOME" -> a fork in a process.
  //
  // Without these, a branching explanation was flattened into a straight chain,
  // which is worse than not supporting it: the diagram then asserts something
  // false, that both outcomes happen one after the other.
  const ifMatch = line.match(/^if\s+(.+?)\s+then\s+(.+)$/i);
  if (ifMatch) {
    return { type: 'branch', condition: ifMatch[1].trim(), text: ifMatch[2].trim() };
  }

  const elseMatch = line.match(/^(?:otherwise|else)\s*,?\s+(.+)$/i);
  if (elseMatch) {
    return { type: 'branchElse', text: elseMatch[1].trim() };
  }

  // "X produces Y" / "X releases Y" / "X emits Y" -> an output flowing out of X.
  //
  // The counterpart to "a sends X to b". Inputs were expressible and outputs were
  // not, so only two thirds of a transformation could be drawn: a process could be
  // shown being fed but never shown yielding anything. With both, the picture of a
  // transformation composes itself — arrows converging in, arrows diverging out —
  // without any verb for "transforms", which the arrows already say.
  const producesMatch = line.match(/^(\w+)\s+(?:produces?|releases?|emits?|outputs?)\s+(.+)$/i);
  if (producesMatch) {
    return {
      type: 'produces',
      from: producesMatch[1].toLowerCase(),
      label: producesMatch[2].trim(),
    };
  }

  // NOTE: "X moves to Y" and "X appears" used to be parsed into 'move' and 'appear'
  // steps here. No renderer ever implemented them, so they were silently dropped —
  // the line looked like it did something and did nothing at all, with no error.
  //
  // Removed deliberately rather than implemented: what "moves" should look like
  // differs per template and is a real design decision, not a gap to paper over.
  // Until that decision is made, these lines fall through to narration below, which
  // at least SHOWS the writer's words instead of discarding them.

  // "X highlights" / "highlight X"
  const highlightMatch = line.match(/^(?:highlight\s+)?(\w+)\s+highlights?$/i)
    || line.match(/^highlight\s+(\w+)$/i);
  if (highlightMatch) {
    return { type: 'highlight', actor: highlightMatch[1].toLowerCase() };
  }

  // "pause" / "wait"
  if (/^(?:pause|wait|delay)$/i.test(line)) {
    return { type: 'pause' };
  }

  // Anything else — treat as narration
  return { type: 'narrate', text: line };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// Distinguishes "client: Browser" (an actor definition) from a line that happens to
// contain a colon but describes an action. Keeps "moves"/"appears" in the list even
// though they no longer produce their own step types — a line using them is still
// prose about something happening, not a name for a thing.
function isActionLine(line) {
  return /\b(sends?|repl(?:ies|y)|connects?|moves?|appears?|highlights?|contains?|holds?|produces?|releases?|emits?|outputs?)\b/i.test(line);
}

function inferRole(id) {
  if (/client|browser|user|frontend/i.test(id)) return 'client';
  if (/server|backend|api|db|database/i.test(id)) return 'server';
  if (/router|switch|network|proxy|cdn/i.test(id)) return 'network';
  return 'node';
}
