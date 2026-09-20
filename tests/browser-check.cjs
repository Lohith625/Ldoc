// Optional integration check: CHROME_PATH can point to Chrome/Chromium on any OS.
// Runs the real standalone export. Writes review artifacts to LDOC_REVIEW_DIR or temp.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { root, exporter } = require('./helpers.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const output = process.env.LDOC_REVIEW_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'ldoc-browser-'));
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ldoc-chrome-'));
  const html = await exporter().buildStandaloneHtml(fs.readFileSync(path.join(__dirname, 'visual-fixture.ldoc'), 'utf8'), path.join(root, 'engine'), 'LDOC release review');
  const filename = path.join(output, 'release-review.html');
  fs.writeFileSync(filename, html);
  const chrome = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  let socket;
  try {
    let launchError;
    chrome.on('error', error => { launchError = error; });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; !fs.existsSync(portFile) && i < 100; i++) {
      if (launchError) throw launchError;
      await delay(100);
    }
    assert.ok(fs.existsSync(portFile), 'Chrome did not start');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const pending = new Map(), errors = [];
    socket.onclose = () => { for (const callback of pending.values()) callback.reject(new Error('Chrome disconnected')); pending.clear(); };
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
      const callback = pending.get(message.id);
      if (callback) { pending.delete(message.id); message.error ? callback.reject(message.error) : callback.resolve(message.result); }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Chrome timed out: ${method}`)), 15000);
      pending.set(++id, { resolve: result => { clearTimeout(timeout); resolve(result); }, reject: error => { clearTimeout(timeout); reject(error); } });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      const realNow = performance.now.bind(performance), origin = realNow();
      const raf = window.requestAnimationFrame.bind(window), timeout = window.setTimeout.bind(window);
      performance.now = () => origin + (realNow() - origin) * 10;
      window.requestAnimationFrame = cb => raf(t => cb(origin + (t - origin) * 10));
      window.setTimeout = (cb, ms, ...args) => timeout(cb, ms / 10, ...args);
    ` });
    if (process.env.LDOC_OUTLINE_MAP === '1') {
      const directory = path.join(root, 'tests/fixtures/mindmap');
      const surrounding = process.env.LDOC_SURROUNDING === '1';
      const dynamic = process.env.LDOC_DYNAMIC === '1';
      const stem = dynamic ? 'dynamic-sizing' : surrounding ? 'java-surrounding' : 'java-basics';
      const source = fs.readFileSync(path.join(directory, stem + '.ldoc'), 'utf8');
      const destination = path.join(directory, stem + '.html');
      const html = await exporter().buildStandaloneHtml(source, path.join(root, 'engine'), 'Java basics');
      fs.writeFileSync(destination, html);
      await send('Page.navigate', {url:pathToFileURL(destination).href});
      await delay(700);
      await evaluate(`document.querySelector('.ldoc-animation').scrollIntoView({block:'center'})`);
      await delay(1000);
      for (const width of [1100,540]) {
        await send('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false});
        await delay(150);
        const state = await evaluate(`(() => {
          const slot = document.querySelector('.ldoc-animation'), svg = slot.querySelector('svg');
          if (!svg) throw new Error('No SVG map');
          const r = svg.getBoundingClientRect();
          return { template:svg.dataset.template, topics:svg.querySelectorAll('[data-topic]').length,
            paths:svg.querySelectorAll('path').length, buttons:slot.querySelectorAll('button').length,
            overflow:slot.scrollWidth>slot.clientWidth+1 || slot.scrollHeight>slot.clientHeight+1,
            outside:[...svg.querySelectorAll('text')].filter(el=>{const b=el.getBoundingClientRect();return b.left<r.left||b.right>r.right||b.top<r.top||b.bottom>r.bottom;}).map(el=>el.textContent),
            hidden:[...svg.querySelectorAll('[data-topic][opacity]')].some(el=>Number(el.getAttribute('opacity'))<1),
            boxOverflow:[...svg.querySelectorAll('[data-outline-branch]')].flatMap(group=>{
              const x=Number(group.dataset.boxX),y=Number(group.dataset.boxY),w=Number(group.dataset.boxWidth),h=Number(group.dataset.boxHeight);
              return [...group.querySelectorAll('text')].filter(text=>{const b=text.getBBox();return b.x<x+5||b.y<y+5||b.x+b.width>x+w-5||b.y+b.height>y+h-5;}).map(text=>text.textContent);
            }),
            clip:{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1}};
        })()`);
        assert.equal(state.template,'outline-mindmap');assert.equal(state.topics,dynamic ? 16 : surrounding ? 18 : 10);assert.ok(state.paths>10);
        assert.equal(state.buttons,0);assert.equal(state.overflow,false,JSON.stringify(state));assert.deepEqual(state.outside,[]);assert.equal(state.hidden,false);
        assert.deepEqual(state.boxOverflow,[], 'text must stay inside its own branch box');
        const shot=await send('Page.captureScreenshot',{format:'png',clip:state.clip,captureBeyondViewport:true});
        fs.writeFileSync(path.join(directory,(dynamic?'dynamic-':surrounding?'surrounding-':'')+(width===540?'narrow.png':'overview.png')),Buffer.from(shot.data,'base64'));
      }
      if (dynamic) {
        const readBoxes = () => evaluate(`(() => {const svg=document.querySelector('.ldoc-animation svg'),v=svg.viewBox.baseVal;return [...svg.querySelectorAll('[data-outline-branch]')].map(el=>({x:Number(el.dataset.boxX)-v.width/2,y:Number(el.dataset.boxY)-v.height/2,width:Number(el.dataset.boxWidth),height:Number(el.dataset.boxHeight)}));})()`);
        const grown = await readBoxes();
        const shorter = source.replace('Caching and keeping stored responses up to date','Caching').replace('A cached response can avoid repeating an expensive database query when the requested data has not changed','Reuse a response').replace('When the source data changes, invalidate the affected cache entry so the next request rebuilds it from current data','Invalidate stale entries');
        const tempFile=path.join(output,'shortened-map.html');
        fs.writeFileSync(tempFile,await exporter().buildStandaloneHtml(shorter,path.join(root,'engine'),'Shortened map'));
        await send('Page.navigate',{url:pathToFileURL(tempFile).href});await delay(600);
        await evaluate(`document.querySelector('.ldoc-animation').scrollIntoView({block:'center'})`);await delay(1000);
        const shrunk=await readBoxes();
        assert.ok(grown[2].height>shrunk[2].height);assert.ok(grown[2].width>shrunk[2].width);
        assert.ok(Math.hypot(grown[2].x+grown[2].width/2,grown[2].y+grown[2].height/2)>Math.hypot(shrunk[2].x+shrunk[2].width/2,shrunk[2].y+shrunk[2].height/2));
        console.log('Dynamic resizing verified: longer content grows width/height and moves the branch outward; shortening pulls it back.');
      }
      assert.deepEqual(errors,[]);
      console.log('Outline map passed: expected topics, RoughJS SVG paths, no extra controls, all text visible, no scrolling at wide and narrow widths.');
      await send('Browser.close');return;
    }
    if (process.env.LDOC_SHOWCASE === '1') {
      const directory = path.join(root, 'examples/github-showcase');
      const assets = path.join(directory, 'assets'); fs.mkdirSync(assets, { recursive: true });
      for (const name of ['mindmap', 'flow-chart', 'system-flow', 'water-cycle', 'photosynthesis', 'distributed-system', 'camera-journey']) {
        const source = fs.readFileSync(path.join(directory, name + '.ldoc'), 'utf8');
        const destination = path.join(output, name + '.html');
        fs.writeFileSync(destination, await exporter().buildStandaloneHtml(source, path.join(root, 'engine'), name));
        await send('Page.navigate', { url: pathToFileURL(destination).href });
        await delay(500);
        await evaluate(`document.querySelector('.ldoc-animation').scrollIntoView({block:'center'})`);
        if (name === 'camera-journey') {
          const cameraFrames = new Set();
          for (let frame = 0; frame < 45; frame++) {
            cameraFrames.add(await evaluate(`document.querySelector('.ldoc-animation svg > g[transform]')?.getAttribute('transform') || ''`));
            await delay(100);
          }
          assert.ok(cameraFrames.size >= 4, `camera did not visibly move: ${[...cameraFrames]}`);
          await delay(3500);
        } else {
          await delay(8000);
        }
        const state = await evaluate(`(() => {
          const svg = document.querySelector('.ldoc-animation svg');
          if (!svg) throw new Error('No rendered diagram');
          const r = svg.getBoundingClientRect();
          const topics = [...svg.querySelectorAll('[data-topic]')];
          return { clip: { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, scale: 1 }, topics: topics.length, hidden: topics.some(el => el.hasAttribute('opacity') && Number(el.getAttribute('opacity')) < 1), outside: topics.some(el => { const box = el.getBoundingClientRect(); return box.left < r.left || box.right > r.right || box.top < r.top || box.bottom > r.bottom; }) };
        })()`);
        if (name === 'mindmap') { assert.ok(state.topics >= 9, JSON.stringify(state)); assert.equal(state.hidden, false, JSON.stringify(state)); assert.equal(state.outside, false, JSON.stringify(state)); }
        const screenshot = await send('Page.captureScreenshot', { format: 'png', clip: state.clip, captureBeyondViewport: true });
        fs.writeFileSync(path.join(assets, name + '.png'), Buffer.from(screenshot.data, 'base64'));
      }
      assert.deepEqual(errors, [], 'showcase runtime errors');
      console.log('Seven showcase HTML exports and PNG diagrams generated; browser checks passed.');
      await send('Browser.close');
      return;
    }
    await send('Page.navigate', { url: pathToFileURL(filename).href });
    await delay(1600);
    const comparison = await evaluate(`(() => {
      const slot = document.querySelector('.ldoc-animation');
      return [...slot.querySelectorAll('tspan')].map(el => el.textContent).join(' ');
    })()`);
    assert.match(comparison, /repeat requests served from cache/);
    const compareShot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, 'comparison.png'), Buffer.from(compareShot.data, 'base64'));
    await evaluate(`document.querySelectorAll('.ldoc-animation')[1].scrollIntoView({block:'center'})`);
    let checked = 0;
    for (let i = 0; i < 30; i++) {
      await delay(150);
      const state = await evaluate(`(() => {
        const slot = document.querySelectorAll('.ldoc-animation')[1], frame = slot.getBoundingClientRect();
        const labels = [...slot.querySelectorAll('text')].filter(el => ['Lesson Book','API Gateway','Redis Cache','Event Queue'].includes(el.textContent));
        return { count: labels.length, outside: labels.filter(el => { const r = el.getBoundingClientRect(); return r.left < frame.left || r.right > frame.right || r.top < frame.top || r.bottom > frame.bottom; }).map(el => el.textContent), rotated: [...slot.querySelectorAll('[transform]')].some(el => /rotate\\(81/.test(el.getAttribute('transform'))) };
      })()`);
      if (state.count === 4) { checked++; assert.deepEqual(state.outside, []); }
      assert.equal(state.rotated, false);
    }
    assert.ok(checked > 10, 'sequence participants were not rendered');
    const sequenceShot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, 'sequence.png'), Buffer.from(sequenceShot.data, 'base64'));
    await evaluate(`document.querySelectorAll('.ldoc-animation')[2].scrollIntoView({block:'center'})`);
    await delay(1500);
    const pipeline = await evaluate(`(() => {
      const svg = document.querySelector('svg[data-template="pipeline"]');
      if (!svg) return null;
      const frame = svg.getBoundingClientRect();
      const cards = [...svg.querySelectorAll('[data-actor]')];
      return { actors: cards.map(card => card.dataset.actor), faded: cards.some(card => Number(card.getAttribute('opacity')) < 1), outside: cards.some(card => { const r = card.getBoundingClientRect(); return r.left < frame.left || r.right > frame.right || r.top < frame.top || r.bottom > frame.bottom; }) };
    })()`);
    assert.deepEqual(pipeline.actors, ['user', 'laptop', 'server', 'screen']);
    assert.equal(pipeline.faded, false);
    assert.equal(pipeline.outside, false);
    const clip = await evaluate(`(() => { const r = document.querySelector('svg[data-template="pipeline"]').getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height, scale: 1 }; })()`);
    const pipelineShot = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
    fs.writeFileSync(path.join(output, 'pipeline.png'), Buffer.from(pipelineShot.data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', { width: 540, height: 800, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.querySelector('.ldoc-animation').scrollIntoView({block:'center'})`);
    await delay(200);
    const narrowShot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, 'comparison-narrow.png'), Buffer.from(narrowShot.data, 'base64'));
    assert.deepEqual(errors, [], 'browser runtime errors');
    console.log(`Browser checks passed: complete comparison text, visible participants, upright reply labels, technical pipeline cards, no runtime errors. Artifacts: ${output}`);
    await send('Browser.close');
  } finally {
    if (socket) socket.close();
    chrome.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });



