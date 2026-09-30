// Legacy UI build for Android 4.4 (KitKat), whose WebView is Chromium 30-33
// and can't be updated. Called from sync-ui.mjs.
//
// Chromium 33 has no: arrow functions, let/const (outside strict mode),
// template literals, destructuring, async/await, fetch (42), Object.assign
// (45), Object.entries (54), NodeList.forEach (51), CSS custom properties
// (49), 8-digit hex colours (62), unprefixed transform/transition (36).
//
// So this build:
//   JS   - Babel -> ES5 (async/await via inlined regenerator)
//        - polyfills: exactly the core-js modules Babel detects the UI using,
//          plus fetch and a few DOM helpers, bundled as one ES5 IIFE
//   CSS  - CSS variables resolved to their :root defaults, 8-digit hex ->
//          rgba(), -webkit- prefixes added
//   theme- applyTheme() sets CSS variables at runtime to recolour the UI per
//          device. A small shim intercepts setProperty('--x', ...) and
//          re-renders the stylesheet in place from a template, so theming
//          works and the original cascade order is untouched.

import { transformSync as babel } from "@babel/core";
import { buildSync } from "esbuild";
import postcss from "postcss";
import autoprefixer from "autoprefixer";
import * as acorn from "acorn";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const LEGACY_BROWSERS = ["chrome 30"]; // Android 4.4.0-4.4.2; 4.4.3+ is Chrome 33
const VAR_RE = /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g;

const hex8ToRgba = (s) =>
  s.replace(/#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})\b/g, (_, r, g, b, a) =>
    `rgba(${parseInt(r, 16)},${parseInt(g, 16)},${parseInt(b, 16)},${+(parseInt(a, 16) / 255).toFixed(3)})`);

// ---- CSS ------------------------------------------------------------------

function legacyCss(css) {
  const defaults = {};
  const root = postcss.parse(css);
  root.walkRules((rule) => {
    if (rule.selector.trim() !== ":root") return;
    rule.walkDecls((d) => { if (d.prop.startsWith("--")) defaults[d.prop] = d.value.trim(); });
  });
  // Chromium 33 ignores custom-property declarations; drop them.
  root.walkDecls((d) => { if (d.prop.startsWith("--")) d.remove(); });
  root.walkRules((r) => { if (r.nodes.length === 0) r.remove(); });

  // Prefix/lower with var() left in place. This is the TEMPLATE the runtime
  // shim re-renders in place when applyTheme() changes a variable - the
  // whole sheet, so the original cascade order is preserved exactly.
  let template = postcss([autoprefixer({ overrideBrowserslist: LEGACY_BROWSERS })]).process(root.toString(), { from: undefined }).css;
  template = buildSync({ stdin: { contents: template, loader: "css" }, write: false, target: ["chrome30"], logLevel: "silent" })
    .outputFiles[0].text;
  const resolve = (value, vars) => value.replace(VAR_RE, (_, name, fallback) => vars[name] ?? (fallback ? fallback.trim() : ""));
  const themedValues = (template.match(VAR_RE) || []).length;
  return { css: resolve(template, defaults), template, defaults, themedValues };
}

// ---- JS: route var(--x) inside JS strings through the theme shim ----------

// e.g. bar.style.background = 'var(--primary)'  and  `<div style="color:var(--primary)">`
function rewriteJsVarStrings(code) {
  const ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "script", ranges: true });
  const edits = [];
  (function walk(node) {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "Literal" && typeof node.value === "string" && node.value.includes("var(--")) {
      const q = code[node.start];
      const body = code.slice(node.start + 1, node.end - 1)
        .replace(VAR_RE, (_, name) => `${q} + __helmVar('${name}') + ${q}`);
      edits.push([node.start, node.end, `(${q}${body}${q})`]);
    } else if (node.type === "TemplateElement" && node.value.raw.includes("var(--")) {
      edits.push([node.start, node.end, node.value.raw.replace(VAR_RE, (_, name) => `\${__helmVar('${name}')}`)]);
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object" && k !== "loc") walk(v);
    }
  })(ast);
  edits.sort((a, b) => b[0] - a[0]);
  for (const [s, e, text] of edits) code = code.slice(0, s) + text + code.slice(e);
  return { code, count: edits.length };
}

const babelOpts = (extra = {}) => ({
  babelrc: false, configFile: false, compact: false, comments: true,
  sourceType: "script",
  presets: [[require.resolve("@babel/preset-env"), { targets: LEGACY_BROWSERS, modules: false, ...extra }]],
});

function legacyJs(code) {
  const { code: rewritten, count } = rewriteJsVarStrings(code);
  const es5 = babel(rewritten, babelOpts()).code;
  // A second pass only to learn which core-js polyfills the UI needs.
  const probe = babel(rewritten, {
    ...babelOpts({ useBuiltIns: "usage", corejs: require("core-js/package.json").version }),
    sourceType: "module",
  }).code;
  const modules = [...probe.matchAll(/["'](core-js\/modules\/[\w.-]+)["']/g)].map((m) => m[1]);
  return { es5, modules: [...new Set(modules)], varRewrites: count };
}

// ---- polyfill bundle ------------------------------------------------------

function polyfillBundle(detected) {
  // Always include what the UI relies on through the DOM, which Babel's
  // usage detection can't see (NodeList.forEach on querySelectorAll results).
  const always = [
    "core-js/modules/es.promise.js",
    "core-js/modules/es.object.assign.js",
    "core-js/modules/es.object.entries.js",
    "core-js/modules/es.object.values.js",
    "core-js/modules/es.array.from.js",
    "core-js/modules/es.array.find.js",
    "core-js/modules/es.array.includes.js",
    "core-js/modules/es.string.includes.js",
    "core-js/modules/es.string.starts-with.js",
    "core-js/modules/es.string.ends-with.js",
    "core-js/modules/web.dom-collections.for-each.js",
  ];
  const modules = [...new Set([...always, ...detected])];
  const dir = mkdtempSync(join(tmpdir(), "helm-legacy-"));
  try {
    const entry = join(dir, "entry.js");
    writeFileSync(entry, [...modules.map((m) => `import "${m}";`), `import "whatwg-fetch";`].join("\n"));
    const out = buildSync({
      entryPoints: [entry], bundle: true, write: false, format: "iife", target: ["es5"],
      minify: true, legalComments: "none", logLevel: "silent", nodePaths: [join(here, "node_modules")],
    }).outputFiles[0].text;
    return { js: out, modules };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- runtime theme shim (hand-written ES5) --------------------------------

function themeShim(defaults, template) {
  return `/* Helm legacy theme shim (generated by tools/legacy.mjs) */
(function () {
  var vars = ${JSON.stringify(defaults)};
  var template = ${JSON.stringify(template)};
  var re = /var\\(\\s*(--[\\w-]+)\\s*(?:,\\s*([^()]*))?\\)/g;
  function rgba(v) {
    return String(v).replace(/#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})\\b/g, function (_, r, g, b, a) {
      return "rgba(" + parseInt(r, 16) + "," + parseInt(g, 16) + "," + parseInt(b, 16) + "," + (parseInt(a, 16) / 255).toFixed(3) + ")";
    });
  }
  function render() {
    var el = document.getElementById("helm-main-css");
    if (el) el.textContent = template.replace(re, function (_, n, fb) { return vars[n] != null ? vars[n] : (fb || ""); });
  }
  window.__helmVar = function (n) { return vars[n] != null ? vars[n] : ""; };
  var proto = window.CSSStyleDeclaration && CSSStyleDeclaration.prototype;
  if (proto && proto.setProperty) {
    var orig = proto.setProperty;
    proto.setProperty = function (name, value) {
      if (String(name).indexOf("--") === 0) { vars[name] = rgba(value); render(); return; }
      return orig.apply(this, arguments);
    };
  }
})();`;
}

// ---- assemble -------------------------------------------------------------

export function buildLegacy(html, { fail }) {
  let out = hex8ToRgba(html);

  let cssInfo = null;
  out = out.replace(/<style(\s[^>]*)?>([\s\S]*?)<\/style>/g, (whole, attrs = "", css) => {
    if (cssInfo) fail("more than one <style> block; legacy build expects one");
    cssInfo = legacyCss(css);
    return `<style id="helm-main-css"${attrs}>${cssInfo.css}</style>`;
  });
  if (!cssInfo) fail("no <style> block found");

  const detected = new Set();
  let varRewrites = 0;
  out = out.replace(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g, (whole, attrs = "", code) => {
    if (/\bsrc\s*=/.test(attrs)) return whole;
    const r = legacyJs(code);
    r.modules.forEach((m) => detected.add(m));
    varRewrites += r.varRewrites;
    return `<script${attrs}>${r.es5}</script>`;
  });

  const poly = polyfillBundle([...detected]);
  const shim = themeShim(cssInfo.defaults, cssInfo.template);
  out = out.replace(/<head[^>]*>/i, (h) => `${h}\n<script>${poly.js}</script>\n<script>${shim}</script>`);

  // ---- verification -------------------------------------------------------
  const scripts = [...out.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  scripts.forEach((s, i) => {
    try { acorn.parse(s, { ecmaVersion: 5, sourceType: "script" }); }
    catch (e) { fail(`legacy script #${i + 1} is not valid ES5: ${e.message}`); }
  });
  const css = out.match(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/)[1];
  if (css.includes("var(")) fail("legacy CSS still contains var()");
  if (/#[0-9a-fA-F]{8}\b/.test(out)) fail("legacy build still contains 8-digit hex colours");
  const markup = out.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
  if (/var\(--/.test(markup)) fail("markup outside scripts still uses var() in an inline style");

  return {
    html: out,
    stats: { polyfills: poly.modules.length, polyfillBytes: poly.js.length, themedRules: cssInfo.themedValues, varRewrites },
  };
}
