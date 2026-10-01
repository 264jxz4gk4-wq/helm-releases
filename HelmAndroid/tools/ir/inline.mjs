#!/usr/bin/env node
// Copy ir.js (the HelmIR library) into the shared UI, ui/index.html, which
// carries it inline between the BEGIN/END HelmIR markers - the UI is a single
// file on every platform.
//
//   node tools/ir/inline.mjs           update ui/index.html
//   node tools/ir/inline.mjs --check   exit 1 if ui/index.html is out of date
//                                      (sync-ui.mjs runs this check)
//
// Edit ir.js (and verify it with test_ir.mjs), then run this.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const UI = resolve(here, "../../../ui/index.html");
const LIB = resolve(here, "ir.js");
const BLOCK = /(\/\* BEGIN HelmIR[^\n]*\*\/\n)([\s\S]*?)(\n\/\* END HelmIR \*\/)/;

export function inlineStatus() {
  const html = readFileSync(UI, "utf8");
  const lib = readFileSync(LIB, "utf8").replace(/\s+$/, "");
  const m = html.match(BLOCK);
  if (!m) return { html, lib, found: false, current: false };
  return { html, lib, found: true, current: m[2] === lib };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const s = inlineStatus();
  if (!s.found) { console.error("inline: no BEGIN/END HelmIR block in ui/index.html"); process.exit(1); }
  if (process.argv.includes("--check")) {
    if (!s.current) { console.error("inline: ui/index.html's HelmIR block differs from tools/ir/ir.js - run node tools/ir/inline.mjs"); process.exit(1); }
    console.log("inline: ui/index.html has the current ir.js");
  } else if (s.current) {
    console.log("inline: already up to date");
  } else {
    writeFileSync(UI, s.html.replace(BLOCK, (_, a, _b, c) => a + s.lib + c));
    console.log("inline: ui/index.html updated");
  }
}
