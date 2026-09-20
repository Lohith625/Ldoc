# LDOC - Living Documents

Write plain text. Get an animated, hand-drawn explainer document.

**[Watch the live animated showcase](https://lohith625.github.io/Ldoc/)**

LDOC reads a `.ldoc` file and renders it live in VS Code — styled prose, plus
diagrams that draw themselves. You never pick a chart type or tag a style: the
**shape of what you wrote** decides the picture.

## Quick start

1. Install LDOC in VS Code.
2. Create a file ending in `.ldoc`.
3. Paste the example below. The preview opens automatically beside your `.ldoc` file.

```text
# Java basics

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

To disable automatic opening, turn off **LDOC: Auto Preview** in Settings. You can still run **LDOC: Open Preview** manually.

No API key is needed. Edit the bullets to update the preview. Use **LDOC: Export to HTML**
for an offline, shareable animation.

## Writing a document

Ordinary Markdown works, with a few conventions given richer meaning:

| You write | You get |
|---|---|
| `# Heading` | Large hero heading |
| `## Heading` | Section heading |
| `---` | Section break |
| `> text` | Callout box (`>[green]`, `>[amber]`, `>[red]`, `>[blue]` for colour) |
| Two or more `Label: value` lines | A stats row |
| `- item`, indented for nesting | Bullet list |
| `**bold**` `*italic*` `~~strike~~` `` `code` `` links | Inline formatting |

## Animations

Wrap a description in `@animate` … `@end`. The diagram is chosen from the
structure of what you wrote:

**Name actors that talk to each other → a sequence diagram**

```
@animate
browser: Browser
api: API Server

browser sends GET /users to api
api replies 200 JSON to browser
connection established
@end
```

**Name things where flow only runs one way → a scene**

```
@animate
sun: Sunlight
tree: Oak Tree

sun sends ENERGY to tree
@end
```

**Name two things that don't interact → a comparison**

```
@animate
Before: slow, manual, error-prone
After: fast, automated, repeatable
@end
```

**Write plain statements → a process flow**

```
@animate
Water travels up from the roots
CO2 enters through the stomata
Glucose is built and stored
@end
```

**End with "and it repeats" → a cycle**

```
@animate
Water evaporates from the ocean
Clouds release rain over land
Rivers carry it back to the sea
and the cycle repeats
@end
```

### Things are drawn as what they are

An actor named `user` becomes a figure; `database` becomes a cylinder; `tree`,
`sun`, `cloud`, `water`, `server`, `screen` and others become themselves.
Anything unrecognised falls back to a labelled box — a less specific picture,
never an error.

## Usage

Open a `.ldoc` file and click **Open Preview** in the editor title bar, or run
**LDOC: Open Preview** from the Command Palette. The preview updates as you type.

Animations start when you scroll to them, so a long document doesn't play
everything at once.

## Optional: write plain English instead

LDOC works completely without AI. If you'd rather not learn the syntax, you can
bring your own API key and have a model write it for you.

1. Run **LDOC: Set Up AI** from the Command Palette. Choose a provider, enter a model ID and paste your API key. For a compatible service, also enter its base URL; local models can use an empty key.
2. Select a paragraph (or place the cursor in it) and run **LDOC: Generate Animation from Text (AI)**.
3. LDOC inserts the block, shows a success message and opens the preview at that animation. It uses the same renderer as handwritten LDOC.

If the cursor is on a heading or blank line, the command asks what you want
explained. **Open Preview** only renders existing blocks; it does not call an AI
provider. Simple technical chains use numbered cards and animated handoffs;
natural scenes keep their spatial layout, and conversations use sequence diagrams.

> When a user logs in, the web app checks their credentials against the auth
> service, which looks them up in the database and returns a token.

…becomes a valid `@animate` block, inserted below your text.

The output is checked for missing participants and unsupported structures. LDOC asks
for one correction if needed, and leaves your document unchanged if that also fails.
If you edit the source while generation runs, the result opens in a new unsaved
document instead of being inserted at an outdated location. Each provider request
has a 60-second timeout; transient failures can be retried.

Only the selected paragraph (or current paragraph), the grammar instructions, and
any correction request are sent to your chosen provider. Generation uses your
provider account and may incur its normal API charges. Rendering and export stay offline.

### Drawing objects that aren't in the library

Thirteen objects ship built in, including **cache, queue, router and book**.
`Redis` draws a cache, `Kafka` a queue, `gateway` a router, and `textbook` a book.
Run **LDOC: Draw an Object (AI)**, type a noun, and
it becomes drawable in every diagram from then on:

```
@animate
bird: Sparrow
tree: Oak Tree
bird sends SEEDS to tree
@end
```

The drawing is **generated once and cached forever** — after that it renders
offline like any built-in shape, costs nothing, and is baked into exported HTML.
Remove any of them with **LDOC: Forget Generated Shapes**.

Generated shapes are drawn with lighter roughness than the hand-drawn library.
They carry finer detail, and the library's usual jitter would close the gaps
between nearby lines into a scribble.

**What the AI does and doesn't do.** The model only writes LDOC syntax and shape
outlines — it never touches rendering. It cannot choose colours, positions, timings or diagram types,
because those are decided by the renderer from the structure of what was written.
So AI removes the need to learn the syntax; it does **not** unlock different
visuals. The same diagrams are available either way.

Supported providers: Anthropic, OpenAI, Gemini, or any OpenAI-compatible endpoint
— including a local model through Ollama or LM Studio, which costs nothing and
keeps your documents off third-party servers.

Your key is stored in VS Code's **SecretStorage**, never in `settings.json`.
Keys are separate for each provider and each compatible endpoint. **LDOC: Set API Key**
replaces the current provider's key; **LDOC: Clear Stored API Key** removes it.

## Try this build

Mind maps use a heading and nested bullets inside `@animate`. RoughJS draws the
surrounding branches and explanations without additional layout commands.

## Showcase

The [showcase](examples/github-showcase/README.md) includes a mind map, decision
flow chart, system flow, science explanations, a distributed-system sequence and a camera journey. Each example includes
editable LDOC and a PNG for GitHub or social posts. Use **LDOC: Export to HTML**
to create an offline animation from any example.

| Mind map | Flow chart |
|---|---|
| ![How the Web Works mind map](examples/github-showcase/assets/mindmap.png) | ![Pull-request quality gate](examples/github-showcase/assets/flow-chart.png) |

| System flow | Science cycle |
|---|---|
| ![E-commerce system flow](examples/github-showcase/assets/system-flow.png) | ![The water cycle explained with LDOC](examples/github-showcase/assets/water-cycle.png) |

| Science process | Distributed system |
|---|---|
| ![Photosynthesis explained with LDOC](examples/github-showcase/assets/photosynthesis.png) | ![Distributed login sequence](examples/github-showcase/assets/distributed-system.png) |

### Camera movement

[Follow a web request through six components](examples/github-showcase/camera-journey.ldoc). The camera follows each stage and arrow downward, then zooms out to show the complete journey.

![Web-request journey with camera movement](examples/github-showcase/assets/camera-journey.png)

Mind maps use `parent includes child` between defined topics. Use one root and one
parent per child; cycles and disconnected topics are rejected. The AI grammar also
supports this relationship.

Start with `examples/github-showcase/mindmap.ldoc`, then try
`examples/github-showcase/flow-chart.ldoc` and `examples/github-showcase/distributed-system.ldoc`.
Sequence diagrams keep participants visible and moving reply labels upright.

For development, run `npm test` to compile and run the regression suite. The optional
`node tests/browser-check.cjs` checks the standalone export in headless Chrome and
writes screenshots to a temporary directory. Set `CHROME_PATH` if Chrome is not
installed at the default Windows location. Live provider access requires your key;
the automated provider tests use mocked responses.

## Notes

- Rendering is deterministic — the same document always produces the same
  animation. Nothing is generated by a model at render time, with or without a key.
- The extension needs no network connection. Both the preview and exported HTML
  run fully offline; the handwritten font is embedded, not fetched.
- Diagrams are drawn in a hand-sketched style using
  [Rough.js](https://roughjs.com), bundled with the extension.

## Current limitations

This is the first public version. LDOC supports structured explanations, not arbitrary
cinematic animation. Large maps get smaller when fitted into a narrow preview; split
long lessons into concise diagrams. `moves` and `appears` are not supported actions.
Architecture boundaries and arbitrary system graphs are not yet dedicated templates.
GitHub Markdown does not play LDOC exports directly: use an image, or host the exported HTML.
AI generation depends on the chosen provider and may need a model ID available to your account.

## Feedback

Try explaining one concept or change with LDOC. Share what you wrote, what you expected,
and where you got stuck. When reporting an AI problem, include the provider/model and
error message, but never your API key. Issue templates are included for the public repository.

## License

MIT

