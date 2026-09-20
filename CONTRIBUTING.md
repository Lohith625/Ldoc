# Contributing

Use Node.js 22 or newer and desktop VS Code.

```powershell
npm ci
npm test
```

Open this folder in VS Code and press F5 to start the Extension Development Host.
Open an example .ldoc file there and run LDOC: Open Preview.

The host commands live in src/. The browser parser, renderer and reusable drawings
live in engine/. Keep layouts deterministic and offline. Document syntax additions
in SPEC.md and add regression tests for meaningful behavior.

The optional browser check requires Chrome and Node.js 22+:

```powershell
node tests/browser-check.cjs
```

CHROME_PATH can point to another Chrome/Chromium installation. Browser test artifacts
normally go into a temporary folder. Provider tests mock HTTP responses and need no key.
Do not put API keys in documents, fixtures, screenshots or issue reports.
