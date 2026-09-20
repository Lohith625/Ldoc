/** Validate the subset of LDOC the AI is asked to emit, before editing a document. */
export function validateBlock(block: string): { ok: true } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  const lines = block.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== '@animate' || lines.at(-1) !== '@end') return fail('use exact @animate and @end markers');
  const body = lines.slice(1, -1);
  if (body.length < 2) return fail('provide at least two participants or stages');
  if (body.some(line => /^[@`]/.test(line))) return fail('return one block without extra directives or code fences');
  if (/^#\s+/.test(body[0] || '')) {
    let previous = 0, count = 0;
    for (const line of block.trim().split(/\r?\n/).filter(line => line.trim()).slice(2, -1)) {
      const bullet = /^( *)(?:-|\*)\s+(.+)$/.exec(line);
      if (!bullet || bullet[1].length % 2) return fail('use bullets with two spaces per indentation level');
      const depth = bullet[1].length / 2 + 1;
      if (depth > previous + 1) return fail('a nested bullet needs a parent');
      previous = depth; count++;
    }
    return count ? { ok: true } : fail('add a bullet below the heading');
  }
  const actors = new Set<string>();
  const actions: string[] = [];
  for (const line of body) {
    if (/^\w+\.[\w]+\s*:/.test(line)) return fail('use a heading and nested bullets for a mind map');
    const definition = /^(\w+)\s*:\s*(.+)$/.exec(line);
    if (definition) {
      if (actions.length) return fail('define every participant before its actions');
      const id = definition[1].toLowerCase();
      if (actors.has(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) return fail(`duplicate or reserved participant: ${id}`);
      actors.add(id);
    } else actions.push(line);
  }
  if (!actions.length) return actors.size === 2 ? { ok: true } : fail('a comparison needs exactly two participants');
  if (actions.some(line => /^\w+\s+includes?\s+/i.test(line))) {
    const parents = new Set<string>(), children = new Map<string, string[]>();
    for (const line of actions) {
      const match = /^(\w+)\s+includes?\s+(\w+)$/i.exec(line);
      if (!match) return fail('mind maps use only includes relationships');
      const from = match[1].toLowerCase(), to = match[2].toLowerCase();
      if (!actors.has(from) || !actors.has(to)) return fail('define every mind-map topic');
      if (parents.has(to)) return fail('each mind-map topic needs exactly one parent');
      parents.add(to); children.set(from, [...children.get(from) || [], to]);
    }
    const roots = [...actors].filter(id => !parents.has(id));
    if (roots.length !== 1) return fail('mind maps need one root and no cycles');
    const seen = new Set<string>(), pending = [roots[0]];
    while (pending.length) { const id = pending.pop()!; if (seen.has(id)) return fail('mind maps cannot contain cycles'); seen.add(id); pending.push(...children.get(id) || []); }
    return seen.size === actors.size ? { ok: true } : fail('connect every topic to the root');
  }
  let messages = 0, details = false, replies = false;
  let branch = false, otherwise = false;
  const edges = new Set<string>();
  let sceneExtras = false;
  for (const line of actions) {
    const message = /^(\w+)\s+(sends?|repl(?:ies|y))\s+(.+?)\s+to\s+(\w+)$/i.exec(line);
    const connect = /^(\w+)\s+connects?\s+(?:to\s+)?(\w+)$/i.exec(line);
    const detail = /^(\w+)\s+(?:contains?|holds?|produces?|releases?|emits?|outputs?)\s+(.+)$/i.exec(line);
    const highlight = /^highlight\s+(\w+)$/i.exec(line);
    const refs = message ? [message[1], message[4]] : connect ? [connect[1], connect[2]] : detail ? [detail[1]] : highlight ? [highlight[1]] : [];
    for (const ref of refs) if (!actors.has(ref.toLowerCase())) return fail(`undefined participant: ${ref}`);
    if (message || connect) {
      messages++;
      const from = refs[0].toLowerCase(), to = refs[1].toLowerCase();
      if (from === to) return fail('self messages are not supported yet');
      edges.add(`${from}>${to}`);
      if (message && /^repl/i.test(message[2])) replies = true;
    } else if (detail) details = true;
    else if (/^if\s+.+\s+then\s+.+$/i.test(line)) {
      if (actors.size || branch) return fail('use one fork, without participants');
      branch = true;
    } else if (/^(?:otherwise|else)\s+.+$/i.test(line)) {
      if (!branch || otherwise) return fail('place one otherwise result after the if line');
      otherwise = true;
    } else {
      if (branch) return fail('put introductory stages before the fork');
      if (/^\w+\s+(?:sends?|repl(?:ies|y)|connects?|moves?|appears?)\b/i.test(line)) return fail(`unsupported or incomplete action: ${line}`);
      sceneExtras = true;
    }
  }
  if (actors.size && !messages && !details) return fail('participants need messages or details; comparisons contain definitions only');
  const hasReverse = [...edges].some(edge => edges.has(edge.split('>').reverse().join('>')));
  const isScene = details || (messages > 0 && !replies && !hasReverse);
  if (details && (replies || hasReverse)) return fail('separate detail scenes from conversations with replies');
  if (isScene && sceneExtras) return fail('scenes support flows, contains and produces; put narration outside the block');
  return { ok: true };
}
