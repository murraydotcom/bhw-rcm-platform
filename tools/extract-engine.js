// tools/extract-engine.js
// Extract the clean-claim scrub engine (scrubClaim + its data tables) from
// index.html into engine/themis.js, so the RCM app and the Coding Worksheet run
// the SAME engine with no drift. Runs the page's inline JS in a DOM-stubbed
// sandbox and captures the real objects — no fragile brace/regex parsing.
//   node tools/extract-engine.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// All inline <script> (no src=) blocks, concatenated in document order.
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const capture = `
;try{ globalThis.__cap = { DATA: (typeof DATA!=='undefined'?DATA:null),
  scrubClaim: (typeof scrubClaim!=='undefined'?scrubClaim:null),
  TH_SEV: (typeof TH_SEV!=='undefined'?TH_SEV:null),
  thStatus: (typeof thStatus!=='undefined'?thStatus:null) }; }catch(e){ globalThis.__capErr = e.message; }
`;
const code = scripts.join('\n;\n') + capture;

// ---- aggressive DOM / browser stubs so top-level definitions run without a real DOM
const noop = () => {};
const elStub = new Proxy({}, {
  get: (_t, k) => {
    if (k === 'style' || k === 'dataset' || k === 'classList') return elStub;
    if (k === 'appendChild' || k === 'setAttribute' || k === 'addEventListener' ||
        k === 'removeEventListener' || k === 'remove' || k === 'append' ||
        k === 'insertAdjacentHTML' || k === 'add' || k === 'toggle' || k === 'contains') return noop;
    if (k === 'querySelectorAll' || k === 'getElementsByClassName') return () => [];
    if (k === 'querySelector' || k === 'getElementById' || k === 'closest') return () => elStub;
    if (k === 'getContext') return () => elStub;
    return typeof k === 'string' ? '' : undefined;
  },
  set: () => true,
});
const documentStub = {
  querySelectorAll: () => [], querySelector: () => elStub, getElementById: () => elStub,
  getElementsByClassName: () => [], createElement: () => elStub, addEventListener: noop,
  body: elStub, head: elStub, documentElement: elStub, readyState: 'complete', cookie: '',
};
const storageStub = { getItem: () => null, setItem: noop, removeItem: noop };
const ChartStub = function () { return { update: noop, destroy: noop, data: { datasets: [{}] } }; };
ChartStub.defaults = { font: {}, color: '', plugins: {} };

const sandbox = {
  console, Math, JSON, Date, Object, Array, String, Number, Boolean, RegExp, Map, Set, isNaN, parseInt, parseFloat,
  document: documentStub, window: {}, globalThis: {}, self: {}, navigator: { userAgent: '' },
  localStorage: storageStub, sessionStorage: storageStub, location: { href: '', hash: '', search: '' },
  Chart: ChartStub, fetch: () => Promise.resolve({ ok: false, json: async () => ({}) }),
  setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
  requestAnimationFrame: noop, alert: noop, atob: s => s, btoa: s => s, URLSearchParams: function(){ return { get: () => null }; },
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
try { vm.runInContext(code, sandbox, { timeout: 15000 }); }
catch (e) { /* top-level side effects may throw offline; definitions still captured */ }

const cap = sandbox.__cap;
if (!cap || !cap.DATA || !cap.scrubClaim) {
  console.error('capture failed', sandbox.__capErr || '(no __cap)');
  process.exit(1);
}

// Only the tables scrubClaim needs (+ cdm for the worksheet's code lookup).
const KEYS = ['scrubRules', 'ptp', 'ptpMcdDiff', 'mue', 'mueMcdDiff', 'aft', 'freq', 'cdm'];
const subset = {};
for (const k of KEYS) subset[k] = cap.DATA[k];

const banner =
`/* engine/themis.js — BHW clean-claim scrub engine (SHARED, auto-generated).
   Generated from index.html by tools/extract-engine.js — DO NOT EDIT BY HAND.
   The RCM Command Center (index.html) and the Coding Worksheet load this same
   engine so they never drift. After changing scrubClaim() or a DATA table in
   index.html, re-run:  node tools/extract-engine.js
   Globals exposed: DATA (engine subset), scrubClaim, TH_SEV, thStatus. */
`;
const out =
  banner +
  'const DATA = ' + JSON.stringify(subset) + ';\n' +
  'const TH_SEV = ' + JSON.stringify(cap.TH_SEV) + ';\n' +
  cap.scrubClaim.toString() + '\n' +
  cap.thStatus.toString() + '\n' +
  'if (typeof window !== "undefined") { window.DATA = window.DATA || DATA; window.scrubClaim = scrubClaim; window.TH_SEV = TH_SEV; window.thStatus = thStatus; }\n' +
  'if (typeof module !== "undefined") { module.exports = { DATA, scrubClaim, TH_SEV, thStatus }; }\n';

fs.mkdirSync(path.join(root, 'engine'), { recursive: true });
fs.writeFileSync(path.join(root, 'engine', 'themis.js'), out);
console.log('scrubRules:', cap.DATA.scrubRules.length, '| ptp:', Object.keys(cap.DATA.ptp).length,
  '| mue:', Object.keys(cap.DATA.mue).length, '| cdm:', cap.DATA.cdm.length);
console.log('wrote engine/themis.js', Math.round(out.length / 1024) + 'KB');
