const fs = require('node:fs');
const path = require('node:path');
const { root, exporter } = require('../tests/helpers.cjs');

const examples = [
  ['mindmap', 'How the Web Works', 'Mind map'],
  ['flow-chart', 'Pull Request Quality Gate', 'Flow chart'],
  ['system-flow', 'What Happens After You Click Buy?', 'System flow'],
  ['water-cycle', 'The Water Cycle', 'Science cycle'],
  ['photosynthesis', 'Photosynthesis', 'Science process'],
  ['distributed-system', 'Login Across a Distributed System', 'Architecture sequence'],
  ['camera-journey', 'Follow a Web Request', 'Moving camera'],
];

async function main() {
const sourceDir = path.join(root, 'examples', 'github-showcase');
const siteDir = path.join(root, '_site');
const assetDir = path.join(siteDir, 'assets');
fs.rmSync(siteDir, { recursive: true, force: true });
fs.mkdirSync(assetDir, { recursive: true });

const cards = [];
for (const [slug, title, kind] of examples) {
  const source = fs.readFileSync(path.join(sourceDir, `${slug}.ldoc`), 'utf8');
  fs.writeFileSync(
    path.join(siteDir, `${slug}.html`),
    await exporter().buildStandaloneHtml(source, path.join(root, 'engine'), title),
  );
  fs.copyFileSync(path.join(sourceDir, 'assets', `${slug}.png`), path.join(assetDir, `${slug}.png`));
  cards.push(`<article><a href="${slug}.html"><img src="assets/${slug}.png" alt="${title}"></a><div><span>${kind}</span><h2>${title}</h2><a class="play" href="${slug}.html">Play animation →</a></div></article>`);
}

fs.writeFileSync(path.join(siteDir, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LDOC animated showcase</title><style>
:root{color-scheme:light;--ink:#17212b;--accent:#087f8c;--paper:#f7f3e9}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,sans-serif}header{max-width:1100px;margin:auto;padding:64px 24px 34px;text-align:center}h1{font-size:clamp(2.5rem,7vw,5rem);margin:0;letter-spacing:-.06em}header p{font-size:1.2rem;max-width:680px;margin:16px auto}.grid{max-width:1100px;margin:auto;padding:20px 24px 80px;display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:24px}article{background:#fff;border:1px solid #17212b22;border-radius:18px;overflow:hidden;box-shadow:0 8px 28px #17212b12}article img{display:block;width:100%;aspect-ratio:760/440;object-fit:cover;border-bottom:1px solid #17212b18}article div{padding:20px}span{color:var(--accent);font-weight:700;text-transform:uppercase;font-size:.75rem;letter-spacing:.08em}h2{margin:5px 0 16px;font-size:1.25rem}.play{color:var(--accent);font-weight:700;text-decoration:none}.repo{color:inherit}footer{text-align:center;padding:0 24px 50px}
</style></head><body><header><h1>LDOC</h1><p>Living documents that turn simple text into animated, hand-drawn explanations. Choose an example to watch it render.</p><a class="repo" href="https://github.com/Lohith625/Ldoc">View source on GitHub</a></header><main class="grid">${cards.join('')}</main><footer>Rendered deterministically with LDOC and RoughJS.</footer></body></html>`);

fs.writeFileSync(path.join(siteDir, '.nojekyll'), '');
console.log(`Built ${examples.length} animated showcase pages in ${siteDir}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
