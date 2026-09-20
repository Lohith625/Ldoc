# LDOC Format Specification

**Version 0.1.0**

LDOC is a plain-text document format. It renders as styled prose plus animated,
hand-drawn diagrams. Unlike MDX it contains no components and no code — the
renderer infers everything from the shape of what you wrote.

This document is written to be complete enough that a language model can author
valid `.ldoc` files from it without seeing examples of the output.

---

## 1. Core principle

**The author describes what happens. The renderer decides how to draw it.**

There are no style tags, no diagram-type declarations, no component names. Every
visual decision is derived from structure. When generating LDOC, never invent a
directive to control appearance — it will render as literal text.

Rendering is deterministic: the same document always produces the same output.

---

## 2. Document syntax

A `.ldoc` file is line-oriented. Blank lines separate blocks.

### 2.1 Headings

```
# Large hero heading
## Section heading
```

`#` is always hero-weight, at any position, however many times it appears.
`##` is always a normal section heading. Heading level is the only signal —
position in the document does not change the treatment.

Deeper levels (`###`+) are not defined and render as paragraph text.

### 2.2 Section break

```
---
```

On its own line. Splits the document into visually separate sections.

### 2.3 Paragraphs

Any line that matches nothing else is prose. **Consecutive lines join into one
paragraph**; a blank line starts a new one — as in Markdown.

### 2.4 Callouts

```
> A highlighted note.
> Consecutive lines join into one callout.

>[green] Coloured variant
>[amber] Warning-flavoured
>[red]   Problem-flavoured
>[blue]  Informational
```

Plain `>` uses the default (green). Only those four colour names are recognised;
any other name falls back to the default.

### 2.5 Stats row

**Two or more consecutive** `Label: value` lines become a row of label/value
pairs:

```
Protocol: TCP
Layer: Transport
Steps: 3
```

A label must be 24 characters or fewer. A **single** such line on its own is not
enough — it renders as an ordinary paragraph.

### 2.6 Lists

```
- item
- another item
  - nested item (two spaces per level)

1. ordered item
2. second item
```

`-` and `*` produce bullets; `1.` style produces numbers. Nesting is by
two-space indentation.

### 2.7 Code blocks

````
```js
const x = 1;
if (x > 0) run();
```
````

The language after the opening fence is optional and shown as a small label.
**Everything inside is literal** — no inline formatting is applied, so `#`, `*`
and backticks inside code survive as themselves. Long lines scroll within the
block.

### 2.8 Tables

```
| Name | Role |
|------|------|
| Ada  | Dev  |
| Bob  | Ops  |
```

The `|---|` separator row is **required** — without it the line is treated as
ordinary prose, so a sentence containing a pipe is never mistaken for a table.
Outer pipes are optional. Inline formatting works inside cells.

### 2.9 Inline formatting

Valid inside any prose, heading, list item, callout or stat value:

| Syntax | Result |
|---|---|
| `**bold**` | bold |
| `*italic*` | italic |
| `~~strike~~` | strikethrough |
| `` `code` `` | inline code |
| `[text](url)` | link |

---

## 3. Animation blocks

```
@animate
...body...
@end
```

Both markers sit on their own lines. A document may contain any number of blocks.

The **body determines which of five diagrams is produced.** This is the most
important part of the format to understand when generating LDOC.

### 3.1 Body grammar

**Actor definition** — a single-word key, a colon, then a label:

```
client: Browser
db: Database
```

The key must be **one word** (letters, digits, underscore). `Manual deploys: fast`
will NOT define an actor — it falls through to narration. Use `manual: fast, cheap`.

**Steps:**

| Line | Meaning |
|---|---|
| `x sends LABEL to y` | message from x to y |
| `x replies LABEL to y` | reply from x to y |
| `x connects to y` | connection from x to y |
| `connection established` / `connected` / `handshake complete` | final state banner |
| `highlight x` | draws attention to x |
| `x contains y` / `x holds y` | detail callout — y magnified in a circle beside x |
| `x produces y` / `x releases y` | an output flowing out of x |
| `if CONDITION then OUTCOME` | a fork in a process |
| `otherwise OUTCOME` / `else OUTCOME` | the other branch of that fork |
| `pause` / `wait` / `delay` | a beat |
| anything else | narration text |

**Detail callouts** are the scientific-illustration convention of magnifying part
of a diagram in a circle joined by a curved leader. The thing named after
`contains` is free text, not an actor — it needn't take part in the diagram:

```
leaf contains chloroplasts
```

If the named thing matches an object keyword (§5) it is drawn inside the circle;
otherwise the name alone fills it.

**Outputs** are the counterpart to `sends` — a flow leaving the diagram rather than
travelling to another named thing. Together they describe a transformation without
needing a verb for it, because the arrows already say it:

```
sun sends LIGHT to plant       ← input
water sends WATER to plant     ← input
plant produces GLUCOSE         ← output
plant releases OXYGEN          ← output
```

Do **not** write `x transforms A using B` — it is not supported, and it restates
what the inward arrows already show.

Blocks using `contains` or free-standing `produces` outputs render as a **scene**.
One exception: a simple technical chain of 2–6 participants renders as numbered
cards with animated handoffs. In that chain, `server produces screen` connects to
the declared `screen` participant. Natural objects retain the spatial scene layout.

Actor names in steps must match a defined key, lowercase-insensitively.

`x moves to y` and `x appears` are **not** supported and render as narration.

---

## 4. Diagram selection

Evaluated in this exact order:

```
1. actors defined?
   ├─ yes
   │   ├─ any "contains" or "produces" line ......... SCENE
   │   ├─ exactly 2 actors AND zero messages ......... COMPARISON
   │   ├─ messages exist, none are replies,
   │   │   and no pair talks both ways ............... SCENE
   │   └─ otherwise ................................. SEQUENCE
   └─ no
       ├─ any "if … then …" line .................... BRANCH
       ├─ last line matches a cycle phrase
       │   AND 4+ statement lines .................... CYCLE
       └─ otherwise ................................. PROCESS FLOW
```

### 4.1 Sequence — a conversation

Actors in a row, messages travelling between them along a timeline.
**Use when things exchange messages back and forth.**

```
@animate
browser: Browser
api: API Server

browser sends GET /users to api
api replies 200 JSON to browser
connection established
@end
```

### 4.2 Scene — a one-way flow

Things placed in space, with continuous streams flowing between them.
**Use when nothing replies** — sunlight reaching a leaf, water feeding a root.
Triggered by having zero `replies` lines and no two-way pair.

```
@animate
sun: Sunlight
tree: Oak Tree

sun sends ENERGY to tree
@end
```

### 4.3 Comparison — two things held side by side

Exactly two actors and **no steps at all**. Each label is split on commas into
that panel's bullet points.

```
@animate
Before: slow, manual, error-prone
After: fast, automated, repeatable
@end
```

### 4.4 Process flow — ordered stages

No actors; a run of plain statements. Each becomes a numbered stage in a chain.

```
@animate
Water travels up from the roots
CO2 enters through the stomata
Glucose is built and stored
@end
```

### 4.5 Branch — a process that forks

Statements with **no actors**, where one line is `if … then …`. Stages before the
fork run as a chain; the condition then splits into two outcomes side by side, so
it reads that only *one* of them happens.

The `then` keyword is **required** — it is what separates the condition from the
outcome.

```
@animate
A request arrives at the gateway
The token is checked
if the token is valid then the request continues to the service
otherwise the request is rejected with 401
@end
```

### 4.6 Cycle — a process that returns to its start

Like a process flow, but the **final line** signals looping. That line is
consumed as a marker and is **not drawn as a stage**.

Recognised phrases (final line only): `repeat`/`repeats`, `cycle`/`cycles`,
`loop`/`loops`, `starts again`, `begins again`, `back to the start`, `over again`.

Requires **at least 4 lines** total (3 stages + the marker).

```
@animate
Water evaporates from the ocean
Clouds release rain over land
Rivers carry it back to the sea
and the cycle repeats
@end
```

---

## 5. How things are drawn

An actor is drawn as the thing it names. Matching is by keyword against the
actor's key **and** label; person is checked first.

**Person → animated figure:**
`user`, `person`, `people`, `customer`, `student`, `visitor`, `reader`, `human`,
`employee`, `teacher`, `doctor`, `alice`, `bob`, `carol`, `dave`, `eve`

**Object → that shape:**

| Shape | Keywords |
|---|---|
| tree | `tree`, `trees`, `forest`, `plant`, `plants`, `wood` |
| leaf | `leaf`, `leaves`, `foliage` |
| water | `water`, `ocean`, `sea`, `river`, `lake`, `rain`, `wave(s)`, `liquid` |
| sun | `sun`, `sunlight`, `sunshine`, `solar`, `daylight` |
| cloud | `cloud`, `clouds`, `vapour`, `vapor`, `sky`, `atmosphere` |
| mountain | `mountain(s)`, `hill(s)`, `terrain` |
| database | `database`, `db`, `datastore`, `storage`, `store`, `table` |
| server | `server`, `backend`, `host`, `api`, `service`, `cluster` |
| cache | `cache`, `caches`, `redis`, `memcached` |
| queue | `queue`, `queues`, `broker`, `kafka`, `rabbitmq` |
| router | `router`, `routers`, `gateway`, `switch` |
| book | `book`, `books`, `textbook`, `textbooks` |
| screen | `browser`, `screen`, `laptop`, `computer`, `monitor`, `phone`, `device`, `client` |

Anything unmatched becomes a labelled box. **This is never an error** — just a
less specific picture. Choosing actor names from the lists above produces a
richer diagram.

---

## 6. Motion

Camera movement and curved paths are not applied to every diagram — a block must
be large enough to justify them, or the motion reads as fidgeting:

- **Process flow / cycle:** 5 or more stages
- **Sequence:** larger exchanges use a slower pacing profile, but the camera stays
  at the full frame so participants remain visible. Message labels stay upright.

Smaller diagrams render with straight connectors and a still camera. This is
automatic and cannot be overridden.

---

## 7. Guidance for generating LDOC

### Mind maps

Use `parent includes child` between defined participant keys. A block containing
these relationships renders a mind map: branches draw outward from the root, then
topics fade in level by level. Do not mix these relationships with messages or
scene details. Every topic must connect to one root; each non-root topic has one
parent, and cycles are invalid. `contains` retains its scene-detail meaning.

```text
@animate
root: Learning a concept
read: Read an explanation
try: Try an exercise
root includes read
root includes try
@end
```

### Generation guidance

1. **Pick the diagram by structure, not by wish.** One-way sends become a spatial
   scene or, for a simple technical chain, numbered cards. Include replies for a sequence.
2. **Keep actor keys to one word.** Multi-word keys silently become narration.
3. **Name actors from the keyword lists** in §5 to get real shapes.
4. **Keep stage text short** — roughly 8 words. Longer text is truncated with an
   ellipsis inside its box.
5. **A cycle's marker line must be last**, and there must be at least three real
   stages before it.
6. **Never invent directives.** There is no `style:`, no `@scene`, no
   `<Component/>`. Anything unrecognised renders as literal text.
7. **Two or more `Label: value` lines in prose become a stats row** — if you want
   them as a sentence, don't stack them.

### Complete example

```
# How a Web Request Works

Every page load is a short conversation between several systems.

Protocol: HTTPS
Round trips: 3

> The browser never speaks to the database directly.

@animate
user: Reader
browser: Browser
api: API Server
db: Database

user sends CLICK to browser
browser sends GET /page to api
api sends QUERY to db
db replies ROWS to api
api replies HTML to browser
@end

---

## Where the energy comes from

@animate
sun: Sunlight
tree: Oak Tree
water: Groundwater

sun sends ENERGY to tree
water sends MOISTURE to tree
@end
```


## Simple outline mind maps

Inside an `@animate` block, a `# Heading` followed by bullets describes a mind map.
Top-level bullets surround the central topic in clockwise order; indent child bullets with two spaces per level. Branch width, height and distance from the centre adapt to content. Neighbouring branches move when needed to avoid overlapping boxes or obstructed connectors. Width is capped so long paragraphs wrap rather than creating extremely wide boxes.
The heading and bullets compile to the existing participants/includes tree. The
renderer draws compact RoughJS branches with their short supporting points.

```text
@animate
# Java basics
- Integer division
  - 7 / 2 gives 3
- Type promotion
  - 7 / 2.0 gives 3.5
- Casting
  - Cast before division
@end
```

Long explanations remain in the surrounding document. For large topics, use several
small maps instead of squeezing a full lesson into one diagram. The earlier rich-card
fields and HTML-card renderer have been removed. Existing `includes` maps still work.
