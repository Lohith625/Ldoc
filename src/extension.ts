import * as vscode from 'vscode';
import { generateAnimation, generateObjectPaths } from './llm';
import { getLlmConfig, setupAI, setApiKey, clearApiKey } from './ai-setup';

const SHAPES_KEY = 'ldoc.generatedShapes';

type ShapeCache = Record<string, string[]>;

// Generated shapes are cached permanently, so a word is drawn once and then
// renders offline forever after. Without this the preview would re-bill on every
// keystroke, which would be both expensive and slow.
function getShapeCache(context: vscode.ExtensionContext): ShapeCache {
  return context.globalState.get<ShapeCache>(SHAPES_KEY, {});
}

let currentPanel: vscode.WebviewPanel | undefined;
let currentDocument: vscode.TextDocument | undefined;

export function activate(context: vscode.ExtensionContext) {
  const previewDisposable = vscode.commands.registerCommand('ldoc.showPreview', async (focusKey?: string, automatic = false) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('Open a .ldoc file first, then run this command.');
      return;
    }
    if (automatic && currentPanel && currentDocument?.uri.toString() === editor.document.uri.toString()) return;

    // Always create a fresh panel — avoids any chance of showing stale content
    // from a previous run if a panel was already open.
    if (currentPanel) {
      currentPanel.dispose();
    }

    // engine/ lives INSIDE the extension folder. It used to be a sibling reached via
    // '..', which worked in local dev but would have shipped broken: a packaged .vsix
    // only contains files under the extension root, so the parser, renderer and
    // vendored RoughJS would all have been missing for anyone who installed it.
    const engineUri = vscode.Uri.joinPath(context.extensionUri, 'engine');

    currentPanel = vscode.window.createWebviewPanel(
      'ldocPreview',
      'LDOC Preview',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: automatic },
      {
        enableScripts: true,            // needed to run the animation renderer
        localResourceRoots: [engineUri] // whitelists engine/ and its subfolders (incl. vendor/)
      }
    );
    currentDocument = editor.document;

    const panel = currentPanel;
    panel.onDidDispose(() => {
      if (currentPanel === panel) {
        currentPanel = undefined;
        currentDocument = undefined;
      }
    });
    try {
      const html = await buildHtml(panel, editor.document.getText(), engineUri, getShapeCache(context), typeof focusKey === 'string' ? focusKey : undefined);
      if (currentPanel === panel) panel.webview.html = html;
    } catch (err) {
      vscode.window.showErrorMessage(`LDOC preview failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Live preview. Sends only the recompiled document body — replacing webview.html
  // would tear down and restart every animation on every keystroke.
  const changeDisposable = vscode.workspace.onDidChangeTextDocument(event => {
    if (!currentPanel || !currentDocument) return;
    if (event.document.uri.toString() !== currentDocument.uri.toString()) return;

    const source = event.document.getText();
    currentPanel.webview.postMessage({
      type: 'update',
      html: buildSections(source),
      source,
    });
  });

  const exportDisposable = vscode.commands.registerCommand('ldoc.exportHtml', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('Open a .ldoc file first, then run this command.');
      return;
    }

    const engineUri = vscode.Uri.joinPath(context.extensionUri, 'engine');
    const sourcePath = editor.document.uri.path;
    const baseName = sourcePath.split('/').pop()?.replace(/\.ldoc$/i, '') || 'document';

    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(editor.document.uri, '..', `${baseName}.html`),
      filters: { 'HTML': ['html'] },
      saveLabel: 'Export',
    });
    if (!target) return; // cancelled

    try {
      const html = await buildStandaloneHtml(
        editor.document.getText(), engineUri, baseName, getShapeCache(context)
      );
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(html));

      const open = await vscode.window.showInformationMessage(
        `Exported ${baseName}.html — a single self-contained file.`,
        'Open Folder'
      );
      if (open === 'Open Folder') {
        vscode.commands.executeCommand('revealFileInOS', target);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`LDOC export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ── Optional AI: prose -> an @animate block ────────────────────────────────
  const generateDisposable = vscode.commands.registerCommand('ldoc.generateAnimation', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('Open a .ldoc file first.');
      return;
    }

    // Selected text, or the paragraph the cursor is sitting in.
    let range: vscode.Range = editor.selection;
    if (range.isEmpty) {
      const doc = editor.document;
      let start = editor.selection.active.line;
      let end = start;
      while (start > 0 && doc.lineAt(start - 1).text.trim() !== '') start--;
      while (end < doc.lineCount - 1 && doc.lineAt(end + 1).text.trim() !== '') end++;
      range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
    }

    const version = editor.document.version;
    let prose = editor.document.getText(range).trim();
    if (/^@(animate|end)\b/m.test(prose)) {
      vscode.window.showInformationMessage('This is already an animation block. Use LDOC: Open Preview to play it, or select a plain-English explanation to generate a new one.');
      return;
    }
    if (!prose || /^#{1,6}\s+[^\n]+$/.test(prose)) {
      const explanation = await vscode.window.showInputBox({
        title: 'LDOC — what should the animation explain?',
        prompt: 'Describe the steps or interactions in normal English.',
        placeHolder: 'A browser requests a page from the server, and the server returns the page.',
        ignoreFocusOut: true,
        validateInput: value => value.trim() ? undefined : 'Write a short explanation.',
      });
      if (!explanation?.trim()) return;
      prose = explanation.trim();
    }

    const config = await getLlmConfig(context).catch(err => {
      vscode.window.showErrorMessage(`LDOC: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    });
    if (!config) return; // user dismissed the key prompt

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'LDOC — generating animation…' },
      async () => {
        try {
          const block = await generateAnimation(config, prose);
          const focusKey = buildSections(block).match(/data-animation-key="([^"]+)"/)?.[1];
          if (editor.document.isClosed || editor.document.version !== version) {
            const generated = await vscode.workspace.openTextDocument({ language: 'ldoc', content: block });
            await vscode.window.showTextDocument(generated);
            vscode.window.showInformationMessage('Your source changed while AI was working. The animation is in a new unsaved document.');
            await vscode.commands.executeCommand('ldoc.showPreview', focusKey);
            return;
          }
          // Inserted BELOW the prose rather than replacing it: the explanation and
          // its diagram belong together, and silently destroying what someone wrote
          // would be a bad trade for a model that can get it wrong.
          const inserted = await editor.edit(edit => {
            edit.insert(range.end, `\n\n${block}\n`);
          });
          if (!inserted) {
            const generated = await vscode.workspace.openTextDocument({ language: 'ldoc', content: block });
            await vscode.window.showTextDocument(generated);
            vscode.window.showInformationMessage('The source could not be edited. The animation is in a new unsaved document.');
          } else {
            await vscode.window.showTextDocument(editor.document, editor.viewColumn);
            vscode.window.showInformationMessage('Animation generated below your text. Opening its preview.');
          }
          await vscode.commands.executeCommand('ldoc.showPreview', focusKey);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`LDOC: ${message}`);
        }
      }
    );
  });

  const drawObjectDisposable = vscode.commands.registerCommand('ldoc.drawObject', async () => {
    const subject = await vscode.window.showInputBox({
      title: 'LDOC — draw an object',
      prompt: 'A single noun. It becomes drawable in any diagram from now on.',
      placeHolder: 'bird, rocket, book, phone…',
      ignoreFocusOut: true,
    });
    if (!subject?.trim()) return;
    const word = subject.trim().toLowerCase().split(/\s+/)[0];
    if (!/^[a-z][a-z0-9_-]*$/.test(word)) {
      vscode.window.showErrorMessage('Use a single word containing letters, digits, hyphens or underscores.');
      return;
    }

    const config = await getLlmConfig(context).catch(err => {
      vscode.window.showErrorMessage(`LDOC: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    });
    if (!config) return;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `LDOC — drawing "${word}"…` },
      async () => {
        try {
          const paths = await generateObjectPaths(config, word);
          const cache = getShapeCache(context);
          cache[word] = paths;
          await context.globalState.update(SHAPES_KEY, cache);

          vscode.window.showInformationMessage(
            `LDOC: "${word}" can now be drawn. Reopen the preview to see it.`
          );
        } catch (err) {
          vscode.window.showErrorMessage(`LDOC: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    );
  });

  const forgetShapesDisposable = vscode.commands.registerCommand('ldoc.forgetShapes', async () => {
    const cache = getShapeCache(context);
    const words = Object.keys(cache);
    if (words.length === 0) {
      vscode.window.showInformationMessage('LDOC: no generated shapes stored.');
      return;
    }
    const picked = await vscode.window.showQuickPick(['All of them', ...words], {
      title: 'LDOC — forget generated shapes',
    });
    if (!picked) return;

    if (picked === 'All of them') {
      await context.globalState.update(SHAPES_KEY, {});
    } else {
      delete cache[picked];
      await context.globalState.update(SHAPES_KEY, cache);
    }
    vscode.window.showInformationMessage('LDOC: shape cache updated.');
  });

  const aiCommand = (name: string, action: () => Promise<unknown>) => vscode.commands.registerCommand(name, async () => {
    try { await action(); }
    catch (err) { vscode.window.showErrorMessage(`LDOC: ${err instanceof Error ? err.message : String(err)}`); }
  });
  const setupDisposable = aiCommand('ldoc.setupAI', () => setupAI(context));
  const setKeyDisposable = aiCommand('ldoc.setApiKey', () => setApiKey(context));
  const clearKeyDisposable = aiCommand('ldoc.clearApiKey', () => clearApiKey(context));

  // Open beside the source without stealing typing focus. Closing the preview
  // keeps it closed until the user switches documents or explicitly opens it.
  let lastAutoDocument: string | undefined;
  const autoPreview = (editor: vscode.TextEditor | undefined) => {
    if (!editor) return;
    if (editor.document.languageId !== 'ldoc' && !editor.document.fileName?.toLowerCase().endsWith('.ldoc')) {
      lastAutoDocument = undefined;
      return;
    }
    if (!vscode.workspace.getConfiguration('ldoc').get<boolean>('autoPreview', true)) return;
    const uri = editor.document.uri.toString();
    if (uri === lastAutoDocument) return;
    lastAutoDocument = uri;
    void vscode.commands.executeCommand('ldoc.showPreview', undefined, true);
  };
  const autoPreviewDisposable = vscode.window.onDidChangeActiveTextEditor(autoPreview);

  context.subscriptions.push(
    previewDisposable, changeDisposable, exportDisposable,
    generateDisposable, drawObjectDisposable, forgetShapesDisposable,
    setupDisposable, setKeyDisposable, clearKeyDisposable, autoPreviewDisposable
  );
  autoPreview(vscode.window.activeTextEditor);
}

export function deactivate() {}

// LDOC's compiler model: plain, real Markdown conventions, reinterpreted with
// richer meaning — the "write Markdown, get JSX-quality output" idea.
//
//   ---            section break (splits the doc into styled sections)
//   # text         hero-style heading, every time it appears
//   ## text        normal section heading
//   > text         callout / highlight box
//   two or more consecutive "Label: value" lines   auto-detected stats row
//   anything else non-blank                        paragraph
//   @animate...@end                                skipped (animation deprioritized)
//
// A "Label: value" line is one with a colon where both sides are short
// (roughly single-word-ish labels) — this heuristic is what lets stats rows
// get detected automatically, with no marker syntax needed.
const CALLOUT_COLORS: Record<string, string> = {
  green: '#00e5a0',
  amber: '#f5a524',
  red: '#f5556c',
  blue: '#3d7fff',
};

function isLabelValueLine(line: string): boolean {
  const colonIndex = line.indexOf(':');
  if (colonIndex === -1) return false;
  const label = line.slice(0, colonIndex).trim();
  const value = line.slice(colonIndex + 1).trim();
  return label.length > 0 && label.length <= 24 && value.length > 0;
}

// Short stable id for a chunk of text. Used to tell whether an @animate block's
// content actually changed between renders.
function hashKey(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// Compiles the document body to HTML. Split out from the page shell so an edit can
// send just this over postMessage instead of replacing the whole page — replacing
// the page tears down every animation, which is what made them all restart on
// every keystroke.
function buildSections(sourceText: string): string {
  // rawLines keeps leading whitespace (needed for list nesting depth);
  // lines is the trimmed version used for every other line-shape check.
  const rawLines = sourceText.split('\n').map(l => l.replace(/\r$/, ''));
  const lines = rawLines.map(l => l.trim());
  const sectionsHtml: string[] = [];
  let currentSectionParts: string[] = [];

  // Counts @animate blocks as we walk the document. Each one emits a numbered
  // placeholder div; the webview script parses the same source with engine/parser.js
  // (which also collects animations in document order) and renders animation N into
  // placeholder N. Both walk the document the same way, so the indices line up.
  let animationCount = 0;

  function flushSection() {
    if (currentSectionParts.length === 0) return;
    sectionsHtml.push(`<section class="ldoc-section">${currentSectionParts.join('\n')}</section>`);
    currentSectionParts = [];
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line === '') {
      i++;
      continue;
    }

    // @animate ... @end -> emit a sized placeholder; the webview script renders the
    // actual animation into it. The whole block is consumed here, including its body:
    // previously only the marker lines were skipped, which let block contents like
    // "client: Browser" leak out and render as a stats row.
    if (line.startsWith('@animate')) {
      const bodyStart = i + 1;
      i++;
      while (i < lines.length && !lines[i].startsWith('@end')) i++;
      const body = rawLines.slice(bodyStart, i).join('\n');
      i++; // step past @end

      // The key identifies this block BY ITS CONTENT. On a re-render the webview
      // reuses any already-playing animation whose key is unchanged, so editing
      // prose elsewhere in the document doesn't restart animations that didn't change.
      currentSectionParts.push(
        `<div class="ldoc-animation" data-animation-index="${animationCount}" data-animation-key="${hashKey(body)}"></div>`
      );
      animationCount++;
      continue;
    }

    // A stray @end with no opening @animate — ignore rather than render as text.
    if (line.startsWith('@end')) {
      i++;
      continue;
    }

    // Fenced code block. Checked BEFORE every other rule: its contents must be
    // taken literally, or a "# comment" line inside it becomes a heading and a
    // "*ptr" becomes italics. Nothing inside is inline-formatted.
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(rawLines[i]); // raw: indentation is meaningful in code
        i++;
      }
      i++; // step past the closing fence
      currentSectionParts.push(renderCode(codeLines, lang));
      continue;
    }

    // Table: a row of pipes followed by a |---|---| separator. The separator is
    // required, so a sentence that merely contains a pipe isn't mistaken for one.
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line);
      i += 2; // header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i] !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      currentSectionParts.push(renderTable(header, rows));
      continue;
    }

    if (line === '---') {
      flushSection();
      i++;
      continue;
    }

    if (line.startsWith('# ')) {
      currentSectionParts.push(renderHero(line.slice(2)));
      i++;
      continue;
    }

    if (line.startsWith('## ')) {
      currentSectionParts.push(`<h2 class="ldoc-heading">${inlineFormat(line.slice(3))}</h2>`);
      i++;
      continue;
    }

    // Callout: "> text" (default) or ">[color] text" (green/amber/red/blue).
    const calloutMatch = line.match(/^>(\[(\w+)\])?\s?(.*)$/);
    if (calloutMatch) {
      const color = calloutMatch[2];
      const quoteLines: string[] = [calloutMatch[3]];
      i++;
      while (i < lines.length) {
        const nextMatch = lines[i].match(/^>(\[(\w+)\])?\s?(.*)$/);
        if (!nextMatch) break;
        quoteLines.push(nextMatch[3]);
        i++;
      }
      currentSectionParts.push(renderCallout(quoteLines, color));
      continue;
    }

    // List: a run of "- item" / "* item" / "1. item" lines, possibly indented/nested.
    // Uses rawLines (not the trimmed "lines") so leading spaces signal nesting depth.
    const firstListLine = parseListLine(rawLines[i]);
    if (firstListLine) {
      const listLines: ListLine[] = [firstListLine];
      i++;
      while (i < lines.length && lines[i] !== '') {
        const next = parseListLine(rawLines[i]);
        if (!next) break;
        listLines.push(next);
        i++;
      }
      currentSectionParts.push(renderList(listLines));
      continue;
    }

    // Look ahead: 2+ consecutive label:value lines become an auto-detected stats row.
    if (isLabelValueLine(line)) {
      const statLines: string[] = [line];
      let j = i + 1;
      while (j < lines.length && isLabelValueLine(lines[j])) {
        statLines.push(lines[j]);
        j++;
      }
      if (statLines.length >= 2) {
        currentSectionParts.push(renderStats(statLines));
        i = j;
        continue;
      }
      // Only one label:value line found — not enough to count as a stats row,
      // fall through and render it as a normal paragraph instead.
    }

    // Plain prose. Consecutive lines JOIN into one paragraph — a blank line is what
    // starts a new one, exactly as in Markdown. Treating every line as its own
    // paragraph broke any sentence the writer had wrapped in their editor, splitting
    // it into two blocks with a gap in the middle.
    const paragraphLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i];
      // Stop at anything that starts a different kind of block, so a paragraph
      // can't swallow the heading or list that follows it.
      if (
        next === '' ||
        next === '---' ||
        next.startsWith('#') ||
        next.startsWith('>') ||
        next.startsWith('@animate') ||
        next.startsWith('@end') ||
        parseListLine(rawLines[i]) ||
        isLabelValueLine(next)
      ) break;
      paragraphLines.push(next);
      i++;
    }
    currentSectionParts.push(
      `<p class="ldoc-paragraph">${inlineFormat(paragraphLines.join(' '))}</p>`
    );
  }

  flushSection();
  return sectionsHtml.join('\n');
}

// The handwritten face used for animation labels, embedded rather than fetched.
//
// It was previously pulled from Google Fonts, which meant a document could not
// actually render fully offline — the one remaining network call in an otherwise
// self-contained file. Caveat is licensed under the SIL Open Font License, which
// permits embedding. Only the latin subset at weight 600 is included (~67KB as
// base64); the other weights and scripts were never used.
let cachedFontCss: string | null = null;

async function getFontCss(engineUri: vscode.Uri): Promise<string> {
  if (cachedFontCss !== null) return cachedFontCss;
  try {
    const b64 = (await readEngineText(engineUri, 'vendor', 'caveat-600.woff2.base64')).trim();
    cachedFontCss = `@font-face{font-family:'Caveat';font-style:normal;font-weight:600;font-display:swap;` +
      `src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
  } catch {
    // Missing font file must not break rendering — labels fall back to a generic
    // cursive face, which is a cosmetic loss, not a failure.
    cachedFontCss = '';
  }
  return cachedFontCss;
}

// Styling for the rendered document. Shared by the live preview and the
// standalone HTML export so the two can never drift apart.
const DOCUMENT_CSS = `
          body { background:#08080b; color:#f0ede6; font-family:'Segoe UI',system-ui,sans-serif; margin:0; }
          .ldoc-section { padding: 4% 8%; }

          /* Hero — adapted from ldoc/packages/renderer/src/ldoc.js's "cover" scene template */
          .ldoc-hero-name {
            font-size: clamp(40px, 7vw, 84px);
            font-weight: 800;
            line-height: 0.95;
            letter-spacing: -2px;
            margin: 0.5em 0 0.3em;
          }

          .ldoc-heading {
            font-size: clamp(22px, 3.2vw, 34px);
            font-weight: 800;
            letter-spacing: -1px;
            margin: 1.2em 0 0.4em;
          }

          .ldoc-paragraph {
            font-size: 15px;
            line-height: 1.7;
            opacity: 0.75;
            max-width: 640px;
          }

          /* Callout — reinterpreting Markdown blockquote as a highlight box.
             border-left-color / background are set inline per-instance (color variant). */
          .ldoc-callout {
            border-left: 3px solid;
            padding: 14px 20px;
            border-radius: 4px;
            margin: 1.2em 0;
            max-width: 640px;
          }
          .ldoc-callout p { margin: 0.3em 0; font-size: 14px; opacity: 0.85; }

          /* Stats/meta row — adapted from ldoc.js's .ldoc-cover-meta / .ldoc-meta-item */
          .ldoc-stats {
            display: flex;
            gap: 24px;
            flex-wrap: wrap;
            padding: 20px 0;
            margin: 1.2em 0;
            border-top: 0.5px solid rgba(255,255,255,0.08);
            border-bottom: 0.5px solid rgba(255,255,255,0.08);
          }
          .ldoc-stat-item { display: flex; flex-direction: column; gap: 3px; }
          .ldoc-stat-label { font-size: 9px; opacity: 0.4; letter-spacing: 1.5px; text-transform: uppercase; }
          .ldoc-stat-val { font-size: 13px; opacity: 0.8; }

          /* Inline formatting */
          .ldoc-link { color: #3d7fff; text-decoration: none; border-bottom: 1px solid rgba(61,127,255,0.4); }
          .ldoc-link:hover { border-bottom-color: #3d7fff; }
          .ldoc-code {
            font-family: 'Cascadia Code','Consolas',monospace;
            background: rgba(255,255,255,0.08);
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 0.9em;
          }
          del { opacity: 0.5; }

          /* Lists */
          .ldoc-list { margin: 0.6em 0; padding-left: 1.4em; max-width: 640px; }
          .ldoc-list li { font-size: 15px; line-height: 1.7; opacity: 0.8; margin: 0.2em 0; }
          .ldoc-list .ldoc-list { margin: 0.2em 0; }

          /* Fenced code block */
          .ldoc-codeblock {
            position: relative;
            background: rgba(255,255,255,0.04);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 8px;
            margin: 1.2em 0;
            max-width: 760px;
            overflow: hidden;
          }
          .ldoc-code-lang {
            font-size: 10px;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            opacity: 0.35;
            padding: 8px 16px 0;
          }
          .ldoc-codeblock pre {
            margin: 0;
            padding: 12px 16px 16px;
            /* Long lines scroll inside the block rather than stretching the page. */
            overflow-x: auto;
          }
          .ldoc-codeblock code {
            font-family: 'Cascadia Code','Consolas',monospace;
            font-size: 13px;
            line-height: 1.65;
            color: #d6d1c4;
            white-space: pre;
          }

          /* Table */
          .ldoc-table-wrap { max-width: 760px; margin: 1.2em 0; overflow-x: auto; }
          .ldoc-table { border-collapse: collapse; width: 100%; font-size: 14px; }
          .ldoc-table th, .ldoc-table td {
            text-align: left;
            padding: 9px 14px;
            border-bottom: 1px solid rgba(255,255,255,0.08);
          }
          .ldoc-table th {
            font-size: 10px;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            opacity: 0.5;
            font-weight: 600;
          }
          .ldoc-table td { opacity: 0.82; }
          .ldoc-table tr:last-child td { border-bottom: none; }

          /* Animation canvas. Needs explicit dimensions — render2D() reads
             clientWidth/clientHeight to lay out actors, and a zero-height container
             would silently produce an invisible animation.
             The renderer draws on paper-white while the document is dark, so this is
             framed as a deliberate inset "canvas" card rather than left to clash. */
          .ldoc-animation {
            width: 100%;
            max-width: 760px;
            aspect-ratio: 760 / 440;
            margin: 1.5em 0;
            border-radius: 10px;
            overflow: hidden;
            background: #fdfbf6;
            box-shadow: 0 8px 30px rgba(0,0,0,0.35);
          }
`;

// Builds the full page. Called once when the panel opens; edits afterwards go
// through postMessage and only swap the document body.
async function buildHtml(
  panel: vscode.WebviewPanel,
  sourceText: string,
  engineUri: vscode.Uri,
  shapes: ShapeCache = {},
  focusKey?: string
): Promise<string> {
  const shapesJson = scriptJson(shapes);
  const objectsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(engineUri, 'objects.js'));
  const sectionsHtml = buildSections(sourceText);
  const fontCss = await getFontCss(engineUri);

  // Real disk paths -> vscode-webview:// URIs the sandboxed page is allowed to fetch.
  // renderer-2d.js imports './vendor/rough.esm.js' relatively, which resolves against
  // its own webview URI and stays inside the whitelisted engine/ root.
  const parserUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(engineUri, 'parser.js'));
  const rendererUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(engineUri, 'renderer-2d.js'));

  // Inline <script> blocks are blocked by webview CSP unless tagged with a matching
  // one-time nonce (learned the hard way — without this they fail silently).
  const nonce = getNonce();
  const sourceJson = scriptJson(sourceText);

  return `<!DOCTYPE html>
    <html>
      <head>
        <!-- No external hosts are permitted at all. The handwritten font is embedded
             as a data: URI below rather than fetched, so the preview renders fully
             offline and the CSP needs no font/style exceptions. -->
        <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; script-src 'nonce-${nonce}' ${panel.webview.cspSource}; style-src 'unsafe-inline'; font-src data:;">
        <style>
${fontCss}
${DOCUMENT_CSS}
        </style>
      </head>
      <body>
        <div id="ldoc-root">${sectionsHtml}</div>

        <script type="module" nonce="${nonce}">
          import { parse } from '${parserUri}';
          import { render2D } from '${rendererUri}';
          import { registerShape } from '${objectsUri}';

          // Shapes drawn earlier by the AI feature, cached and replayed from disk.
          // Nothing is fetched here — this renders offline like everything else.
          for (const [word, paths] of Object.entries(${shapesJson})) registerShape(word, paths);

          const root = document.getElementById('ldoc-root');

          // parser.js walks @animate blocks in document order, and so does the
          // placeholder emitter in the extension — so animations[i] belongs in the
          // placeholder with data-animation-index="i".
          let doc = parse(${sourceJson});

          function play(slot) {
            const block = doc.animations[Number(slot.dataset.animationIndex)];
            if (!block) return;
            slot.dataset.rendered = '1';
            try {
              render2D(block, slot);
            } catch (err) {
              slot.textContent = 'Animation failed: ' + err.message;
            }
          }

          // Animations start when scrolled into view, not all at once on load —
          // otherwise every diagram runs simultaneously and has already finished by
          // the time the reader reaches it. unobserve() on first intersection means
          // each plays once on arrival, not on every pass through the viewport.
          let observer = null;
          function observeSlots() {
            const pending = root.querySelectorAll('.ldoc-animation:not([data-rendered])');
            if (!('IntersectionObserver' in window)) {
              pending.forEach(play);
              return;
            }
            if (!observer) {
              observer = new IntersectionObserver(entries => {
                for (const entry of entries) {
                  if (!entry.isIntersecting) continue;
                  observer.unobserve(entry.target);
                  play(entry.target);
                }
              }, { threshold: 0.35 });
            }
            pending.forEach(slot => observer.observe(slot));
          }

          // An edit replaces the document body, but animations whose own text didn't
          // change are carried across untouched rather than re-rendered. Typing prose
          // next to a diagram no longer restarts it — only editing the block itself does,
          // because that changes its content key.
          function applyUpdate(html, source) {
            doc = parse(source);

            const surviving = new Map();
            root.querySelectorAll('.ldoc-animation[data-rendered]').forEach(el => {
              surviving.set(el.dataset.animationKey, el);
            });

            root.innerHTML = html;

            root.querySelectorAll('.ldoc-animation').forEach(slot => {
              const kept = surviving.get(slot.dataset.animationKey);
              // Reuse only once — two blocks with identical text must not share a node.
              if (kept) {
                surviving.delete(slot.dataset.animationKey);
                slot.replaceWith(kept);
              }
            });

            observeSlots();
          }

          window.addEventListener('message', event => {
            const msg = event.data;
            if (msg && msg.type === 'update') applyUpdate(msg.html, msg.source);
          });

          const focusKey = ${scriptJson(focusKey || '')};
          const focused = [...root.querySelectorAll('.ldoc-animation')].find(slot => slot.dataset.animationKey === focusKey);
          if (focused) focused.scrollIntoView({ block: 'center' });
          observeSlots();
        </script>
      </body>
    </html>`;
}

// ── Standalone HTML export ────────────────────────────────────────────────────
//
// The engine is a set of ES modules that import each other, but an exported file
// has to be ONE self-contained document — no sibling files, no server, no build
// step. So each module is wrapped in an IIFE that returns its exports, and they
// are concatenated in dependency order.
//
// Wrapping matters, not just stripping: figure.js, objects.js and renderer-2d.js
// each define their own `hashSeed`. Plain concatenation would throw
// "Identifier 'hashSeed' has already been declared". An IIFE gives each module its
// own scope, the way the module system did.
function inlineModule(src: string, exportNames: string[]): string {
  const body = src
    .replace(/^\s*import\s[^\n]*$/gm, '') // drop import lines; deps come from outer scope
    .replace(/^export\s+/gm, '');         // drop the export keyword, keep the declaration
  return `(() => {\n${body}\nreturn { ${exportNames.join(', ')} };\n})()`;
}

async function readEngineText(engineUri: vscode.Uri, ...segments: string[]): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(engineUri, ...segments));
  return new TextDecoder().decode(bytes);
}

async function buildStandaloneHtml(sourceText: string, engineUri: vscode.Uri, title: string, shapes: ShapeCache = {}): Promise<string> {
  const [roughSrc, figureSrc, objectsSrc, parserSrc, rendererSrc] = await Promise.all([
    readEngineText(engineUri, 'vendor', 'rough.esm.js'),
    readEngineText(engineUri, 'figure.js'),
    readEngineText(engineUri, 'objects.js'),
    readEngineText(engineUri, 'parser.js'),
    readEngineText(engineUri, 'renderer-2d.js'),
  ]);

  // RoughJS's bundle ends in `export{X as default}` rather than named exports.
  const roughInline = `(() => {\n${roughSrc.replace(/export\s*\{\s*(\w+)\s+as\s+default\s*\}\s*;?/, 'return $1;')}\n})()`;

  const bundle = [
    `const rough = ${roughInline};`,
    `const { looksLikePerson, createFigure } = ${inlineModule(figureSrc, ['looksLikePerson', 'createFigure'])};`,
    `const { detectObject, createObject, objectKinds, registerShape } = ${inlineModule(objectsSrc, ['detectObject', 'createObject', 'objectKinds', 'registerShape'])};`,
    `const { parse } = ${inlineModule(parserSrc, ['parse'])};`,
    `const { render2D } = ${inlineModule(rendererSrc, ['render2D'])};`,
  ].join('\n\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${escapeHtml(title)}</title>
<style>
${await getFontCss(engineUri)}
${DOCUMENT_CSS}
</style>
</head>
<body>
<div id="ldoc-root">${buildSections(sourceText)}</div>

<script type="module">
${bundle}

// Shapes drawn earlier are baked into the file, so an export keeps its
// pictures and still needs no network.
for (const [word, paths] of Object.entries(${scriptJson(shapes)})) registerShape(word, paths);

const doc = parse(${scriptJson(sourceText)});
const root = document.getElementById('ldoc-root');

function play(slot) {
  const block = doc.animations[Number(slot.dataset.animationIndex)];
  if (!block) return;
  slot.dataset.rendered = '1';
  try { render2D(block, slot); }
  catch (err) { slot.textContent = 'Animation failed: ' + err.message; }
}

// Same behaviour as the live preview: each diagram starts when it is scrolled to,
// so a long document doesn't play everything at once before the reader arrives.
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      play(entry.target);
    }
  }, { threshold: 0.35 });
  root.querySelectorAll('.ldoc-animation').forEach(s => observer.observe(s));
} else {
  root.querySelectorAll('.ldoc-animation').forEach(play);
}
</script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

// A fenced code block. Content is escaped only — never inline-formatted, since
// backticks and asterisks inside code have to survive as themselves.
function renderCode(codeLines: string[], lang: string): string {
  const label = lang ? `<div class="ldoc-code-lang">${escapeHtml(lang)}</div>` : '';
  return `<div class="ldoc-codeblock">${label}<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre></div>`;
}

// "|---|:--:|" — the separator line that confirms a row of pipes is really a table.
function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');
}

// Splits "| a | b |" into ['a','b'], tolerating the outer pipes being absent.
function splitRow(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
}

function renderTable(header: string[], rows: string[][]): string {
  const head = header.map(c => `<th>${inlineFormat(c)}</th>`).join('');
  const body = rows
    .map(r => `<tr>${r.map(c => `<td>${inlineFormat(c)}</td>`).join('')}</tr>`)
    .join('\n');
  return `<div class="ldoc-table-wrap"><table class="ldoc-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// "# text" -> hero-style heading, every time it appears (not just once at the top).
function renderHero(title: string): string {
  return `<div class="ldoc-hero-name">${inlineFormat(title)}</div>`;
}

// Markdown blockquote ("> text") -> a bordered/tinted highlight box.
// ">[green] text" (etc) picks a preset accent color instead of the default.
function renderCallout(quoteLines: string[], color?: string): string {
  const accent = (color && CALLOUT_COLORS[color]) || CALLOUT_COLORS.green;
  const inner = quoteLines.map(l => `<p>${inlineFormat(l)}</p>`).join('\n');
  return `<div class="ldoc-callout" style="border-left-color:${accent};background:${accent}0f;">${inner}</div>`;
}

// 2+ consecutive "Label: value" lines -> a row of small label/value pairs.
function renderStats(statLines: string[]): string {
  const items = statLines.map(line => {
    const colonIndex = line.indexOf(':');
    const label = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    return { label, value };
  });

  const itemsHtml = items
    .map(({ label, value }) => `<div class="ldoc-stat-item">
      <div class="ldoc-stat-label">${inlineFormat(label)}</div>
      <div class="ldoc-stat-val">${inlineFormat(value)}</div>
    </div>`)
    .join('\n');

  return `<div class="ldoc-stats">${itemsHtml}</div>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Inline Markdown formatting, applied within a single line of text:
//   **bold**        -> <strong>
//   *italic*         -> <em>
//   ~~strikethrough~~ -> <del>
//   `code`           -> <code>
//   [text](url)      -> <a>
// HTML-escapes first so the raw text can't inject markup, then layers the
// formatting on top — order matters: links/code before bold/italic so
// "[**bold** link](url)" style nesting isn't half-broken by an earlier pass.
function inlineFormat(text: string): string {
  let html = escapeHtml(text);

  // Links: [text](url) — do this before bold/italic so an escaped "[" inside
  // link text doesn't get mistaken for emphasis markers.
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, linkText, url) => {
    const safeUrl = escapeHtml(url);
    return `<a href="${safeUrl}" class="ldoc-link" target="_blank" rel="noopener">${linkText}</a>`;
  });

  // Inline code: `code`
  html = html.replace(/`([^`]+)`/g, '<code class="ldoc-code">$1</code>');

  // Bold: **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Strikethrough: ~~text~~
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Italic: *text* (single asterisk, after bold so ** isn't consumed as * pairs)
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  return html;
}

// A single list line's indent level and content, e.g. "  - item" -> { indent: 1, text: "item" }.
interface ListLine {
  indent: number;
  text: string;
  ordered: boolean;
}

function parseListLine(rawLine: string): ListLine | null {
  const match = rawLine.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
  if (!match) return null;
  const [, indentStr, marker, text] = match;
  const indent = Math.floor(indentStr.length / 2); // 2 spaces per nesting level
  return { indent, text, ordered: /\d+\./.test(marker) };
}

// Builds nested <ul>/<ol> HTML from a flat run of list lines using their indent levels.
function renderList(listLines: ListLine[]): string {
  let html = '';
  let openLevels: boolean[] = []; // ordered-ness of each currently open <ul>/<ol>

  for (let idx = 0; idx < listLines.length; idx++) {
    const item = listLines[idx];

    while (openLevels.length > item.indent + 1) {
      html += openLevels.pop() ? '</ol>' : '</ul>';
    }
    while (openLevels.length < item.indent + 1) {
      html += item.ordered ? '<ol class="ldoc-list">' : '<ul class="ldoc-list">';
      openLevels.push(item.ordered);
    }

    html += `<li>${inlineFormat(item.text)}</li>`;
  }

  while (openLevels.length > 0) {
    html += openLevels.pop() ? '</ol>' : '</ul>';
  }

  return html;
}

// Keep document text inside the script even when it contains an HTML closing tag.
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
