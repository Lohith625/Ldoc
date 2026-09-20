const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { root, exporter, loadHost } = require('./helpers.cjs');
const { validateBlock, generateAnimation, generateObjectPaths } = require('../out/llm.js');
const config = { provider: 'openai', apiKey: 'test-secret', model: 'test-model' };
const good = '@animate\nclient: Browser\nserver: API\nclient sends REQUEST to server\nserver replies OK to client\n@end';

test('auto preview opens on activation and document switches, respects setting and repeated focus', () => {
  let changed, enabled = true;
  const calls = [];
  const editor = id => ({document:{languageId:'ldoc',uri:{toString:()=>id}}});
  const first=editor('first');
  const host=loadHost('extension',{
    commands:{registerCommand:()=>({}),executeCommand:(...args)=>{calls.push(args);return Promise.resolve();}},
    window:{activeTextEditor:first,onDidChangeActiveTextEditor:callback=>{changed=callback;return {};}},
    workspace:{onDidChangeTextDocument:()=>({}),getConfiguration:()=>({get:()=>enabled})},
  });
  host.activate({subscriptions:[]});
  assert.equal(calls.length,1);assert.equal(calls[0][0],'ldoc.showPreview');assert.equal(calls[0][2],true);
  changed(undefined);changed(first);assert.equal(calls.length,1);
  changed(editor('second'));assert.equal(calls.length,2);
  enabled=false;changed(editor('third'));assert.equal(calls.length,2);
  enabled=true;changed(editor('third'));assert.equal(calls.length,3);
  changed({document:{languageId:'typescript',fileName:'file.ts'}});assert.equal(calls.length,3);
});

test('outline branches surround the topic without overlapping as the map grows', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'engine/renderer-2d.js'), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '') + '\nthis.layout = layoutOutlineBranches;', context);
  for (const count of [1, 2, 3, 4, 8, 12, 16]) {
    const branches = Array.from({length: count}, (_, i) => ({height: 90 + i % 4 * 35}));
    const {W,H,rootX,rootY} = context.layout(branches,236,210,80);
    const boxes = [{x:rootX-105,y:rootY,width:210,height:80}, ...branches.map(branch=>({...branch,width:236}))];
    for (const [i, a] of boxes.entries()) {
      assert.ok(a.x >= 0 && a.y >= 0 && a.x+a.width <= W && a.y+a.height <= H);
      for (const b of boxes.slice(i+1)) assert.ok(a.x+a.width <= b.x || b.x+b.width <= a.x || a.y+a.height <= b.y || b.y+b.height <= a.y, `overlap with ${count} branches`);
    }
    if (count >= 3) {
      assert.ok(branches.some(branch=>branch.y+branch.height < rootY));
      assert.ok(branches.some(branch=>branch.y > rootY+80));
      assert.ok(branches.some(branch=>branch.x+236 < rootX));
      assert.ok(branches.some(branch=>branch.x > rootX));
    }
  }
});

test('long branches resize and move outward; shrinking restores compact positions', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(root,'engine/renderer-2d.js'),'utf8').replace(/^import .*$/gm,'').replace(/^export /gm,'')+'\nthis.layout=layoutOutlineBranches;',context);
  const short = Array.from({length:8},()=>({width:236,height:95}));
  const original = context.layout(short,236,210,80);
  const grown = Array.from({length:8},(_,i)=>({width:i===2?360:236,height:i===2?620:95}));
  const changed = context.layout(grown,236,210,80);
  assert.ok(grown[2].x-changed.rootX > short[2].x-original.rootX, 'growing right-hand branch must move away from the root');
  assert.ok(changed.W < 20000 && changed.H < 20000, 'layout must converge without runaway expansion');
  for (const [i,a] of grown.entries()) for (const b of grown.slice(i+1)) assert.ok(a.x+a.width<=b.x || b.x+b.width<=a.x || a.y+a.height<=b.y || b.y+b.height<=a.y);
  const shrunk=Array.from({length:8},()=>({width:236,height:95}));
  const restored=context.layout(shrunk,236,210,80);
  assert.equal(restored.W,original.W);assert.equal(restored.H,original.H);
  assert.deepEqual(shrunk,short);
});

test('simple outlines preserve indentation and validate their hierarchy', async () => {
  const { parse } = await import(pathToFileURL(path.join(root, 'engine/parser.js')));
  const source = fs.readFileSync(path.join(root, 'tests/fixtures/mindmap/java-basics.ldoc'), 'utf8');
  const block = source.match(/@animate[\s\S]*?@end/)[0];
  assert.equal(validateBlock(block).ok, true);
  const parsed = parse(source).animations[0];
  assert.equal(parsed.outline, true);
  assert.equal(Object.keys(parsed.actors).length, 10);
  assert.equal(parsed.steps.filter(step => step.from === 'topic0').length, 3);
  assert.equal(parsed.steps[1].from, 'topic1');
  assert.equal(parsed.actors.topic2.label, '7 / 2 gives 3');
  for (const invalid of [block.replace('  - 7 / 2 gives 3','      - 7 / 2 gives 3'), block.replace('  - 7 / 2 gives 3','   - 7 / 2 gives 3')]) {
    assert.equal(validateBlock(invalid).ok, false);
    assert.throws(() => parse(invalid), /indent|parent/);
  }
  const flat = block.replace('  - 7 / 2 gives 3', '- 7 / 2 gives 3');
  assert.notEqual(exporter().buildSections(block), exporter().buildSections(flat), 'indent changes must restart the map in live preview');
  assert.equal(validateBlock('@animate\nroot: Root\nroot.text: Deprecated field\n@end').ok, false);
});

test('mind-map parser and validator enforce one connected tree', async () => {
  const { parse } = await import(pathToFileURL(path.join(root, 'engine/parser.js')));
  const source = '@animate\na: Root\nb: First\nc: Second\na includes b\na includes c\n@end';
  assert.equal(validateBlock(source).ok, true);
  assert.equal(parse(source).animations[0].steps[0].type, 'includes');
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'engine/renderer-2d.js'), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '') + '\nthis.tree = mindMapTree;', context);
  assert.equal(context.tree(parse(source).animations[0]).children.length, 2);
  for (const invalid of [source.replace('a includes c', 'b includes a'), source.replace('a includes c', 'a includes missing'), source.replace('a includes c', 'a sends X to c'), source.replace('a includes c', 'c includes b')]) {
    assert.equal(validateBlock(invalid).ok, false);
    assert.throws(() => context.tree(parse(invalid).animations[0]));
  }
});

test('all documentation showcase blocks validate', async () => {
  const directory = path.join(root, 'examples/github-showcase');
  for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.ldoc'))) {
    const source = fs.readFileSync(path.join(directory, name), 'utf8');
    for (const [block] of source.matchAll(/@animate[\s\S]*?@end/g)) {
      const result = validateBlock(block);
      assert.equal(result.ok, true, `${name}: ${result.reason}`);
    }
  }
});

test('AI validation rejects output that would silently lose structure', () => {
  assert.equal(validateBlock(good).ok, true);
  for (const block of [
    good.replace('to server', 'to missing'),
    '@animate\nserver: API\nclient: Browser\nclient moves to server\n@end',
    '@animate\na: A\nb: B\na contains Detail\nb replies OK to a\n@end',
    '@animate\nStart here\nif ready then continue\notherwise stop\nExtra stage\n@end',
    '@animate\na: A\na: B\n@end',
    good + '\n' + good,
  ]) assert.equal(validateBlock(block).ok, false, block);
  assert.equal(validateBlock('@animate\nBefore: server replies slowly, repeated work\nAfter: faster responses, cached work\n@end').ok, true);
});

test('invalid generation is repaired once, and shape generation has its own prompt', async t => {
  const prompts = [];
  const outputs = ['@animate\na: A\nb: B\na sends X to missing\n@end', good, 'M 0 0 L 20 -20 L -20 -20 Z'];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    prompts.push(JSON.parse(request.body).messages[0].content);
    assert.equal(request.headers.Authorization, 'Bearer test-secret');
    assert.ok(request.signal);
    return new Response(JSON.stringify({ choices: [{ message: { content: outputs.shift() } }] }));
  });
  assert.equal(await generateAnimation(config, 'A browser asks an API for a response.'), good);
  assert.match(prompts[1], /undefined participant: missing/);
  assert.deepEqual(await generateObjectPaths(config, 'kite'), ['M 0 0 L 20 -20 L -20 -20 Z']);
  assert.doesNotMatch(prompts[2], /Explanation to convert|BODY GRAMMAR/);
});

test('failed repairs stop after two responses', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'No animation' } }] }));
  });
  await assert.rejects(generateAnimation(config, 'Test'), /document was not changed/);
  assert.equal(calls, 2);
});

test('generation inserts below selected prose and avoids stale document edits', async () => {
  const commands = new Map(), edits = [], opened = [], notices = [], previews = [], prompts = [];
  const selection = { isEmpty: false, end: { line: 2, character: 20 } };
  const document = { version: 1, isClosed: false, getText: () => 'Explain a browser request' };
  const editor = { selection, document, edit: async callback => { callback({ insert: (position, text) => edits.push({ position, text }) }); return true; } };
  let mutate = false;
  const host = loadHost('extension', {
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return {}; }, executeCommand: async (...args) => previews.push(args) },
    workspace: { onDidChangeTextDocument: () => ({}), openTextDocument: async content => { opened.push(content); return content; } },
    window: { onDidChangeActiveTextEditor: () => ({}), activeTextEditor: editor, withProgress: async (_, callback) => callback(), showTextDocument: async () => {}, showInputBox: async () => 'Explain a browser request', showInformationMessage: message => notices.push(message), showErrorMessage: message => { throw new Error(message); } },
    ProgressLocation: { Notification: 1 },
  }, '', {
    './ai-setup': { getLlmConfig: async () => config },
    './llm': { generateAnimation: async (_, prose) => { prompts.push(prose); if (mutate) document.version++; return good; } },
  });
  host.activate({ subscriptions: [] });
  assert.ok(commands.has('ldoc.setupAI'));
  await commands.get('ldoc.generateAnimation')();
  assert.equal(edits.length, 1);
  assert.equal(edits[0].position, selection.end);
  assert.equal(edits[0].text, `\n\n${good}\n`);
  assert.equal(previews[0][0], 'ldoc.showPreview');
  assert.ok(previews[0][1], 'preview should focus on the generated animation');
  mutate = true;
  await commands.get('ldoc.generateAnimation')();
  assert.equal(edits.length, 1);
  assert.equal(opened[0].content, good);
  assert.match(notices.at(-1), /source changed/);
  mutate = false;
  document.getText = () => '# Just a title';
  await commands.get('ldoc.generateAnimation')();
  assert.equal(prompts.at(-1), 'Explain a browser request', 'a heading should ask for a real explanation');
  document.getText = () => good;
  const before = prompts.length;
  await commands.get('ldoc.generateAnimation')();
  assert.equal(prompts.length, before, 'existing blocks should not be sent for generation again');
  assert.match(notices.at(-1), /already an animation block/);
});

test('technical chains connect named outputs; natural scenes and replies keep their templates', async () => {
  const { parse } = await import(pathToFileURL(path.join(root, 'engine/parser.js')));
  const { detectObject } = await import(pathToFileURL(path.join(root, 'engine/objects.js')));
  const context = { detectObject };
  const source = fs.readFileSync(path.join(root, 'engine/renderer-2d.js'), 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '');
  vm.runInNewContext(source + '\nthis.asPipeline = asPipeline;', context);
  const technical = '@animate\nuser: Developer\nlaptop: Code Editor\nserver: LDOC Engine\nscreen: Live Preview\nuser sends script to laptop\nlaptop sends AST to server\nserver produces screen\n@end';
  const chain = context.asPipeline(parse(technical).animations[0]);
  assert.equal(chain.map(stage => stage.actor.id).join(','), 'user,laptop,server,screen');
  assert.equal(chain[3].caption, 'Output');
  assert.equal(context.asPipeline(parse(good).animations[0]), null);
  assert.equal(context.asPipeline(parse('@animate\nsun: Sunlight\ntree: Plant\nsun sends ENERGY to tree\n@end').animations[0]), null);
  assert.equal(context.asPipeline(parse(technical.replace('server produces screen', 'server produces SVG')).animations[0]), null);
});

test('all providers send the same grammar and compatible local requests omit authorization', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, ...options };
    return new Response(JSON.stringify({ content: [{ type: 'text', text: good }], candidates: [{ content: { parts: [{ text: good }] } }], choices: [{ message: { content: good } }] }));
  });
  for (const provider of ['anthropic', 'gemini', 'openai-compatible']) {
    assert.equal(await generateAnimation({ ...config, provider, apiKey: provider === 'openai-compatible' ? '' : config.apiKey }, 'Explain this exchange'), good);
    assert.match(request.body, /BODY GRAMMAR/);
    if (provider === 'openai-compatible') assert.equal(request.headers.Authorization, undefined);
    if (provider === 'anthropic') assert.equal(request.headers['x-api-key'], config.apiKey);
  }
});

test('setup scopes keys by provider and compatible endpoint; cancellation leaves settings intact', async () => {
  const values = { 'llm.provider': 'openai', 'llm.model': 'test-model', 'llm.baseUrl': '' };
  const secrets = new Map([['ldoc.llm.apiKey', 'existing-openai-key']]);
  const context = { secrets: { get: async key => secrets.get(key), store: async (key, value) => secrets.set(key, value), delete: async key => secrets.delete(key) } };
  let answers = [];
  const host = loadHost('ai-setup', {
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => values[key] ?? fallback, inspect: () => ({}), update: async (key, value) => { values[key] = value; } }) },
    window: { showQuickPick: async () => ({ label: 'gemini' }), showInputBox: async () => answers.shift(), showInformationMessage: () => {} },
  });
  assert.equal((await host.getLlmConfig(context)).apiKey, 'existing-openai-key');
  assert.equal(await host.setupAI(context), undefined);
  assert.equal(values['llm.provider'], 'openai');
  answers = ['chosen-gemini-model', 'gemini-secret'];
  await host.setupAI(context);
  assert.equal((await host.getLlmConfig(context)).apiKey, 'gemini-secret');
  values['llm.provider'] = 'openai';
  assert.equal((await host.getLlmConfig(context)).apiKey, 'existing-openai-key');
  assert.notEqual(host.keyName('openai-compatible', 'https://a.example/v1'), host.keyName('openai-compatible', 'https://b.example/v1'));
  assert.equal(host.keyName('openai-compatible', 'https://a.example/v1/'), host.keyName('openai-compatible', 'https://a.example/v1'));
});

test('parser agrees with document slots around code examples and action words in labels', async () => {
  const { parse } = await import(pathToFileURL(path.join(root, 'engine/parser.js')));
  const source = '# Example\n```ldoc\n' + good + '\n```\n\n@animate\nBefore: server replies slowly\nAfter: faster responses\n@end';
  const doc = parse(source);
  assert.equal(doc.animations.length, 1);
  assert.equal(doc.animations[0].actors.before.label, 'server replies slowly');
  assert.equal((exporter().buildSections(source).match(/class="ldoc-animation"/g) || []).length, 1);
});

test('new object keywords win over generic server names', async () => {
  const { detectObject, objectKinds, registerShape } = await import(pathToFileURL(path.join(root, 'engine/objects.js')));
  for (const [name, kind] of [['Redis cache server', 'cache'], ['Kafka broker service', 'queue'], ['API gateway', 'router'], ['Textbook', 'book']]) assert.equal(detectObject(name), kind);
  assert.equal(objectKinds().length, 13);
  registerShape('[', ['M 0 0 L 1 1']);
  assert.equal(detectObject('unrecognised'), null);
});

test('export embeds real engine, font, shapes and safe source without external imports', async () => {
  const html = await exporter().buildStandaloneHtml(good + '\n</script><script>throw 123</script>', path.join(root, 'engine'), 'Release review');
  const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0][1]));
  assert.doesNotMatch(scripts[0][1], /^import /m);
  assert.match(html, /data:font\/woff2;base64/);
  assert.match(html, /cache\(rc, s, o\)/);
  assert.match(html, /\\u003c\/script>/);
});
