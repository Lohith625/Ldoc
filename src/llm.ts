// Optional LLM layer — turns freeform prose into a valid @animate block.
//
// ARCHITECTURE RULE, deliberately enforced here: the model is used ONLY for
// language understanding. It never touches rendering, never chooses a diagram
// type, never emits positions, colours or timings. It writes LDOC syntax; the
// deterministic renderer decides everything visual. That keeps the guarantee the
// whole project rests on — same document, same animation, every time.
//
// The extension works fully without any of this. No key means no AI, not a
// degraded product.
//
// Raw HTTP rather than a vendor SDK, for two reasons: the extension ships with
// zero runtime dependencies, and BYOK only means something if users can bring the
// key they already have — including a local model, which costs nothing and keeps
// documents off third-party servers.

import { validateBlock } from './validation';
export { validateBlock } from './validation';
export type ShapePaths = Record<string, string[]>;

export type Provider = 'anthropic' | 'openai' | 'gemini' | 'openai-compatible';

export interface LlmConfig {
  provider: Provider;
  apiKey: string;
  model: string;
  /** Base URL for `openai-compatible` (Ollama, LM Studio, a gateway, …). */
  baseUrl?: string;
}

// Defaults only — every provider's model is overridable in settings, because
// model ids change faster than an extension gets updated. Google shut down the
// Gemini 2.0 family on 2026-06-01, which is exactly the failure mode this comment
// exists to warn about: when a default stops working, the Gemini branch queries
// ListModels and reports what the user's key can actually call.
export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-4o',
  gemini: 'gemini-3.5-flash',
  'openai-compatible': 'llama3.1',
};

// The grammar the model must write. Kept deliberately tight: it lists what EXISTS
// and states plainly that anything invented will render as literal text, because
// the most common failure mode is a model inventing plausible-looking directives.
const GRAMMAR = `You convert an explanation written in plain English into an LDOC animation block.

Output ONLY the block. No prose, no markdown fences, no commentary.

FORMAT:
@animate
<body>
@end

BODY GRAMMAR — these are the ONLY valid lines:

  name: Label              define a participant (key must be ONE word)
  x sends LABEL to y       a message from x to y
  x replies LABEL to y     a reply from x to y
  x contains y             y is magnified in a detail circle beside x
  x produces y             an output flowing out of x
  x includes y             a parent topic includes a defined child topic (mind map)
  connection established   a final state banner
  highlight x              draw attention to x
  if CONDITION then RESULT a fork ("then" is required)
  otherwise RESULT         the other branch of that fork
  <any other sentence>     a stage in a step-by-step process

THE DIAGRAM IS CHOSEN FROM STRUCTURE — never state a diagram type:
  # Topic followed by nested bullets   -> simple mind map; indent children with two spaces
  only includes relationships           -> mind map (one root; one parent per child; no cycles; all topics defined)
  participants that reply to each other  -> sequence diagram
  participants where flow is one-way     -> spatial scene
  exactly two participants, no messages  -> side-by-side comparison
  plain sentences, no participants       -> process flow
  plain sentences ending "and it repeats" -> cycle
  no participants, one "if ... then ..." -> branching diagram

So: to get a comparison write two participants and no messages. To get a scene,
use only "sends" with no replies. Do not ask for a diagram type; produce the shape.

NAMING MATTERS — these words draw as real objects instead of plain boxes:
  cache/redis                  -> cache with a lightning mark
  queue/broker/kafka            -> queued messages
  router/gateway                -> network router
  book/textbook                 -> open book
  person/user/customer/student  -> a human figure
  server/backend/api/service    -> a server rack
  database/db/store             -> a cylinder
  browser/screen/laptop/client  -> a monitor
  tree/plant, leaf, water/rain/ocean, sun/sunlight, cloud/sky, mountain
Prefer these words when they fit honestly. Anything unrecognised becomes a labelled box.

RULES:
- Participant keys are ONE word. "Web App" is invalid as a key; use "web: Web App".
- Message labels should be short — 1 to 3 words.
- Keep it to 3-7 participants or 3-8 stages. Split larger explanations.
- NEVER invent syntax. There is no styling, no colours, no positions, no camera,
  no timing, no components. Anything not listed above renders as literal text.`;

// Prompt for drawing an object the library doesn't have.
//
// The constraints here are not stylistic preferences — they come from what the
// renderer can actually treat. Library objects survive a rough, hand-drawn pass
// because they're a few well-separated primitives; jitter can't merge parts that
// are far apart. A single dense outline with nested curves closes into a scribble.
// So the model is asked for shapes built the way the library is built.
const SHAPE_PROMPT = `Return SVG path data for a simple, iconic, side-on drawing of the subject.

OUTPUT: one path "d" string per line. Nothing else — no SVG tags, no markdown, no commentary.

GEOMETRY:
- Origin (0,0) is the BOTTOM CENTRE of the object.
- The drawing extends UPWARD, so y values are NEGATIVE. Never draw below y=0.
- Fit roughly within x from -50 to 50, and y from 0 to -90.

STYLE — these rules matter more than detail:
- Use 3 to 7 SEPARATE simple shapes. Do not produce one dense outline.
- Keep distinct parts at least 8 units apart. Lines closer than that will merge
  when the drawing is rendered and the shape will be lost.
- Outlines only. No fills, no shading, no hatching, no text.
- Favour clear silhouette over detail. This is read at thumbnail size.`;

/** Rejects anything that isn't usable path data before it reaches the renderer. */
export function validatePaths(paths: string[]): { ok: true } | { ok: false; reason: string } {
  if (paths.length === 0) return { ok: false, reason: 'no paths returned' };
  if (paths.length > 24) return { ok: false, reason: 'too many paths to be a simple shape' };

  for (const d of paths) {
    if (!/^[Mm]\s*-?[\d.]/.test(d.trim())) return { ok: false, reason: `path does not start with a move: "${d.slice(0, 24)}…"` };
    if (/[^MmLlHhVvCcSsQqTtAaZz0-9.,\-+\s]/.test(d)) return { ok: false, reason: 'path contains unexpected characters' };
  }

  // The convention is what lets a shape stand on a ground line with the rest of
  // the library. A drawing that runs downward would sink through the floor.
  const numbers = paths.join(' ').match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  if (numbers.length < 4) return { ok: false, reason: 'not enough coordinates' };

  return { ok: true };
}

/** Asks the model to draw a subject the built-in library doesn't cover. */
export async function generateObjectPaths(config: LlmConfig, subject: string): Promise<string[]> {
  const raw = await callModel(config, `${SHAPE_PROMPT}\n\nSubject: ${subject}`);

  const paths = raw
    .replace(/```[a-zA-Z]*\s*/g, '')
    .replace(/```/g, '')
    .split('\n')
    .map(l => l.trim())
    // Models often prefix lines with `d="` or a label like `Body:`.
    .map(l => l.replace(/^[a-zA-Z ]*[:=]\s*/, '').replace(/^d\s*=\s*/i, '').replace(/^["']|["'],?$/g, '').trim())
    // A move command is "M" followed by a coordinate. Matching on the letter
    // alone let prose through — models tend to restate the instructions, and
    // "Maintain at least 8 units apart" begins with M.
    .filter(l => /^[Mm][\s,]*-?[\d.]/.test(l))
    // Anything with letters beyond SVG path commands is a sentence that merely
    // happens to start like one.
    .filter(l => !/[a-zA-Z]/.test(l.replace(/[MmLlHhVvCcSsQqTtAaZz]/g, '')));

  const check = validatePaths(paths);
  if (!check.ok) throw new Error(`could not draw "${subject}" (${check.reason})`);
  return paths;
}

/** Strips markdown fences and any stray prose around the block. */
function extractBlock(raw: string): string {
  let text = raw.trim();

  // Models wrap output in fences constantly, whatever the instruction says.
  text = text.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '').trim();

  const start = text.indexOf('@animate');
  const end = text.lastIndexOf('@end');
  if (start === -1 || end === -1 || end < start) return text;
  return text.slice(start, end + 4).trim();
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Retries transient failures with exponential backoff.
 *
 * Overload (503) and rate limiting (429) are normal on free tiers, which are
 * served at lower priority — they say "try again shortly", not "you configured
 * something wrong". Surfacing them to the user as an error makes a working setup
 * look broken. Generation calls have no side effects, so retrying is safe.
 */
async function post(url: string, headers: Record<string, string>, body: unknown, attempt = 0): Promise<any> {
  const MAX_ATTEMPTS = 4;

  if (typeof fetch !== 'function') {
    throw new Error('this VS Code build has no fetch available (needs VS Code 1.82+ / Node 18+).');
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
  } catch (err) {
    // Node reports every transport-level failure as the bare string "fetch
    // failed" (or "terminated" when the socket drops mid-response) and hides the
    // actual reason — DNS, TLS, proxy, refused connection — in `cause`.
    const cause = (err as any)?.cause;
    const reason = cause?.message || cause?.code || (err as Error)?.message || 'unknown';

    // A dropped connection is as transient as a 503 and deserves the same
    // treatment. Only genuinely unrecoverable causes — DNS failure, refused
    // connection, TLS rejection — are worth reporting straight away; retrying
    // those just makes the user wait to read the same message.
    const permanent = /TimeoutError|timeout|ENOTFOUND|ECONNREFUSED|CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(reason);
    if (!permanent && attempt < MAX_ATTEMPTS - 1) {
      await sleep(1000 * 2 ** attempt);
      return post(url, headers, body, attempt + 1);
    }

    throw new Error(
      `could not reach the provider (${reason}). ` +
      `If you are behind a proxy, set it in VS Code's "http.proxy" setting, ` +
      `or use provider "openai-compatible" with a local model instead.`
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');

    // Transient: the provider is overloaded or throttling us, not misconfigured.
    // Back off and try again before bothering the user.
    const transient = res.status === 429 || res.status === 503 || res.status === 502 || res.status === 504;
    if (transient && attempt < MAX_ATTEMPTS - 1) {
      // Honour Retry-After when given; otherwise 1s, 2s, 4s.
      const advised = Number(res.headers.get('retry-after')) * 1000;
      await sleep(Number.isFinite(advised) && advised > 0 ? Math.min(advised, 10000) : 1000 * 2 ** attempt);
      return post(url, headers, body, attempt + 1);
    }

    // Auth failures are by far the most common BYOK problem, and the provider's
    // raw message doesn't say what to do about it in this extension.
    if (res.status === 401 || res.status === 403 || /api[_ ]?key/i.test(detail)) {
      throw new Error('the API key was rejected. Run "LDOC: Set API Key" to enter it again.');
    }
    if (res.status === 404) {
      throw new Error(`the model was not found (${res.status}). Check the "ldoc.llm.model" setting.`);
    }
    if (res.status === 429) {
      throw new Error('rate limited by the provider — quota may be exhausted. Try again later, or switch provider.');
    }
    if (res.status === 503) {
      throw new Error(
        'the model is overloaded and stayed busy across several retries. ' +
        'Free tiers are served at lower priority — try again shortly, or set ' +
        '"ldoc.llm.model" to a lighter model such as gemini-flash-lite-latest.'
      );
    }

    // Anything else is surfaced verbatim — with BYOK the failure is usually the
    // user's to fix, and a generic message hides which one it is.
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  }
  return res.json();
}

/**
 * Model ids this Gemini key can actually call.
 *
 * Availability differs per account and Google renames models over time, so a
 * hardcoded default will eventually 404 for someone. This turns that dead end
 * into a list they can copy from.
 */
async function listGeminiModels(apiKey: string): Promise<string[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
    { signal: AbortSignal.timeout(60000) }
  );
  if (!res.ok) return [];
  const json: any = await res.json();
  return (json.models ?? [])
    // Only models that can answer a prompt — the list also carries embedding
    // models, which would 404 the same way if chosen.
    .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m: any) => String(m.name).replace(/^models\//, ''))
    // Speech and image variants advertise generateContent but return audio or
    // pictures, so picking one would fail in a far more confusing way than a 404.
    .filter((id: string) => !/-(tts|image|vision|embedding|aqa)\b/.test(id))
    .sort((a: string, b: string) => {
      // "-latest" aliases first: they survive the model retirements that caused
      // this problem. Then flash, since this is short structured extraction
      // rather than reasoning, and it is the cheapest tier that does the job.
      const score = (id: string) =>
        (id.includes('-latest') ? 4 : 0) +
        (id.includes('flash') ? 2 : 0) +
        (id.includes('lite') ? -1 : 0) +
        (/preview|exp/.test(id) ? -3 : 0);
      return score(b) - score(a);
    });
}

/** Sends the prose to the configured provider and returns raw model output. */
async function callModel(config: LlmConfig, userMessage: string): Promise<string> {
  const model = config.model || DEFAULT_MODELS[config.provider];

  switch (config.provider) {
    case 'anthropic': {
      const json = await post(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
        { model, max_tokens: 2000, messages: [{ role: 'user', content: userMessage }] }
      );
      // content is an array of blocks; only the text ones carry the answer.
      return (json.content ?? [])
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('');
    }

    case 'openai':
    case 'openai-compatible': {
      const base = config.provider === 'openai'
        ? 'https://api.openai.com/v1'
        : (config.baseUrl || 'http://localhost:11434/v1').replace(/\/$/, '');
      const json = await post(
        `${base}/chat/completions`,
        // A local endpoint usually needs no key; sending an empty bearer is worse
        // than sending nothing.
        config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
        { model, messages: [{ role: 'user', content: userMessage }] }
      );
      return json.choices?.[0]?.message?.content ?? '';
    }

    case 'gemini': {
      const ask = async (id: string) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(id)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
        const json = await post(url, {}, { contents: [{ parts: [{ text: userMessage }] }] });
        return json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      };

      // Normalising matters more than it looks. Gemini accepts both
      // "gemini-2.5-flash" and "models/gemini-2.5-flash", and its docs show the
      // prefixed form — so pasting from the docs produced "models/models/…".
      // Whitespace is worse: a stray leading space URL-encodes to "%20gemini-…"
      // and 404s while ListModels still reports the clean name, which reads as
      // "the model both does and does not exist".
      const id = model.trim().replace(/^models\//, '');

      try {
        return await ask(id);
      } catch (err) {
        if (!/not found|404/i.test((err as Error).message)) throw err;

        // Model ids get retired (Google shut down the 2.0 family on 2026-06-01),
        // and availability differs per account. Rather than making the user hunt
        // for a working name, ask which ones this key can call and use one.
        const usable = await listGeminiModels(config.apiKey).catch(() => []);
        const fallback = usable.find(m => m !== id);
        if (!fallback) throw err;

        return await ask(fallback);
      }
    }
  }
}

/**
 * Converts prose into a validated @animate block.
 * Throws with a readable reason if the model produced something unusable.
 */
export async function generateAnimation(config: LlmConfig, prose: string): Promise<string> {
  const prompt = `${GRAMMAR}\n\nDefine participants first. Do not mix a detail scene with replies. Scenes contain only sends, contains and produces. Branches have one if line, one otherwise line, and any introductory stages before the if line.\n\nExplanation to convert:\n\n${prose}`;
  let request = prompt;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callModel(config, request);
    const block = extractBlock(raw);
    const check = validateBlock(block);
    if (check.ok) return block;
    if (attempt === 1) throw new Error(`the model did not produce a usable block (${check.reason}). Your document was not changed.`);
    request = `${prompt}\n\nYour previous output:\n${block}\n\nFix this validation error: ${check.reason}. Return only the corrected block.`;
  }
  throw new Error('could not generate an animation');
}
