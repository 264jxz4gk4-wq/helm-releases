#!/usr/bin/env node
// test_ir.mjs - verifies ir.js (HelmIR) against independent references.
//
//   node test_ir.mjs               run all checks (exit 1 on any FAIL)
//   node test_ir.mjs --coverage    also print the brand/set/key coverage table
//   node test_ir.mjs --write-table regenerate the BRANDS table inside ir.js from the source databases
//   node test_ir.mjs --provenance  print per-key provenance (markdown)
//   node test_ir.mjs --verbose     print every individual check
//
// References (built by _ref/fetch_refs.sh; override location with HELM_IR_REF=/path):
//   * IrpTransmogrifier (Java, B. Martensson, GPLv3) rendering IrpProtocols.xml  -> exact timing reference
//   * Flipper Zero firmware lib/infrared encoders/decoders compiled for the host -> defines Flipper .ir field semantics
//   * Source databases: Flipper-IRDB (.ir), probonopd/irdb (.csv) incl. RAW captures
// Checks per key of every set:
//   src   table value == value read from the cited source entry (transcription + field mapping)
//   irpt  HelmIR pattern == IrpTransmogrifier render, duration by duration (+-1us), same carrier
//   fz    HelmIR pattern == Flipper firmware encoder output for the same fields (+-5%, frame structure)
//   lim   integer us, starts with mark, total <= 2,000,000us (also with repeats)
// plus: raw (pattern vs RAW captures of the same key, +-25% after mark-excess correction),
//       xdb (cross-database agreement Flipper-IRDB vs irdb), sweep (random fields vs IrpTransmogrifier).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REF = process.env.HELM_IR_REF || path.join(HERE, '_ref');
const ROOTS = { F: path.join(REF, 'flipper-irdb'), R: path.join(REF, 'flipper-irdb'), I: path.join(REF, 'irdb'), FZ: path.join(REF, 'fz') };
const ARGS = new Set(process.argv.slice(2));

// ------------------------------------------------------------------ provenance spec
// key ref: 'Name' (entry in the set's src) | 'F:path#Name' (Flipper-IRDB parsed) | 'R:path#Name' (Flipper-IRDB RAW,
// decoded with IrpTransmogrifier) | 'I:path#FUNCTIONNAME' (probonopd/irdb csv row).
// 'I:...#NAME@PROTO' selects irdb rows of that protocol; 'as' remaps the protocol.
const ROKU = 'F:TVs/TCL/TCL_50S423.ir';
const SPEC = [
  { id: 'tcl', name: 'TCL', sets: [
    { id: 'tcl_gtv', label: 'TCL Google TV / Android TV (RCA-type code, 38 kHz)', src: 'F:TVs/TCL/TCL_65C635K.ir',
      keys: { power: 'Power', vol_up: 'Vol_up', vol_down: 'Vol_dn', mute: 'Mute', input: 'Source', up: 'Up', down: 'Down',
        left: 'Left', right: 'Right', ok: 'Ok', back: 'Back', home: 'Home', menu: 'Menu', ch_up: 'Ch_next', ch_down: 'Ch_prev' } },
    { id: 'tcl_roku', label: 'TCL Roku TV', src: ROKU,
      keys: { power: 'Power', vol_up: 'Vol_up', vol_down: 'Vol_dn', mute: 'Mute', up: 'Up', down: 'Down', left: 'Left',
        right: 'Right', ok: 'Ok', back: 'Back', home: 'Home', menu: 'Star', play_pause: 'Play/pause' } },
    { id: 'tcl_rca56', label: 'TCL power, 56 kHz carrier variant', src: 'F:TVs/TCL/TCL_65C635K.ir', as: 'RCA56',
      keys: { power: 'Power' } },
  ] },
  { id: 'hisense', name: 'Hisense', sets: [
    { id: 'hisense_gtv', label: 'Hisense Google TV / Android TV', src: 'F:TVs/Hisense/Hisense_55U6K.ir',
      keys: { power: 'Power', vol_up: 'Vol_up', vol_down: 'Vol_dn', mute: 'Mute', input: 'Input', up: 'Up', down: 'Down',
        left: 'Left', right: 'Right', ok: 'Ok', back: 'Back', home: 'Home', menu: 'Menu', play_pause: 'Play_pa',
        ch_up: 'Ch_next', ch_down: 'Ch_prev' } },
    { id: 'hisense_vidaa', label: 'Hisense VIDAA / other Hisense smart TVs', src: 'F:TVs/Hisense/Hisense_32A4HAU.ir',
      keys: { power: 'Power', vol_up: 'Vol_up', vol_down: 'Vol_dn', mute: 'Mute', input: 'Input', up: 'Up', down: 'Down',
        left: 'Left', right: 'Right', ok: 'Ok', back: 'Back', home: 'Home', menu: 'Menu', play_pause: 'Pause/play',
        ch_up: 'Ch_next', ch_down: 'Ch_prev' } },
    { id: 'hisense_roku', label: 'Hisense Roku TV (Roku TV code)', src: ROKU, keys: { power: 'Power' } },
    { id: 'hisense_rc5', label: 'Older Hisense (RC5)', src: 'R:TVs/Hisense/Hisense_ER22601A.ir', keys: { power: 'Power' } },
  ] },
  { id: 'samsung', name: 'Samsung', sets: [
    { id: 'samsung', label: 'Samsung TV', src: 'F:TVs/Samsung/Samsung_BN59-01301A.ir',
      keys: { power: 'Power', vol_up: 'Vol_up', vol_down: 'Vol_dn', mute: 'Mute', input: 'Source', up: 'Up', down: 'Down',
        left: 'Left', right: 'Right', ok: 'Select', back: 'Return', home: 'Home', menu: 'Settings',
        play_pause: 'F:TVs/Samsung/Samsung_BN59-01358C.ir#Play_pause', ch_up: 'Ch_next', ch_down: 'Ch_prev',
        power_off: 'F:TVs/Samsung/Samsung_QM55RA.ir#Power_off' } },
    { id: 'samsung_smart', label: 'Samsung Smart Remote power code (2016+)', src: 'F:TVs/Samsung/Samsung_BN59-01358C.ir',
      keys: { power: 'Power' } },
  ] },
  { id: 'lg', name: 'LG', sets: [
    { id: 'lg', label: 'LG TV (webOS and older)', src: 'F:TVs/LG/LG_AKB75855501.ir',
      keys: { power: 'Power', vol_up: 'Vol_up', vol_down: 'Vol_dn', mute: 'Mute', input: 'Source', up: 'Up', down: 'Down',
        left: 'Left', right: 'Right', ok: 'Enter', back: 'Back', home: 'Home', menu: 'Settings', ch_up: 'Ch_up', ch_down: 'Ch_dn' } },
  ] },
  { id: 'sony', name: 'Sony', sets: [
    { id: 'sony', label: 'Sony Bravia', src: 'F:TVs/Sony/Sony_RMF-TX500U.ir',
      keys: { power: 'Power', vol_up: 'Vol_up', vol_down: 'Vol_dn', mute: 'Mute', input: 'Input', up: 'Up', down: 'Down',
        left: 'Left', right: 'Right', ok: 'Enter', back: 'Back', home: 'Home', menu: 'Settings', ch_up: 'Ch_next', ch_down: 'Ch_prev',
        power_on: 'F:TVs/Sony/Sony_XBR.ir#Power', power_off: 'F:TVs/Sony/Sony_XBR.ir#Power_off' } },
  ] },
  { id: 'vizio', name: 'Vizio', sets: [
    { id: 'vizio', label: 'Vizio SmartCast / Vizio TV', src: 'F:TVs/Vizio/Vizio_V705-G1.ir',
      keys: { power: 'Power', vol_up: 'Vol_up', vol_down: 'Vol_dn', mute: 'Mute', input: 'Input', up: 'Up', down: 'Down',
        left: 'Left', right: 'Right', ok: 'Ok', back: 'Back', home: 'Home', menu: 'Menu', ch_up: 'Ch_next', ch_down: 'Ch_prev' } },
  ] },
  { id: 'philips', name: 'Philips', sets: [
    { id: 'philips_rc6', label: 'Philips (RC6; Android TV / Saphi, EU)', src: 'F:TVs/Philips/Philips_TV_48OLED806.ir',
      keys: { power: 'On_off', vol_up: 'Vol_up', vol_down: 'Vol_dn', mute: 'Mute', input: 'Sources', up: 'Up', down: 'Down',
        left: 'Left', right: 'Right', ok: 'Enter', back: 'Back', home: 'Home', menu: 'Menu', ch_up: 'Ch_next', ch_down: 'Ch_prev' } },
    { id: 'philips_roku', label: 'Philips Roku TV (US)', src: 'F:TVs/Philips/Philips_40PFL6533_F7D.ir',
      keys: { power: 'Power', vol_up: 'Vol_up', vol_down: 'Vol_dn', mute: 'Mute', up: 'Up', down: 'Down', left: 'Left',
        right: 'Right', ok: 'Ok', back: 'Exit', home: 'Menu', menu: 'Options', play_pause: 'Play_pause' } },
    { id: 'philips_rc5', label: 'Older Philips (RC5)', src: 'F:TVs/Philips/Philips_14GX8510.ir',
      keys: { power: 'Power', vol_up: 'Vol_up', vol_down: 'Vol_down', mute: 'Mute', input: 'Input', ch_up: 'Channel_up', ch_down: 'Channel_down' } },
  ] },
  { id: 'panasonic', name: 'Panasonic', sets: [
    { id: 'panasonic', label: 'Panasonic Viera', src: 'F:TVs/Panasonic/N2QAYB001109_full.ir',
      keys: { power: 'Power', vol_up: 'Vol_up', vol_down: 'Vol_dn', mute: 'Mute', input: 'Input_AV', up: 'Up', down: 'Down',
        left: 'Left', right: 'Right', ok: 'Ok', back: 'Back', home: 'Home', menu: 'Menu', ch_up: 'Ch_next', ch_down: 'Ch_prev' } },
  ] },
  { id: 'sharp', name: 'Sharp', sets: [
    { id: 'sharp_aquos', label: 'Sharp Aquos (Sharp protocol)', src: 'R:TVs/Sharp/Sharp_LC-RC1-16.ir',
      keys: { power: 'Power', vol_up: 'Vol_up', vol_down: 'Vol_dn', mute: 'Mute', input: 'Input', up: 'Up', down: 'Down',
        left: 'Left', right: 'Right', ok: 'Enter', home: 'Home', menu: 'Menu', ch_up: 'Ch_next', ch_down: 'Ch_prev' } },
    { id: 'sharp_nec', label: 'Sharp Aquos (newer EU models, NEC 7F00)', src: 'F:TVs/Sharp/Sharp_Aquos_32BG3E.ir',
      keys: { power: 'Power', vol_up: 'Vol_up', vol_down: 'Vol_dn', mute: 'Mute', input: 'Source', up: 'Up', down: 'Down',
        left: 'Left', right: 'Right', ok: 'Ok', menu: 'Menu', ch_up: 'Ch_next', ch_down: 'Ch_prev' } },
    { id: 'sharp_roku', label: 'Sharp Roku TV (Roku TV code)', src: ROKU, keys: { power: 'Power' } },
    { id: 'sharp_roku_nec', label: 'Sharp Roku TV (NEC 0x04 code as captured)', src: 'F:TVs/Sharp/Sharp_Roku_TV.ir', keys: { power: 'Power' } },
  ] },
  { id: 'toshiba', name: 'Toshiba', sets: [
    { id: 'toshiba_firetv', label: 'Toshiba Fire TV Edition', src: 'F:TVs/Toshiba/toshiba_firetv_v2.ir',
      keys: { power: 'Power', vol_up: 'Vol_up', vol_down: 'Vol_down', mute: 'Mute', up: 'Up', down: 'Down', left: 'Left',
        right: 'Right', ok: 'Enter', back: 'Back', home: 'Home', menu: 'F:TVs/Toshiba/Toshiba_50C350LC.ir#Menu',
        play_pause: 'Play_pause', ch_up: 'Channel_up', ch_down: 'Channel_down' } },
    { id: 'toshiba_nec', label: 'Toshiba (classic, NEC 0x40)', src: 'F:TVs/Toshiba/Toshiba_CT-32F2.ir',
      keys: { power: 'Power', vol_up: 'Vol_up', vol_down: 'Vol_dn', mute: 'Mute', input: 'F:TVs/Toshiba/Toshiba_32AV502U.ir#Input',
        ch_up: 'Ch_next', ch_down: 'Ch_prev' } },
    { id: 'toshiba_rc5', label: 'Toshiba (RC5, EU)', src: 'F:TVs/Toshiba/Toshiba_Ct-8563.ir',
      keys: { power: 'Power', vol_up: 'Vol_up', vol_down: 'Vol_down', mute: 'Mute', up: 'Up', down: 'Down', left: 'Left',
        right: 'Right', ok: 'Ok', back: 'Return', home: 'Home', menu: 'Menu', ch_up: 'Chnl_next', ch_down: 'Chnl_prev' } },
  ] },
  { id: 'insignia', name: 'Insignia', sets: [
    { id: 'insignia_firetv', label: 'Insignia Fire TV Edition', src: 'F:TVs/Amazon/FireTV_Omni_Series_4K.ir',
      keys: { power: 'F:TVs/Insignia/Insignia_NS_RCFNA_21.ir#Power', vol_up: 'Vol_up', vol_down: 'Vol_dn', mute: 'Mute',
        up: 'Up', down: 'Down', left: 'Left', right: 'Right', ok: 'Select', back: 'Back', home: 'Home', menu: 'Menu',
        play_pause: 'Play_pause', ch_up: 'Ch_next', ch_down: 'Ch_prev' } },
    { id: 'insignia', label: 'Insignia (NS-RC remotes, NEC 0586)', src: 'F:TVs/Insignia/Insignia_NS_RC9DNA-14.ir',
      keys: { power: 'Power', vol_up: 'Vol_up', vol_down: 'Vol_dn', mute: 'Mute', input: 'Input', up: 'Up', down: 'Down',
        left: 'Left', right: 'Right', ok: 'Ok', menu: 'Menu', ch_up: 'Ch_next', ch_down: 'Ch_prev' } },
    { id: 'insignia_roku', label: 'Insignia Roku TV (Roku TV code)', src: ROKU, keys: { power: 'Power' } },
  ] },
  { id: 'roku', name: 'Roku TV (TCL, Hisense, onn., Philips, Sharp, Insignia...)', sets: [
    { id: 'roku_tv', label: 'Roku TV', src: ROKU,
      keys: { power: 'Power', vol_up: 'Vol_up', vol_down: 'Vol_dn', mute: 'Mute', up: 'Up', down: 'Down', left: 'Left',
        right: 'Right', ok: 'Ok', back: 'Back', home: 'Home', menu: 'Star', play_pause: 'Play/pause' } },
  ] },
];

// Explicit raw-capture checks: our encoded key vs a RAW capture of that key (label-matched, NOT decoded first).
const RAW_CHECKS = [
  ['tcl', 'tcl_gtv', 'right', 'TVs/TCL/TCL_UnknownModel1.ir#Right'],
  ['tcl', 'tcl_gtv', 'vol_down', 'TVs/TCL/TCL_UnknownModel1.ir#Vol_dn'],
];
// Cross-database agreement (same function in an independent database / capture).
const I = (f, n) => 'I:codes/' + f + '#' + n;
const XDB = [
  ...[['power', 'POWER'], ['vol_up', 'VOLUME +'], ['vol_down', 'VOLUME -'], ['mute', 'MUTE'], ['input', 'INPUT'], ['up', 'ARROW UP'],
    ['down', 'ARROW DOWN'], ['left', 'ARROW LEFT'], ['right', 'ARROW RIGHT'], ['ok', 'OK'], ['back', 'GO BACK'], ['ch_up', 'CHANNEL +'],
    ['ch_down', 'CHANNEL -']].map(([k, n]) => ['tcl', 'tcl_gtv', k, I('TCL/TV/15,-1.csv', n)]),
  ...[['power', 'Power'], ['vol_up', 'Vol_up'], ['vol_down', 'Vol_dn'], ['mute', 'Mute'], ['home', 'Home'], ['up', 'Up'], ['down', 'Down'],
    ['left', 'Left'], ['right', 'Right'], ['ok', 'Select'], ['back', 'Back'], ['menu', 'Mystery']]
    .map(([k, n]) => ['tcl', 'tcl_gtv', k, 'F:TVs/TCL/TCL_43S446.ir#' + n]),
  ...[['power', 'Power'], ['input', 'Input'], ['back', 'Back'], ['ok', 'Ok'], ['up', 'Up'], ['down', 'Down'], ['left', 'Left'],
    ['right', 'Right'], ['mute', 'Mute'], ['vol_up', 'Vol_up'], ['vol_down', 'Vol_dn'], ['ch_up', 'Ch_next'], ['ch_down', 'Ch_prev'],
    ['menu', 'Menu']].map(([k, n]) => ['tcl', 'tcl_gtv', k, 'F:TVs/Ffalcon/Ffalcon_SF1_Smart_TV.ir#' + (k === 'back' ? 'Return' : k === 'input' ? 'Source' : n)]),
  ...[['power', 'Power'], ['vol_up', 'Vol_up'], ['vol_down', 'Vol_dn'], ['mute', 'Mute'], ['up', 'Up'], ['down', 'Down'], ['left', 'Left'],
    ['right', 'Right'], ['ok', 'Ok'], ['back', 'Back'], ['play_pause', 'Play_pa']].map(([k, n]) => ['roku', 'roku_tv', k, 'F:TVs/Onn/Onn_Roku_TV.ir#' + n]),
  ...[['power', 'Power'], ['vol_up', 'Vol_up'], ['vol_down', 'Vol_dn'], ['mute', 'Mute'], ['up', 'Up'], ['down', 'Dn'], ['left', 'Left'],
    ['ok', 'Ok'], ['back', 'Back'], ['home', 'Home'], ['menu', 'Options'], ['play_pause', 'Play_Pause']]
    .map(([k, n]) => ['roku', 'roku_tv', k, 'F:TVs/TCL/TCL_Roku_TV_55S405.ir#' + n]),
  ...[['power', 'POWER'], ['vol_up', 'VOLUME +'], ['vol_down', 'VOLUME -'], ['mute', 'MUTE'], ['input', 'INPUT SOURCE'], ['up', 'CURSOR UP'],
    ['down', 'CURSOR DOWN'], ['left', 'CURSOR LEFT'], ['right', 'CURSOR RIGHT'], ['ok', 'ENTER'], ['back', 'RETURN'], ['home', 'SMART HUB'],
    ['menu', 'MENU'], ['ch_up', 'CHANNEL +'], ['ch_down', 'CHANNEL -']].map(([k, n]) => ['samsung', 'samsung', k, I('Samsung/TV/7,7.csv', n)]),
  ...[['power', 'POWER'], ['vol_up', 'VOLUME +'], ['vol_down', 'VOLUME -'], ['mute', 'MUTE'], ['input', 'INPUT SOURCE'], ['up', 'ARROW UP'],
    ['down', 'ARROW DOWN'], ['left', 'CURSOR LEFT'], ['right', 'CURSOR RIGHT'], ['ok', 'OK'], ['menu', 'MENU']]
    .map(([k, n]) => ['lg', 'lg', k, I('LG/TV/4,-1.csv', n)]),
  ...[['power', 'POWER ON/OFF'], ['vol_up', 'VOLUME UP'], ['vol_down', 'VOLUME DOWN'], ['mute', 'MUTE'], ['input', 'INPUT SCROLL'],
    ['up', 'CURSOR UP'], ['down', 'CURSOR DOWN'], ['left', 'CURSOR LEFT'], ['right', 'CURSOR RIGHT'], ['ok', 'CURSOR ENTER'],
    ['ch_up', 'CHANNEL UP'], ['ch_down', 'CHANNEL DOWN']].map(([k, n]) => ['sony', 'sony', k, I('Sony/TV/1,-1.csv', n)]),
  ['sony', 'sony', 'power_on', 'F:TVs/Sony/Sony_XBR.ir#Power'], ['sony', 'sony', 'power_off', 'F:TVs/Sony/Sony_XBR.ir#Power_off'],
  ...[['power', 'KEY_POWER'], ['vol_up', 'KEY_VOLUMEUP'], ['vol_down', 'VOL_DWN'], ['mute', 'KEY_MUTE'], ['input', 'INPUT'], ['up', 'KEY_UP'],
    ['down', 'KEY_DOWN'], ['left', 'KEY_LEFT'], ['right', 'KEY_RIGHT'], ['ch_up', 'KEY_CHANNELUP'], ['ch_down', 'CH_DWN']]
    .map(([k, n]) => ['vizio', 'vizio', k, I('Vizio/Unknown_Vizio/4,-1.csv', n)]),
  ...[['power', 'POWER'], ['input', 'Input'], ['home', 'Home'], ['menu', 'Menu'], ['up', 'Up'], ['ok', 'Ok']]
    .map(([k, n]) => ['vizio', 'vizio', k, 'F:TVs/Vizio/Vizio_XRT150.ir#' + n]),
  ['vizio', 'vizio', 'back', 'F:TVs/Vizio/Vizio_XRT136.ir#Back'],
  ...[['power', 'POWER'], ['vol_up', 'VOLUME +'], ['vol_down', 'VOLUME -'], ['mute', 'MUTE'], ['input', 'EXT. INPUT'], ['ch_up', 'CHANNEL +'],
    ['ch_down', 'CHANNEL -']].map(([k, n]) => ['philips', 'philips_rc5', k, I('Philips/TV/0,-1.csv', n)]),
  ...[['power', 'Power'], ['vol_up', 'Vol_up'], ['vol_down', 'Vol_dn'], ['mute', 'Mute'], ['input', 'Source'], ['up', 'Up'], ['down', 'Down'],
    ['left', 'Left'], ['right', 'Right'], ['ok', 'OK'], ['back', 'Back'], ['home', 'Home'], ['ch_up', 'Ch_next'], ['ch_down', 'Ch_prev']]
    .map(([k, n]) => ['philips', 'philips_rc6', k, 'F:TVs/Philips/Philips_50PUT6103_79.ir#' + n]),
  ...[['power', 'POWER TOGGLE'], ['vol_up', 'VOLUME UP'], ['vol_down', 'VOLUME DOWN'], ['mute', 'VOLUME MUTE TOGGLE'], ['input', 'INPUT SELECT/SCROLL'],
    ['up', 'CURSOR UP'], ['down', 'CURSOR DOWN'], ['left', 'CURSOR LEFT'], ['right', 'CURSOR RIGHT'], ['ok', 'CURSOR ENTER/SELECT'],
    ['back', 'RETURN'], ['menu', 'MENU'], ['ch_up', 'CHANNEL UP'], ['ch_down', 'CHANNEL DOWN']]
    .map(([k, n]) => ['panasonic', 'panasonic', k, I('Panasonic/TV/128,0.csv', n)]),
  ['panasonic', 'panasonic', 'home', I('Panasonic/TV/128,9.csv', 'MENU HOME')],
  ...[['power', 'POWER'], ['vol_up', 'VOLUME +'], ['vol_down', 'VOLUME -'], ['mute', 'MUTE'], ['input', 'TV/VIDEO'], ['menu', 'MENU'],
    ['ch_up', 'CHANNEL +'], ['ch_down', 'CHANNEL -']].map(([k, n]) => ['sharp', 'sharp_aquos', k, I('Sharp/TV/1,-1.csv', n)]),
  ...[['power', 'Power'], ['vol_up', 'Vol_up'], ['vol_down', 'Vol_dn'], ['mute', 'Mute'], ['input', 'Input'], ['ch_up', 'Ch_next'], ['ch_down', 'Ch_prev']]
    .map(([k, n]) => ['sharp', 'sharp_aquos', k, 'R:TVs/Sharp/Sharp_TV2.ir#' + (k === 'input' ? 'Source' : n)]),
  ...[['power', 'Power'], ['vol_up', 'Vol_up'], ['vol_down', 'Vol_down'], ['mute', 'Mute'], ['input', 'Source'], ['up', 'Up'], ['down', 'Down'],
    ['left', 'Left'], ['right', 'Right'], ['ok', 'Ok'], ['menu', 'Menu'], ['ch_up', 'Chan_up'], ['ch_down', 'Chan_down']]
    .map(([k, n]) => ['sharp', 'sharp_nec', k, 'F:TVs/Sharp/Aquos.ir#' + n]),
  ...[['power', 'Power'], ['vol_up', 'Vol_up'], ['vol_down', 'Vol_dn'], ['mute', 'Mute'], ['up', 'Up'], ['down', 'Down'], ['left', 'Left'],
    ['right', 'Right'], ['ok', 'Select'], ['back', 'Back'], ['home', 'Home'], ['play_pause', 'Play_pause'], ['ch_up', 'Ch_next'], ['ch_down', 'Ch_prev']]
    .map(([k, n]) => ['toshiba', 'toshiba_firetv', k, 'F:TVs/Amazon/FireTV_Omni_Series_4K.ir#' + n]),
  ...[['power', 'Power'], ['vol_up', 'Vol_up'], ['vol_down', 'Vol_dn'], ['mute', 'Mute'], ['ch_up', 'Ch_next'], ['ch_down', 'Ch_prev']]
    .map(([k, n]) => ['toshiba', 'toshiba_nec', k, 'F:TVs/Toshiba/Toshiba_CT-32F2.ir#' + n]),
  ['toshiba', 'toshiba_nec', 'input', 'F:TVs/Toshiba/Toshiba_32AV502U.ir#Input'],
  ...[['up', 'Up'], ['down', 'Down'], ['left', 'Left'], ['right', 'Right'], ['ok', 'Enter'], ['back', 'Back'], ['home', 'Home'], ['menu', 'Menu'],
    ['vol_up', 'Vol_up'], ['vol_down', 'Vol_down'], ['mute', 'Mute'], ['play_pause', 'Play_pause'], ['ch_up', 'Channel_up'], ['ch_down', 'Channel_down']]
    .map(([k, n]) => ['insignia', 'insignia_firetv', k, (k === 'menu' ? 'F:TVs/Toshiba/Toshiba_50C350LC.ir#' : 'F:TVs/Toshiba/toshiba_firetv_v2.ir#') + n]),
  ...[['power', 'POWER'], ['vol_up', 'VOLUME+'], ['vol_down', 'VOLUME -'], ['mute', 'MUTE'], ['input', 'INPUT'], ['up', 'CURSOR UP'],
    ['down', 'CURSOR DOWN'], ['left', 'CURSOR LEFT'], ['right', 'CURSOR RIGHT'], ['ok', 'ENTER'], ['menu', 'MENU'], ['ch_up', 'CHANNEL+'],
    ['ch_down', 'CHANNEL -']].map(([k, n]) => ['insignia', 'insignia', k, I('Insignia/TV/134,5.csv', n)]),
];

// ------------------------------------------------------------------ small utils
const hex = (n, w = 2) => '0x' + n.toString(16).toUpperCase().padStart(w, '0');
const rev = (v, n) => { let r = 0; for (let i = 0; i < n; i++) r = (r << 1) | ((v >>> i) & 1); return r >>> 0; };
const le = s => s.trim().split(/\s+/).reduce((acc, b, i) => acc + parseInt(b, 16) * 2 ** (8 * i), 0);
function die(msg) { console.error('ERROR: ' + msg); process.exit(2); }

function loadHelm() {
  const code = fs.readFileSync(path.join(HERE, 'ir.js'), 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(code + '\n;this.__H = HelmIR;', ctx, { filename: 'ir.js' });
  return { H: ctx.__H, code };
}

// ------------------------------------------------------------------ source readers
const cache = new Map();
function readFlipper(rel) {
  const p = path.join(ROOTS.F, rel);
  if (cache.has(p)) return cache.get(p);
  if (!fs.existsSync(p)) die('missing source ' + p + ' (run _ref/fetch_refs.sh)');
  const out = []; let cur = null;
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (raw.startsWith('#')) { if (cur) out.push(cur); cur = null; continue; }
    const m = raw.match(/^(\w+):\s*(.*)$/); if (!m) continue;
    if (m[1] === 'name') { if (cur) out.push(cur); cur = { name: m[2].trim() }; } else if (cur) cur[m[1]] = m[2].trim();
  }
  if (cur) out.push(cur);
  cache.set(p, out); return out;
}
function readIrdb(rel) {
  const p = path.join(ROOTS.I, rel);
  if (cache.has(p)) return cache.get(p);
  if (!fs.existsSync(p)) die('missing source ' + p + ' (run _ref/fetch_refs.sh)');
  const rows = fs.readFileSync(p, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map(l => {
    const c = l.split(','); const n = c.length;
    return { name: c.slice(0, n - 4).join(','), protocol: c[n - 4], D: +c[n - 3], S: +c[n - 2], F: +c[n - 1] };
  });
  cache.set(p, rows); return rows;
}
// irdb / IrpTransmogrifier params -> HelmIR (protocol, address, command)
function irpToHelm(proto, D, S, F) {
  switch (proto) {
    case 'NEC': case 'NEC1': case 'NEC2':
      if (S === -1 || S === undefined || S === 255 - D) return { protocol: 'NEC', address: D, command: F };
      return { protocol: 'NECext', address: D | (S << 8), command: F | ((255 - F) << 8) };
    case 'NECx1': case 'NECx2': if (S !== D) return null; return { protocol: 'Samsung32', address: D, command: F };
    case 'Sony12': return { protocol: 'SIRC', address: D, command: F };
    case 'Sony15': return { protocol: 'SIRC15', address: D, command: F };
    case 'Sony20': return { protocol: 'SIRC20', address: D | (S << 5), command: F };
    case 'RC5': return F < 64 ? { protocol: 'RC5', address: D, command: F } : { protocol: 'RC5X', address: D, command: F - 64 };
    case 'RC6': return { protocol: 'RC6', address: D, command: F };
    case 'Panasonic': { // Flipper Kaseikyo layout, vendor 0x2002 (parity 0): D = genre1<<4
      if (D & 15) return null;
      return { protocol: 'Kaseikyo', address: (S & 15) | ((D >> 4) << 4) | (0x2002 << 8) | ((F >> 6) << 24), command: ((F & 63) << 4) | (S >> 4) };
    }
    case 'RCA-38': return { protocol: 'RCA', address: rev(D, 4), command: rev(F, 8) };
    case 'RCA': return { protocol: 'RCA56', address: rev(D, 4), command: rev(F, 8) };
    case 'Sharp': return { protocol: 'Sharp', address: D, command: F };
  }
  return null;
}
function flipperToHelm(e) {
  if (e.type !== 'parsed') return null;
  return { protocol: e.protocol, address: le(e.address), command: le(e.command) };
}
// resolve a ref -> {code:{protocol,address,command}, origin, raw?:{data}}
const decodeCache = new Map();
function parseRef(ref, setSrc) {
  let kind, file, name;
  const m = ref.match(/^(F|R|I):(.*)#(.*)$/);
  if (m) [kind, file, name] = [m[1], m[2], m[3]];
  else { const s = setSrc.match(/^(F|R|I):(.*)$/); [kind, file, name] = [s[1], s[2], ref]; }
  return { kind, file, name };
}
function resolveRef(ref, setSrc, asProto) {
  const { kind, file, name } = parseRef(ref, setSrc);
  let code = null, extra = {};
  if (kind === 'F' || kind === 'R') {
    const ents = readFlipper(file).filter(e => e.name === name);
    if (ents.length !== 1) return { err: `${ents.length} entries named "${name}" in ${file}` };
    const e = ents[0];
    if (kind === 'F') { if (e.type !== 'parsed') return { err: `${file}#${name} is not parsed` }; code = flipperToHelm(e); }
    else {
      if (e.type !== 'raw') return { err: `${file}#${name} is not raw` };
      extra.raw = e.data.trim().split(/\s+/).map(Number);
      const dec = decodeCache.get(e.data);
      if (!dec) return { err: 'raw not decoded', needDecode: e.data };
      code = dec;
    }
  } else {
    const [nm, want] = name.split('@'); // optional '@PROTOCOL' row filter
    const rows = readIrdb(file).filter(r => r.name === nm && (!want || r.protocol === want));
    if (!rows.length) return { err: `no row "${name}" in ${file}` };
    const maps = rows.map(r => irpToHelm(r.protocol, r.D, r.S, r.F));
    code = maps[0];
    if (!code || maps.some(c => !c || c.protocol !== code.protocol || c.address !== code.address || c.command !== code.command))
      return { err: `ambiguous/unmappable irdb rows for ${name}: ${JSON.stringify(rows)}` };
  }
  if (code && asProto) code = { ...code, protocol: asProto };
  return { code, kind, file, name, ...extra };
}

// ------------------------------------------------------------------ reference runners
function irptBatch(lines, mode) {
  if (!lines.length) return [];
  const J = path.join(REF, 'deb/x/usr/share/java');
  const cp = [path.join(REF, 'irpt/build/irptransmogrifier.jar'), path.join(J, 'antlr4-runtime-4.9.2.jar'), path.join(J, 'jcommander-1.71.jar'), path.join(REF, 'irpref')].join(':');
  if (!fs.existsSync(path.join(REF, 'irpref/IrpRef.class'))) die('IrpTransmogrifier reference not built (run _ref/fetch_refs.sh)');
  const r = spawnSync('java', ['-cp', cp, 'IrpRef', ...(mode ? [mode] : [])], { input: lines.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = r.stdout.split('\n').filter(Boolean);
  if (out.length !== lines.length) die('IrpTransmogrifier returned ' + out.length + ' lines for ' + lines.length + ' requests\n' + r.stderr.slice(0, 2000));
  return mode ? out : out.map(l => JSON.parse(l));
}
function fzBatch(lines, mode) {
  if (!lines.length) return [];
  const bin = path.join(REF, 'fzhost/fzhost');
  if (!fs.existsSync(bin)) die('Flipper firmware host harness not built (run _ref/fetch_refs.sh)');
  const r = spawnSync(bin, mode ? [mode] : [], { input: lines.join('\n') + '\n', encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = r.stdout.split('\n').filter(Boolean);
  if (out.length !== lines.length) die('fzhost returned ' + out.length + ' lines for ' + lines.length);
  return out;
}
// HelmIR code -> IrpTransmogrifier request (independent definition of each protocol)
const RCA_IRP = f => `irp:{${f}k,500,msb}<1,-2|1,-4>(8,-8,D:4,F:8,~D:4,~F:8,1,-16)*`;
function irpRequest(c, toggle) {
  const a = c.address, f = c.command;
  switch (c.protocol) {
    case 'NEC': return ['NEC1', { D: a, F: f }, 'intro'];
    case 'NECext': return ['NEC1-f16', { D: a & 255, S: a >>> 8, F: f & 255, E: f >>> 8 }, 'intro'];
    case 'Samsung32': return ['NECx2', { D: a, S: a, F: f }, 'rep'];
    case 'RC5': return ['RC5', { D: a, F: f, T: toggle }, 'rep'];
    case 'RC5X': return ['RC5', { D: a, F: f + 64, T: toggle }, 'rep'];
    case 'RC6': return ['RC6', { D: a, F: f, T: toggle }, 'rep'];
    case 'SIRC': return ['Sony12', { D: a, F: f }, 'rep3'];
    case 'SIRC15': return ['Sony15', { D: a, F: f }, 'rep3'];
    case 'SIRC20': return ['Sony20', { D: a & 31, S: a >>> 5, F: f }, 'rep3'];
    case 'Kaseikyo': {
      const vendor = (a >>> 8) & 0xffff, g1 = (a >>> 4) & 15, g2 = a & 15, id = (a >>> 24) & 3;
      if (vendor !== 0x2002) return null;
      return ['Panasonic', { D: g1 << 4, S: g2 | ((f & 15) << 4), F: (id << 6) | (f >>> 4) }, 'rep'];
    }
    case 'RCA': return [RCA_IRP('38'), { D: rev(a, 4), F: rev(f, 8) }, 'rep'];
    case 'RCA56': return [RCA_IRP('56'), { D: rev(a, 4), F: rev(f, 8) }, 'rep'];
    case 'Sharp': return ['Sharp', { D: a, F: f }, 'sharp'];
  }
  return null;
}
function expectedFromIrpt(r, how, repeats) {
  const seq = [];
  const add = arr => { for (const v of arr) seq.push(v); };
  if (how === 'intro') { add(r.intro); for (let i = 0; i < repeats; i++) add(r.rep); }
  else if (how === 'rep' || how === 'rep3') { const n = (how === 'rep3' ? 3 : 1) + repeats; for (let i = 0; i < n; i++) add(r.rep); }
  else if (how === 'sharp') { add(r.intro); for (let i = 0; i < repeats; i++) add(r.rep); add(r.rep.slice(0, r.rep.length / 2)); }
  return seq.slice(0, seq.length - 1); // drop the final trailing gap
}
const FZ_PROTO = { NEC: 'NEC', NECext: 'NECext', Samsung32: 'Samsung32', RC5: 'RC5', RC5X: 'RC5X', RC6: 'RC6', SIRC: 'SIRC', SIRC15: 'SIRC15', SIRC20: 'SIRC20', Kaseikyo: 'Kaseikyo', RCA: 'RCA', RCA56: 'RCA' };

// ------------------------------------------------------------------ comparisons
function splitFrames(d, gap = 7000) {
  const fr = []; let cur = [];
  for (let i = 0; i < d.length; i++) {
    if (i % 2 === 1 && d[i] >= gap) { fr.push({ d: cur, gap: d[i] }); cur = []; } else cur.push(d[i]);
  }
  if (cur.length) fr.push({ d: cur, gap: 0 });
  return fr;
}
function cmpExact(ours, ref) {
  if (ours.length !== ref.length) return `length ${ours.length} vs ${ref.length}`;
  for (let i = 0; i < ours.length; i++) if (Math.abs(ours[i] - ref[i]) > 1) return `#${i}: ${ours[i]} vs ${ref[i]}`;
  return null;
}
function cmpFrames(ours, other, relTol, absTol, opt = {}) {
  // relTol/absTol: |a-b| <= max(relTol*a, absTol)   (a = our nominal duration)
  // opt.irpt: IrpTransmogrifier default decoder tolerance instead: |a-b| <= 100us OR |a-b| <= 30% of max(a,b),
  //           on the raw value or on the value corrected by the frame's median mark excess
  const A = splitFrames(ours), B = splitFrames(other);
  if (A.length !== B.length && !opt.prefix) return `frames ${A.length} vs ${B.length}`;
  const n = Math.min(A.length, B.length);
  let worst = 0, excess = [];
  for (let k = 0; k < n; k++) {
    const a = A[k].d, b = B[k].d;
    if (a.length !== b.length) return `frame ${k}: ${a.length} vs ${b.length} durations`;
    const ex = a.filter((_, i) => i % 2 === 0).map((v, i) => b[2 * i] - v).sort((x, y) => x - y);
    const mx = ex[ex.length >> 1]; excess.push(mx);
    const near = (x, y) => { const d = Math.abs(x - y); return d <= 100 || d <= 0.3 * Math.max(x, y); };
    for (let i = 0; i < a.length; i++) {
      const dev = Math.abs(a[i] - b[i]);
      worst = Math.max(worst, dev / a[i]);
      // irpt mode also accepts the value after removing the frame's median mark excess (receiver demodulator delay)
      const ok = opt.irpt ? near(a[i], b[i]) || near(a[i], b[i] + (i % 2 ? mx : -mx)) : dev <= Math.max(relTol * a[i], absTol);
      if (!ok) return `frame ${k} #${i}: ${a[i]} vs ${b[i]}`;
    }
    if (k < n - 1 && A[k].gap && B[k].gap && !opt.ignoreGaps && Math.abs(A[k].gap - B[k].gap) > 0.25 * A[k].gap + 2000) return `gap ${k}: ${A[k].gap} vs ${B[k].gap}`;
  }
  return { ok: true, frames: n, worstPct: Math.round(worst * 1000) / 10, info: 'median mark excess ' + excess.join('/') + 'us' };
}
// ------------------------------------------------------------------ results
const results = []; // {cat, proto, ok, what, msg}
function rec(cat, proto, ok, what, msg = '') { results.push({ cat, proto, ok, what, msg }); }

// ------------------------------------------------------------------ main
const { H, code: SRC_CODE } = loadHelm();

// decode every RAW capture referenced (R: refs, RAW_CHECKS and brand scans) in one JVM run
function rawDecodeAll(datas) {
  const todo = [...new Set(datas)].filter(d => !decodeCache.has(d));
  const out = irptBatch(todo.map(d => '38000|' + d.trim()), 'decode');
  todo.forEach((d, i) => decodeCache.set(d, parseDecode(out[i])));
}
const PREF = ['Sharp', 'RC5', 'RC6', 'NEC', 'NEC1', 'NECx', 'NECx2', 'NECx1', 'Sony12', 'Sony15', 'Sony20', 'Panasonic', 'RCA-38', 'RCA'];
function parseDecode(s) {
  // e.g. "{Sharp: {D=1,F=22},, {UNDECODED...}, Sharp{1}: ...}" -> first preferred protocol decode
  const found = [];
  for (const m of s.matchAll(/(?:^|[{,\s])([A-Za-z0-9-]+): \{([^}]*)\}/g)) {
    const p = {}; for (const kv of m[2].split(',')) { const [k, v] = kv.split('='); if (v !== undefined) p[k.trim()] = +v; }
    found.push([m[1], p]);
  }
  for (const want of PREF) {
    const f = found.find(([n]) => n === want);
    if (f) { const p = f[1]; const proto = want === 'NECx' ? 'NECx2' : want; const c = irpToHelm(proto, p.D, p.S === undefined ? -1 : p.S, p.F); if (c) return c; }
  }
  return null;
}
{
  const need = [];
  for (const b of SPEC) for (const s of b.sets) for (const k in s.keys) {
    const { kind, file, name } = parseRef(s.keys[k], s.src);
    if (kind === 'R') { const e = readFlipper(file).find(x => x.name === name); if (e && e.data) need.push(e.data); }
  }
  for (const x of XDB) { const { kind, file, name } = parseRef(x[3], 'F:'); if (kind === 'R') { const e = readFlipper(file).find(y => y.name === name); if (e && e.data) need.push(e.data); } }
  rawDecodeAll(need);
}

// resolve SPEC -> expected table
const expected = [];
let specErr = 0;
for (const b of SPEC) {
  const bo = { id: b.id, name: b.name, sets: [] };
  for (const s of b.sets) {
    const keys = {}, files = new Set([s.src.replace(/^[A-Z]+:/, '')]);
    for (const k of Object.keys(s.keys)) {
      if (!H.KEYS.includes(k)) { console.log('SPEC: unknown key ' + k); specErr++; continue; }
      const r = resolveRef(s.keys[k], s.src, s.as);
      if (r.err || !r.code) { console.log(`SPEC ${s.id}.${k}: ${r.err || 'no code'}`); specErr++; continue; }
      keys[k] = r; files.add(r.file);
    }
    bo.sets.push({ ...s, resolved: keys, files: [...files] });
  }
  expected.push(bo);
}

function emitTable() {
  const L = [];
  const short = f => f.replace(/^TVs\//, '').replace(/^codes\//, '');
  for (const b of expected) {
    L.push(`    { id: '${b.id}', name: ${JSON.stringify(b.name)}, sets: [`);
    for (const s of b.sets) {
      const cnt = new Map();
      for (const k in s.resolved) { const c = s.resolved[k].code; const t = c.protocol + '|' + c.address; cnt.set(t, (cnt.get(t) || 0) + 1); }
      const [dp, da] = [...cnt.entries()].sort((x, y) => y[1] - x[1])[0][0].split('|');
      const wa = +da > 255 ? (+da > 65535 ? 8 : 4) : 2;
      const kv = H.KEYS.filter(k => s.resolved[k]).map(k => {
        const c = s.resolved[k].code, wc = c.command > 255 ? 4 : 2;
        if (c.protocol === dp && c.address === +da) return `${k}: ${hex(c.command, wc)}`;
        if (c.protocol === dp) return `${k}: [${hex(c.address, wa)}, ${hex(c.command, wc)}]`;
        return `${k}: [${hex(c.address, c.address > 255 ? 4 : 2)}, ${hex(c.command, wc)}, '${c.protocol}']`;
      });
      const db = r => r.kind === 'I' ? 'irdb ' : r.kind === 'R' ? 'Flipper-IRDB RAW ' : 'Flipper-IRDB ';
      const main = parseRef('x', s.src);
      const byFile = new Map();
      for (const k of H.KEYS) { const r = s.resolved[k]; if (!r || r.file === main.file) continue; const f = db(r) + short(r.file); byFile.set(f, [...(byFile.get(f) || []), k]); }
      const others = [...byFile.entries()].map(([f, ks]) => ks.join('/') + ': ' + f).join('; ');
      const source = db(main) + short(main.file) + (others ? '; ' + others : '');
      L.push(`      { id: '${s.id}', label: ${JSON.stringify(s.label)}, source: ${JSON.stringify(source)}, protocol: '${dp}', address: ${hex(+da, wa)},`);
      const lines = []; let cur = '        keys: { ';
      for (const item of kv) { if ((cur + item).length > 118) { lines.push(cur.trimEnd()); cur = '          '; } cur += item + ', '; }
      lines.push(cur.replace(/, $/, ' } },'));
      L.push(...lines);
    }
    L[L.length - 1] = L[L.length - 1].replace(/,$/, '');
    L.push('    ] },');
  }
  L[L.length - 1] = L[L.length - 1].replace(/,$/, '');
  return '/*@@BRANDS@@*/\n  var BRANDS = [\n' + L.join('\n') + '\n  ];\n  /*@@END_BRANDS@@*/';
}
if (ARGS.has('--provenance')) { // markdown provenance table (see README.md)
  const fmt = c => `${c.protocol} ${hex(c.address, c.address > 255 ? 4 : 2)}/${hex(c.command, c.command > 255 ? 4 : 2)}`;
  for (const b of expected) for (const s of b.sets) {
    const main = parseRef('x', s.src);
    console.log(`\n**${b.id} / ${s.id}** - ${s.label} - main source \`${main.kind}:${main.file}\``);
    console.log('\n| key | code | source entry |\n|---|---|---|');
    for (const k of H.KEYS) { const r = s.resolved[k]; if (r) console.log(`| ${k} | ${fmt(r.code)} | ${r.kind === main.kind && r.file === main.file ? '' : r.kind + ':' + r.file + ' '}"${r.name}" |`); }
  }
  process.exit(0);
}
if (ARGS.has('--write-table')) {
  if (specErr) die('spec errors, not writing');
  const t = emitTable();
  fs.writeFileSync(path.join(HERE, 'ir.js'), SRC_CODE.replace(/\/\*@@BRANDS@@\*\/[\s\S]*?\/\*@@END_BRANDS@@\*\//, () => t));
  console.log('ir.js table written'); process.exit(0);
}

// ---- 0. static checks on ir.js (ES5-transpilable, compact)
{
  const noComments = SRC_CODE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const bad = [[/=>/, 'arrow fn'], [/\blet\s/, 'let'], [/`/, 'template literal'], [/\*\*/, '**'], [/\bBigInt\b|\d+n\b/, 'BigInt'],
    [/\(\?<[=!]/, 'lookbehind'], [/\bclass\s/, 'class'], [/\bimport\b|\bexport\b|\brequire\(/, 'module syntax']];
  for (const [re, what] of bad) rec('es5', '-', !re.test(noComments), 'no ' + what);
  rec('es5', '-', (noComments.match(/\bconst\s/g) || []).length === 1, 'single top-level const HelmIR');
  rec('es5', '-', SRC_CODE.length < 36000, `size ${SRC_CODE.length} bytes < 36000`);
}

// ---- 0b. ES5: transpile with Babel (preset-env, Android 4.4 WebView), parse as ES5, and compare every key's output
{
  const bdir = path.join(REF, 'babel/node_modules');
  if (!fs.existsSync(path.join(bdir, '@babel/core'))) rec('es5', '-', false, 'Babel not installed in _ref/babel (run _ref/fetch_refs.sh)');
  else {
    const { createRequire } = await import('node:module');
    const req = createRequire(path.join(REF, 'babel/package.json'));
    const babel = req('@babel/core'), acorn = req('acorn');
    const out = babel.transformSync(SRC_CODE, { presets: [[req.resolve('@babel/preset-env'), { targets: { android: '4.4' } }]], sourceType: 'script', babelrc: false, configFile: false }).code;
    let parsed = true; try { acorn.parse(out, { ecmaVersion: 5, sourceType: 'script' }); } catch (e) { parsed = String(e); }
    rec('es5', '-', parsed === true, 'Babel(android 4.4) output parses as ES5', parsed === true ? out.length + ' bytes' : parsed);
    const ctx5 = vm.createContext({}); vm.runInContext(out + '\n;this.__H = HelmIR;', ctx5);
    const H5 = ctx5.__H; let same = 0, diff = [];
    for (const b of H.BRANDS) for (const st of b.sets) for (const k of H.KEYS) for (const t of [0, 1]) {
      const a = H.keyPattern(b.id, st.id, k, { toggle: t }), c = H5.keyPattern(b.id, st.id, k, { toggle: t });
      if (JSON.stringify(a) === JSON.stringify(c)) same++; else diff.push(st.id + '.' + k);
    }
    rec('es5', '-', diff.length === 0, `transpiled build gives identical patterns (${same} key/toggle combos)`, diff.slice(0, 5).join(','));
  }
}

// ---- 1. src: table == sources
const keyList = []; // {brand,set,key,code,ref}
for (const b of expected) {
  const hb = H.BRANDS.find(x => x.id === b.id);
  rec('src', '-', !!hb, `brand ${b.id} present`);
  if (!hb) continue;
  for (const s of b.sets) {
    const hs = hb.sets.find(x => x.id === s.id);
    rec('src', '-', !!hs, `set ${s.id} present`);
    if (!hs) continue;
    const extra = Object.keys(hs.keys).filter(k => !s.resolved[k]);
    rec('src', '-', extra.length === 0, `${s.id}: no keys without provenance`, extra.join(','));
    for (const k of Object.keys(s.resolved)) {
      const want = s.resolved[k].code, got = H.resolve(b.id, s.id, k);
      const ok = got && got.protocol === want.protocol && got.address === want.address && got.command === want.command;
      rec('src', want.protocol, ok, `${s.id}.${k}`, ok ? '' : `table ${JSON.stringify(got)} vs source ${JSON.stringify(want)}`);
      keyList.push({ brand: b.id, set: s.id, key: k, code: want, ref: s.resolved[k] });
    }
  }
}
rec('src', '-', JSON.stringify(H.BRANDS.map(x => x.id)) === JSON.stringify(expected.map(x => x.id)), 'brand order');
for (const hb of H.BRANDS) if (!expected.find(b => b.id === hb.id)) rec('src', '-', false, `brand ${hb.id} has no provenance`);

// ---- 2. irpt + fz + lim for every key (both toggles for RC5/RC6), plus random sweeps
const cases = [];
for (const k of keyList) {
  const tg = /^RC(5|5X|6)$/.test(k.code.protocol) ? [0, 1] : [0];
  for (const t of tg) cases.push({ what: `${k.set}.${k.key}${tg.length > 1 ? ' T' + t : ''}`, code: k.code, toggle: t, repeats: 0, cat: 'irpt' });
}
let seed = 0x9E3779B9; const rnd = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; }; // xorshift32
const LIM = { NEC: [256, 256], NECext: [65536, 65536], Samsung32: [256, 256], RC5: [32, 64], RC5X: [32, 64], RC6: [256, 256], SIRC: [32, 128], SIRC15: [256, 128], SIRC20: [8192, 128], RCA: [16, 256], RCA56: [16, 256], Sharp: [32, 256] };
for (const p of H.PROTOCOLS) {
  for (let i = 0; i < 25; i++) {
    let a, c;
    if (p === 'Kaseikyo') { a = rnd(16) | (rnd(16) << 4) | (0x2002 << 8) | (rnd(4) << 24); c = rnd(1024); }
    else { [a, c] = [rnd(LIM[p][0]), rnd(LIM[p][1])]; }
    cases.push({ what: `sweep ${p} a=${a} c=${c}`, code: { protocol: p, address: a, command: c }, toggle: rnd(2), repeats: i % 5 === 0 ? 1 + rnd(3) : 0, cat: 'sweep' });
  }
}
const reqs = cases.map(cs => irpRequest(cs.code, cs.toggle));
const irptOut = irptBatch(reqs.map(r => r ? r[0] + '|' + Object.entries(r[1]).map(([k, v]) => k + '=' + v).join(',') : 'NEC1|D=0,F=0'));
cases.forEach((cs, i) => {
  const r = reqs[i], ref = irptOut[i];
  const enc = H.encode(cs.code.protocol, cs.code.address, cs.code.command, { toggle: cs.toggle, repeats: cs.repeats });
  if (!r || ref.err) { rec(cs.cat, cs.code.protocol, false, cs.what, 'no reference: ' + (ref && ref.err)); return; }
  if (!enc) { rec(cs.cat, cs.code.protocol, false, cs.what, 'encode returned null'); return; }
  const exp = expectedFromIrpt(ref, r[2], cs.repeats);
  const e1 = cmpExact(enc.pattern, exp);
  const fOk = enc.frequency === Math.round(ref.f);
  rec(cs.cat, cs.code.protocol, !e1 && fOk, cs.what, e1 ? e1 : fOk ? '' : `carrier ${enc.frequency} vs ${ref.f}`);
  // limits
  const tot = enc.pattern.reduce((x, y) => x + y, 0);
  const ints = enc.pattern.every(v => Number.isInteger(v) && v > 0);
  rec('lim', cs.code.protocol, ints && tot <= 2000000 && enc.pattern.length % 2 === 1, cs.what, `total ${tot}us, ${enc.pattern.length} entries`);
});
// stock RCA-38 / RCA definitions: identical structure, timings x(500/460); carrier within 4% (38.7k / 58k stock)
{
  const sample = keyList.filter(k => /^RCA/.test(k.code.protocol));
  const out = irptBatch(sample.map(k => (k.code.protocol === 'RCA' ? 'RCA-38' : 'RCA') + `|D=${rev(k.code.address, 4)},F=${rev(k.code.command, 8)}`));
  sample.forEach((k, i) => {
    const enc = H.encode(k.code.protocol, k.code.address, k.code.command);
    const exp = expectedFromIrpt(out[i], 'rep', 0).map(v => Math.round(v * 500 / 460));
    const e = cmpExact(enc.pattern, exp);
    rec('irpt', k.code.protocol, !e && Math.abs(enc.frequency - out[i].f) <= 0.04 * out[i].f, `${k.set}.${k.key} vs stock ${k.code.protocol === 'RCA' ? 'RCA-38' : 'RCA'} (x500/460)`, e || `carrier ${enc.frequency} vs stock ${out[i].f}`);
  });
}
// repeats clamp: 2 s limit even with absurd repeats
for (const p of H.PROTOCOLS) {
  const a = p === 'Kaseikyo' ? 0x200280 : 1, e = H.encode(p, a, 1, { repeats: 1000 });
  const tot = e.pattern.reduce((x, y) => x + y, 0);
  rec('lim', p, tot <= 2000000, `repeats:1000 clamped`, `total ${tot}us`);
  rec('lim', p, H.encode(p, -1, 0) === null && H.encode(p, 0, 1e9) === null && H.encode(p, 0.5, 1) === null, 'rejects out-of-range fields');
}
// toggle: 'auto' alternates 0,1,0 for RC5/RC6 and is ignored by other protocols
{
  const seq = [0, 1, 2].map(() => H.encode('RC6', 0, 12, { toggle: 'auto' }).pattern.join());
  const t0 = H.encode('RC6', 0, 12, { toggle: 0 }).pattern.join(), t1 = H.encode('RC6', 0, 12, { toggle: 1 }).pattern.join();
  rec('lim', 'RC6', seq[0] === t0 && seq[1] === t1 && seq[2] === t0 && t0 !== t1, "toggle:'auto' alternates 0,1,0");
  rec('lim', 'NEC', H.encode('NEC', 4, 8, { toggle: 'auto' }).pattern.join() === H.encode('NEC', 4, 8).pattern.join(), "toggle:'auto' ignored by NEC");
}
// carrier snapping helper (Samsung-style discrete list and a continuous range)
{
  const SAM = [[30000, 30000], [33000, 33000], [36000, 36000], [38000, 38000], [40000, 40000], [56000, 56000]];
  const t = [[38400, SAM, 38000], [37000, SAM, 36000], [36000, SAM, 36000], [56000, SAM, 56000], [40000, [{ min: 30000, max: 60000 }], 40000], [58000, [[30000, 57000]], 57000]];
  for (const [hz, rg, want] of t) rec('lim', '-', H.snapCarrier(hz, rg) === want, `snapCarrier(${hz}) -> ${want}`, String(H.snapCarrier(hz, rg)));
  rec('lim', '-', H.encode('NEC', 4, 8, { carriers: SAM }).frequency === 38000, 'encode opts.carriers snaps 38400 -> 38000');
}
// Flipper firmware semantics (every key with a Flipper protocol; both toggles not needed: fw starts at T=0)
{
  const fk = keyList.filter(k => FZ_PROTO[k.code.protocol]);
  const sw = cases.filter(c => c.cat === 'sweep' && FZ_PROTO[c.code.protocol] && c.toggle === 0 && c.repeats === 0);
  // Kaseikyo with arbitrary vendor/genre/id: only the Flipper firmware defines this layout (IRP Panasonic covers vendor 0x2002)
  const kv = []; for (let i = 0; i < 25; i++) { const a = rnd(0x4000000), c = rnd(1024); kv.push({ what: `sweep Kaseikyo(any vendor) a=${hex(a, 7)} c=${c}`, code: { protocol: 'Kaseikyo', address: a, command: c } }); }
  const all = [...fk.map(k => ({ what: `${k.set}.${k.key}`, code: k.code })), ...sw.map(c => ({ what: c.what, code: c.code })), ...kv];
  const out = fzBatch(all.map(x => `${FZ_PROTO[x.code.protocol]} ${x.code.address.toString(16)} ${x.code.command.toString(16)} 1`));
  all.forEach((x, i) => {
    const o = out[i];
    if (!o.startsWith('OK')) { rec('fz', x.code.protocol, false, x.what, 'flipper: ' + o); return; }
    const fzPat = o.split(' ').slice(2).map(Number);
    const enc = H.encode(x.code.protocol, x.code.address, x.code.command);
    const c = cmpFrames(enc.pattern, fzPat, 0.05, 10);
    rec('fz', x.code.protocol, c.ok === true, x.what, c.ok ? `fw carrier ${o.split(' ')[1]}Hz` : c);
  });
}

// ---- 3. raw captures
function rawCheck(cat, k, data, label, strict) {
  // strict: every duration within +-25% of our nominal value (no absolute slack, no correction);
  // otherwise IrpTransmogrifier's default decoder tolerance (100us or 30%), which absorbs receiver mark stretch.
  const enc = H.encode(k.code.protocol, k.code.address, k.code.command);
  const c = strict ? cmpFrames(enc.pattern, data, 0.25, 0, { prefix: true, ignoreGaps: true })
    : cmpFrames(enc.pattern, data, 0, 0, { prefix: true, irpt: true, ignoreGaps: true });
  rec(cat, k.code.protocol, c.ok === true, `${k.set}.${k.key} vs ${label}${strict ? ' [strict 25%]' : ''}`,
    c.ok ? `${c.frames} frame(s), worst deviation ${c.worstPct}% of nominal, ${c.info}` : c);
  return c.ok === true;
}
for (const [b, s, key, ref] of RAW_CHECKS) {
  const k = keyList.find(x => x.set === s && x.key === key);
  const [file, name] = ref.split('#');
  const e = readFlipper(file).find(x => x.name === name);
  if (!k || !e || e.type !== 'raw') { rec('raw', '-', false, ref, 'missing'); continue; }
  rawCheck('raw', k, e.data.trim().split(/\s+/).map(Number), ref + ' (label-matched)', true);
}
// keys whose source itself is a RAW capture
for (const k of keyList) if (k.ref.raw) rawCheck('raw', k, k.ref.raw, `own source ${k.ref.file}#${k.ref.name}`);
// scan: every RAW capture in the brand folders; decode -> if it is one of our codes AND its label maps to the same key, compare
const BRAND_DIRS = { tcl: ['TCL', 'Ffalcon'], hisense: ['Hisense'], samsung: ['Samsung'], lg: ['LG'], sony: ['Sony'], vizio: ['Vizio'], philips: ['Philips'],
  panasonic: ['Panasonic'], sharp: ['Sharp'], toshiba: ['Toshiba'], insignia: ['Insignia'], roku: ['Roku', 'Onn'] };
const LABEL = { power: /^(power|on_?off|pwr|tv_?pwr)$/i, vol_up: /^(vol(ume)?[_ ]?(up|\+))$/i, vol_down: /^(vol(ume)?[_ ]?(dn|down|-))$/i, mute: /^mute$/i,
  input: /^(input|source)$/i, up: /^(up|arrow_up|up_arrow)$/i, down: /^(down|dn|dwn|arrow_down|down_arrow)$/i, left: /^(left|arrow_left|left_arrow)$/i,
  right: /^(right|arrow_right|right_arrow)$/i, ok: /^(ok|enter|select)$/i, back: /^(back|return)$/i, home: /^home$/i, menu: /^menu$/i,
  ch_up: /^(ch_?(next|up)|channel_?up)$/i, ch_down: /^(ch_?(prev|down|dn)|channel_?down)$/i, play_pause: /^play_?pa(use)?$/i };
const scanStats = { raws: 0, decoded: 0, matched: 0, labelOk: 0 };
{
  const items = [];
  for (const b of SPEC) for (const dir of BRAND_DIRS[b.id] || []) {
    const abs = path.join(ROOTS.F, 'TVs', dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).filter(x => x.endsWith('.ir')).sort()) {
      for (const e of readFlipper(`TVs/${dir}/${f}`)) if (e.type === 'raw' && e.data) items.push({ brand: b.id, file: `TVs/${dir}/${f}`, e });
    }
  }
  rawDecodeAll(items.map(x => x.e.data));
  const seen = new Set();
  for (const it of items) {
    scanStats.raws++;
    const dec = decodeCache.get(it.e.data);
    if (!dec) continue;
    scanStats.decoded++;
    const lk = Object.keys(LABEL).find(k => LABEL[k].test(it.e.name));
    for (const k of keyList.filter(x => x.brand === it.brand && x.code.protocol === dec.protocol && x.code.address === dec.address && x.code.command === dec.command)) {
      scanStats.matched++;
      const tag = `${k.set}.${k.key}|${it.file}#${it.e.name}`;
      if (seen.has(tag) || k.ref.raw && k.ref.file === it.file) continue;
      seen.add(tag);
      if (lk === k.key) { scanStats.labelOk++; rawCheck('raw', k, it.e.data.trim().split(/\s+/).map(Number), `${it.file}#${it.e.name}`); }
    }
  }
}

// ---- 4. cross-database agreement
{
  const need = [];
  for (const x of XDB) { const { kind, file, name } = parseRef(x[3], 'F:'); if (kind === 'R') { const e = readFlipper(file).find(y => y.name === name); if (e) need.push(e.data); } }
  rawDecodeAll(need);
  for (const [b, s, key, ref] of XDB) {
    const k = keyList.find(x => x.set === s && x.key === key);
    const r = resolveRef(ref, 'F:');
    if (!k || r.err || !r.code) { rec('xdb', k ? k.code.protocol : '-', false, `${s}.${key} ~ ${ref}`, r.err || 'key missing'); continue; }
    const ok = r.code.protocol === k.code.protocol && r.code.address === k.code.address && r.code.command === k.code.command;
    rec('xdb', k.code.protocol, ok, `${s}.${key} ~ ${ref}`, ok ? '' : `${JSON.stringify(r.code)} vs ${JSON.stringify(k.code)}`);
  }
}

// ------------------------------------------------------------------ report
const CATS = ['src', 'irpt', 'fz', 'raw', 'xdb', 'sweep', 'lim', 'es5'];
const byP = new Map();
for (const r of results) {
  if (!byP.has(r.proto)) byP.set(r.proto, {});
  const o = byP.get(r.proto); o[r.cat] = o[r.cat] || [0, 0]; o[r.cat][r.ok ? 0 : 1]++;
}
const fails = results.filter(r => !r.ok);
if (ARGS.has('--verbose')) for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} [${r.cat}] ${r.proto} ${r.what} ${typeof r.msg === 'string' ? r.msg : JSON.stringify(r.msg)}`);
console.log('HelmIR verification  (references: IrpTransmogrifier ' + (fs.existsSync(path.join(REF, 'irpt/.git')) ? 'git ' + spawnSync('git', ['-C', path.join(REF, 'irpt'), 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim() : '') + ', Flipper firmware lib/infrared, Flipper-IRDB, irdb)');
console.log('per protocol: pass/total by check  (src=table vs source, irpt=IrpTransmogrifier +-1us, fz=Flipper firmware encoder, raw=RAW captures, xdb=cross-database, sweep=random fields vs IrpTransmogrifier, lim=limits, es5=static/Babel)');
console.log('protocol    ' + CATS.map(c => c.padEnd(10)).join('') + 'result');
for (const [p, o] of [...byP.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const bad = CATS.some(c => o[c] && o[c][1]);
  console.log(p.padEnd(12) + CATS.map(c => (o[c] ? `${o[c][0]}/${o[c][0] + o[c][1]}` : '-').padEnd(10)).join('') + (bad ? 'FAIL' : 'PASS'));
}
console.log(`raw scan: ${scanStats.raws} RAW captures in brand folders, ${scanStats.decoded} decoded by IrpTransmogrifier, ${scanStats.matched} equal one of our codes, ${scanStats.labelOk} with matching key label (compared above)`);
for (const f of fails.slice(0, 60)) console.log(`FAIL [${f.cat}] ${f.proto} ${f.what}: ${typeof f.msg === 'string' ? f.msg : JSON.stringify(f.msg)}`);
if (ARGS.has('--coverage')) {
  console.log('\ncoverage (x = key present):');
  const ab = { power: 'pwr', vol_up: 'v+', vol_down: 'v-', mute: 'mut', input: 'inp', up: 'up', down: 'dn', left: 'lt', right: 'rt', ok: 'ok', back: 'bck', home: 'hom', menu: 'mnu', play_pause: 'p/p', ch_up: 'c+', ch_down: 'c-', power_on: 'on', power_off: 'off' };
  console.log('brand      set              proto      ' + H.KEYS.map(k => ab[k].padEnd(4)).join(''));
  for (const b of H.BRANDS) for (const s of b.sets) console.log(b.id.padEnd(11) + s.id.padEnd(17) + s.protocol.padEnd(11) + H.KEYS.map(k => (s.keys.hasOwnProperty(k) ? 'x' : '.').padEnd(4)).join(''));
}
const total = results.length;
console.log(`\nSUMMARY: ${total - fails.length}/${total} checks passed, ${fails.length} failed, ${specErr} spec errors; ` +
  `${H.BRANDS.length} brands, ${H.BRANDS.reduce((a, b) => a + b.sets.length, 0)} sets, ${keyList.length} keys`);
process.exit(fails.length || specErr ? 1 : 0);
