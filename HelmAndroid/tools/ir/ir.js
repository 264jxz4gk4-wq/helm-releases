/* HelmIR - consumer-IR encoders + TV code tables for Helm.
 * Target: Android ConsumerIrManager.transmit(frequencyHz, int[] pattern) (4.4.3+ semantics:
 * alternating mark/space durations in microseconds, starting with a mark).
 * Plain ES5-compatible JS: no imports/exports, no BigInt, no **, 32-bit-safe bit ops only.
 *
 * API
 *   HelmIR.encode(protocol, address, command, opts) -> {frequency, pattern} | null
 *   HelmIR.keyPattern(brandId, setId, key, opts)    -> {frequency, pattern} | null
 *   HelmIR.resolve(brandId, setId, key)             -> {protocol, address, command} | null
 *   HelmIR.powerCandidates(brandId)                 -> [{brand, set, label}] sets that have a power key, in table order
 *   HelmIR.snapCarrier(hz, ranges)                  -> nearest supported carrier (ranges from getCarrierFrequencies())
 *   HelmIR.BRANDS, HelmIR.KEYS, HelmIR.PROTOCOLS
 * opts: toggle 0|1|'auto' (RC5/RC5X/RC6 toggle bit, default 0; it must change on every new press -
 *       'auto' flips an internal bit each time an RC5/RC6 code is encoded),
 *       repeats n (extra "button held" frames after the single-press sequence, default 0),
 *       frequency Hz (override carrier),
 *       carriers [[min,max],...] or [{min,max},...] (device ranges: carrier is snapped to the nearest one;
 *       e.g. Samsung IR blasters often list only 30/33/36/38/40/56 kHz).
 *
 * PROTOCOLS (address/command semantics == Flipper Zero .ir "parsed" fields read as
 * little-endian integers, e.g. "address: EA C7 00 00" -> 0xC7EA; Sharp is the exception, see below).
 * Timings/carriers follow IrpTransmogrifier's IrpProtocols.xml unless noted.
 *  NEC        addr 0-255 (D), cmd 0-255 (F): D,~D,F,~F, 9ms/4.5ms leader, 564us unit, 38.4kHz, 1 frame.
 *             repeats -> NEC "ditto" frames (as a held remote).          IRP: NEC1
 *  NECext     addr 0-65535 = D|S<<8, cmd 0-65535 = F|E<<8 (sent D,S,F,E). IRP: NEC1-f16 (Roku = NECext 0xC7EA)
 *  Samsung32  addr 0-255 (D, sent twice), cmd 0-255: D,D,F,~F, 4.5ms/4.5ms leader, 1 frame.   IRP: NECx2
 *  RC5        addr 0-31, cmd 0-63, toggle; 36kHz 889us bi-phase.          IRP: RC5 (F=cmd)
 *  RC5X       addr 0-31, cmd 0-63 = RC5 commands 64-127 (field bit 0).   IRP: RC5 (F=cmd+64)
 *  RC6        mode 0, addr 0-255, cmd 0-255, toggle; 36kHz 444us.        IRP: RC6
 *  SIRC       12-bit Sony: addr 0-31, cmd 0-127; 3 frames, 45ms period, 40kHz.  IRP: Sony12
 *  SIRC15     addr 0-255.                                                IRP: Sony15
 *  SIRC20     addr 0-8191 = D|S<<5.                                       IRP: Sony20
 *  Kaseikyo   Flipper layout: addr = genre2 | genre1<<4 | vendor<<8 | id<<24, cmd 0-1023.
 *             Bytes: vendor lo, vendor hi, parity|genre1<<4, genre2|cmd<<4, id<<6|cmd>>4, xor.
 *             37kHz, 432us.  For vendor 0x2002 this is IRP "Panasonic" D=byte2, S=byte3, F=byte4.
 *  RCA        addr 0-15, cmd 0-255 (Flipper: both sent LSB-first, then ~addr, ~cmd); 4ms/4ms leader,
 *             500us unit (measured on a TCL remote; IrpTransmogrifier's RCA-38 uses 460), 38kHz
 *             (IRP RCA-38 with D=bitrev4(addr), F=bitrev8(cmd)).  1 frame.
 *  RCA56      same as RCA at 56kHz (classic RCA receivers; IrpTransmogrifier "RCA" says 58k).
 *  Sharp      NOT Flipper semantics: addr = D 0-31, cmd = F 0-255 (IRP "Sharp"). A press is the normal
 *             frame followed by the inverted-command check frame (67ms frame period); 38kHz, 264us.
 *
 * BRANDS[i] = {id, name, sets:[{id, label, source, protocol, address, keys:{...}}]}
 *   key value: cmd                       (number: uses the set's protocol + address)
 *            | [address, cmd]            (address override)
 *            | [address, cmd, protocol]  (protocol override, for remotes that mix protocols)
 *   The first set of each brand is the most complete modern one; later sets are alternatives
 *   (some power-only) for a "try power codes until the TV reacts" setup flow.
 *   Codes come from Flipper-IRDB (github.com/Lucaslhm/Flipper-IRDB @d126fb1b); the tests also
 *   cross-check them against probonopd/irdb (@11aa5eb3). Per-key provenance:
 *   `node test_ir.mjs --provenance`. Sources, licensing and checks: README.md in this folder.
 */
const HelmIR = (function () {
  'use strict';

  var MAX_TOTAL = 2000000;

  // ---- sequence builder: signed durations (+mark, -space), merges equal-sign neighbours
  function Seq() { this.d = []; this.t = 0; }
  Seq.prototype.add = function (us) {
    if (!us) return;
    var n = this.d.length;
    if (n && (this.d[n - 1] > 0) === (us > 0)) this.d[n - 1] += us; else this.d.push(us);
    this.t += us < 0 ? -us : us;
  };
  Seq.prototype.m = function (us) { this.add(us); };
  Seq.prototype.s = function (us) { this.add(-us); };
  // pulse-distance bits: value, count, lsbFirst, [mark0, space0], [mark1, space1]
  Seq.prototype.pd = function (v, n, lsb, z, o) {
    for (var i = 0; i < n; i++) {
      var b = lsb ? (v >>> i) & 1 : (v >>> (n - 1 - i)) & 1;
      var p = b ? o : z;
      this.m(p[0]); this.s(p[1]);
    }
  };
  // bi-phase bits (msb first): bit 0 -> z, bit 1 -> o, each a pair of signed unit multiples
  Seq.prototype.bp = function (v, n, u, z, o) {
    for (var i = n - 1; i >= 0; i--) {
      var p = ((v >>> i) & 1) ? o : z;
      this.add(p[0] * u); this.add(p[1] * u);
    }
  };
  // pad the current frame (started at total time t0) with space up to period us
  Seq.prototype.to = function (t0, period) { var g = period - (this.t - t0); this.s(g > 0 ? g : 0); };

  function inv(v, n) { return (~v) & ((1 << n) - 1); }
  function rep(o) { var r = o && o.repeats ? o.repeats | 0 : 0; return r < 0 ? 0 : (r > 40 ? 40 : r); }

  // ---- NEC family (IrpTransmogrifier: {38.4k,564}<1,-1|1,-3>)
  var NU = 564, NZ = [NU, NU], NO = [NU, 3 * NU];
  function necFrame(q, bytes, lead) {
    var t0 = q.t;
    q.m(lead[0]); q.s(lead[1]);
    for (var i = 0; i < 4; i++) q.pd(bytes[i] & 255, 8, true, NZ, NO);
    q.m(NU); q.to(t0, 108000);
  }
  function nec(bytes, ditto, n) { // ditto: NEC1-style repeats; else full-frame repeats (Samsung32/NECx2)
    var q = new Seq(), lead = ditto ? [16 * NU, 8 * NU] : [8 * NU, 8 * NU];
    necFrame(q, bytes, lead);
    for (var r = 0; r < n; r++) {
      if (ditto) { var t0 = q.t; q.m(16 * NU); q.s(4 * NU); q.m(NU); q.to(t0, 108000); }
      else necFrame(q, bytes, lead);
    }
    return q;
  }

  // ---- RC5 (IRP {36k,msb,889}<1,-1|-1,1>((1,~F:1:6,T:1,D:5,F:6,^114m)*)
  function rc5(a, f, t, n) {
    var q = new Seq(), U = 889;
    for (var r = 0; r <= n; r++) {
      var t0 = q.t;
      q.m(U);
      var bits = ((((f >>> 6) & 1) ^ 1) << 12) | ((t & 1) << 11) | ((a & 31) << 6) | (f & 63);
      q.bp(bits, 13, U, [1, -1], [-1, 1]);
      q.to(t0, 114000);
    }
    return q;
  }
  // ---- RC6 mode 0 (IRP {36k,444,msb}<-1,1|1,-1>((6,-2,1:1,0:3,<-2,2|2,-2>(T:1),D:8,F:8,^107m)*)
  function rc6(a, f, t, n) {
    var q = new Seq(), U = 444;
    for (var r = 0; r <= n; r++) {
      var t0 = q.t;
      q.m(6 * U); q.s(2 * U);
      q.bp(8, 4, U, [-1, 1], [1, -1]);             // start bit 1, mode 000
      q.bp(t & 1, 1, U, [-2, 2], [2, -2]);         // toggle (double width)
      q.bp(((a & 255) << 8) | (f & 255), 16, U, [-1, 1], [1, -1]);
      q.to(t0, 107000);
    }
    return q;
  }
  // ---- Sony SIRC (IRP {40k,600}<1,-1|2,-1>(4,-1,F:7,D:n,^45m)*), 3 frames per press
  function sirc(nb, a, c, n) {
    var q = new Seq(), U = 600, data = (c & 127) | ((a & ((1 << (nb - 7)) - 1)) << 7);
    for (var r = 0; r < 3 + n; r++) {
      var t0 = q.t;
      q.m(4 * U); q.s(U);
      q.pd(data, nb, true, [U, U], [2 * U, U]);
      q.to(t0, 45000);
    }
    return q;
  }
  // ---- Kaseikyo, Flipper layout (IRP Panasonic {37k,432}<1,-1|1,-3>(8,-4,...48 bits...,1,-173))
  function kaseikyo(a, c, n) {
    var vendor = (a >>> 8) & 0xffff, g1 = (a >>> 4) & 15, g2 = a & 15, id = (a >>> 24) & 3;
    var b0 = vendor & 255, b1 = vendor >>> 8, par = b0 ^ b1;
    par = (par ^ (par >>> 4)) & 15;
    var b2 = par | (g1 << 4), b3 = g2 | ((c & 15) << 4), b4 = ((id << 6) | ((c >>> 4) & 63)) & 255;
    var bytes = [b0, b1, b2, b3, b4, b2 ^ b3 ^ b4], q = new Seq(), U = 432;
    for (var r = 0; r <= n; r++) {
      q.m(8 * U); q.s(4 * U);
      for (var i = 0; i < 6; i++) q.pd(bytes[i], 8, true, [U, U], [U, 3 * U]);
      q.m(U); q.s(173 * U);
    }
    return q;
  }
  // ---- RCA, Flipper field order (== IRP RCA-38 msb with D=rev4(a), F=rev8(c)); 500us unit
  function rca(a, c, n) {
    var q = new Seq(), U = 500, Z = [U, 2 * U], O = [U, 4 * U];
    for (var r = 0; r <= n; r++) {
      q.m(8 * U); q.s(8 * U);
      q.pd(a & 15, 4, true, Z, O); q.pd(c & 255, 8, true, Z, O);
      q.pd(inv(a, 4), 4, true, Z, O); q.pd(inv(c, 8), 8, true, Z, O);
      q.m(U); q.s(16 * U);
    }
    return q;
  }
  // ---- Sharp (IRP {38k,264}<1,-3|1,-7>(D:5,F:8,1:2,1,^67m,(D:5,~F:8,2:2,1,^67m,D:5,F:8,1:2,1,^67m)*))
  function sharp(d, f, n) {
    var q = new Seq(), U = 264, Z = [U, 3 * U], O = [U, 7 * U];
    function fr(cmd, ext) { var t0 = q.t; q.pd(d & 31, 5, true, Z, O); q.pd(cmd & 255, 8, true, Z, O); q.pd(ext, 2, true, Z, O); q.m(U); q.to(t0, 67000); }
    for (var r = 0; r <= n; r++) { fr(f, 1); fr(inv(f, 8), 2); }
    return q;
  }

  // protocol -> [carrierHz, maxAddress, maxCommand, encoder(a, c, toggle, extraRepeats) -> Seq, usesToggle]
  var P = {
    NEC: [38400, 255, 255, function (a, c, t, n) { return nec([a, inv(a, 8), c, inv(c, 8)], true, n); }],
    NECext: [38400, 65535, 65535, function (a, c, t, n) { return nec([a, a >>> 8, c, c >>> 8], true, n); }],
    Samsung32: [38400, 255, 255, function (a, c, t, n) { return nec([a, a, c, inv(c, 8)], false, n); }],
    RC5: [36000, 31, 63, function (a, c, t, n) { return rc5(a, c, t, n); }, 1],
    RC5X: [36000, 31, 63, function (a, c, t, n) { return rc5(a, c + 64, t, n); }, 1],
    RC6: [36000, 255, 255, function (a, c, t, n) { return rc6(a, c, t, n); }, 1],
    SIRC: [40000, 31, 127, function (a, c, t, n) { return sirc(12, a, c, n); }],
    SIRC15: [40000, 255, 127, function (a, c, t, n) { return sirc(15, a, c, n); }],
    SIRC20: [40000, 8191, 127, function (a, c, t, n) { return sirc(20, a, c, n); }],
    Kaseikyo: [37000, 0x3ffffff, 1023, function (a, c, t, n) { return kaseikyo(a, c, n); }],
    RCA: [38000, 15, 255, function (a, c, t, n) { return rca(a, c, n); }],
    RCA56: [56000, 15, 255, function (a, c, t, n) { return rca(a, c, n); }],
    Sharp: [38000, 31, 255, function (a, c, t, n) { return sharp(a, c, n); }]
  };
  var autoToggle = 0;

  function encode(protocol, address, command, opts) {
    var p = P[protocol], o = opts || {};
    if (!p) return null;
    address = +address; command = +command;
    if (!(address >= 0 && address <= p[1] && address % 1 === 0)) return null;
    if (!(command >= 0 && command <= p[2] && command % 1 === 0)) return null;
    var n = rep(o), q, t = o.toggle === 'auto' ? (p[4] ? (autoToggle ^= 1) ^ 1 : 0) : (o.toggle ? 1 : 0);
    for (;;) { // shrink extra repeats until the transmit fits Android's 2 s limit
      q = p[3](address, command, t, n);
      var d = q.d;
      while (d.length && d[d.length - 1] < 0) d.pop();  // pattern ends with a mark
      var tot = 0, pat = [];
      for (var i = 0; i < d.length; i++) { var v = Math.round(d[i] < 0 ? -d[i] : d[i]); pat.push(v); tot += v; }
      if (tot <= MAX_TOTAL || n === 0) break;
      n--;
    }
    var f = o.frequency ? Math.round(o.frequency) : p[0];
    return { frequency: o.carriers ? snapCarrier(f, o.carriers) : f, pattern: pat };
  }
  function snapCarrier(hz, ranges) {
    var best = hz, bd = -1;
    for (var i = 0; ranges && i < ranges.length; i++) {
      var r = ranges[i], lo = r.length ? r[0] : r.min, hi = r.length ? r[1] : r.max;
      var v = hz < lo ? lo : (hz > hi ? hi : hz), d = v > hz ? v - hz : hz - v;
      if (bd < 0 || d < bd) { bd = d; best = v; }
    }
    return best;
  }

  var KEYS = ['power', 'vol_up', 'vol_down', 'mute', 'input', 'up', 'down', 'left', 'right', 'ok', 'back',
    'home', 'menu', 'play_pause', 'ch_up', 'ch_down', 'power_on', 'power_off'];

  /*@@BRANDS@@*/
  var BRANDS = [
    { id: 'tcl', name: "TCL", sets: [
      { id: 'tcl_gtv', label: "TCL Google TV / Android TV (RCA-type code, 38 kHz)", source: "Flipper-IRDB TCL/TCL_65C635K.ir", protocol: 'RCA', address: 0x0F,
        keys: { power: 0x54, vol_up: 0xF4, vol_down: 0x74, mute: 0xFC, input: 0xC5, up: 0x9A, down: 0x1A, left: 0x6A,
          right: 0xEA, ok: 0x2F, back: 0xE4, home: 0x10, menu: 0x37, ch_up: 0xB4, ch_down: 0x34 } },
      { id: 'tcl_roku', label: "TCL Roku TV", source: "Flipper-IRDB TCL/TCL_50S423.ir", protocol: 'NECext', address: 0xC7EA,
        keys: { power: 0xE817, vol_up: 0xF00F, vol_down: 0xEF10, mute: 0xDF20, up: 0xE619, down: 0xCC33, left: 0xE11E,
          right: 0xD22D, ok: 0xD52A, back: 0x9966, home: 0xFC03, menu: 0x9E61, play_pause: 0xB34C } },
      { id: 'tcl_rca56', label: "TCL power, 56 kHz carrier variant", source: "Flipper-IRDB TCL/TCL_65C635K.ir", protocol: 'RCA56', address: 0x0F,
        keys: { power: 0x54 } }
    ] },
    { id: 'hisense', name: "Hisense", sets: [
      { id: 'hisense_gtv', label: "Hisense Google TV / Android TV", source: "Flipper-IRDB Hisense/Hisense_55U6K.ir", protocol: 'NEC', address: 0x04,
        keys: { power: 0x08, vol_up: 0x02, vol_down: 0x03, mute: 0x09, input: 0x0B, up: 0x56, down: 0x57, left: 0x58,
          right: 0x59, ok: 0x5A, back: 0x04, home: 0x4A, menu: 0x43, play_pause: 0x6B, ch_up: 0x00, ch_down: 0x01 } },
      { id: 'hisense_vidaa', label: "Hisense VIDAA / other Hisense smart TVs", source: "Flipper-IRDB Hisense/Hisense_32A4HAU.ir", protocol: 'NECext', address: 0xBF00,
        keys: { power: 0xF20D, vol_up: 0xBB44, vol_down: 0xBC43, mute: 0xF10E, input: 0xED12, up: 0xE916, down: 0xE817,
          left: 0xE619, right: 0xE718, ok: 0xEA15, back: 0xB748, home: 0xDF20, menu: 0xEB14, play_pause: 0x35CA,
          ch_up: 0xB54A, ch_down: 0xB44B } },
      { id: 'hisense_roku', label: "Hisense Roku TV (Roku TV code)", source: "Flipper-IRDB TCL/TCL_50S423.ir", protocol: 'NECext', address: 0xC7EA,
        keys: { power: 0xE817 } },
      { id: 'hisense_rc5', label: "Older Hisense (RC5)", source: "Flipper-IRDB RAW Hisense/Hisense_ER22601A.ir", protocol: 'RC5', address: 0x00,
        keys: { power: 0x0C } }
    ] },
    { id: 'samsung', name: "Samsung", sets: [
      { id: 'samsung', label: "Samsung TV", source: "Flipper-IRDB Samsung/Samsung_BN59-01301A.ir; play_pause: Flipper-IRDB Samsung/Samsung_BN59-01358C.ir; power_off: Flipper-IRDB Samsung/Samsung_QM55RA.ir", protocol: 'Samsung32', address: 0x07,
        keys: { power: 0x02, vol_up: 0x07, vol_down: 0x0B, mute: 0x0F, input: 0x01, up: 0x60, down: 0x61, left: 0x65,
          right: 0x62, ok: 0x68, back: 0x58, home: 0x79, menu: 0x1A, play_pause: 0xB9, ch_up: 0x12, ch_down: 0x10,
          power_off: 0x98 } },
      { id: 'samsung_smart', label: "Samsung Smart Remote power code (2016+)", source: "Flipper-IRDB Samsung/Samsung_BN59-01358C.ir", protocol: 'Samsung32', address: 0x07,
        keys: { power: 0xE6 } }
    ] },
    { id: 'lg', name: "LG", sets: [
      { id: 'lg', label: "LG TV (webOS and older)", source: "Flipper-IRDB LG/LG_AKB75855501.ir", protocol: 'NEC', address: 0x04,
        keys: { power: 0x08, vol_up: 0x02, vol_down: 0x03, mute: 0x09, input: 0x0B, up: 0x40, down: 0x41, left: 0x07,
          right: 0x06, ok: 0x44, back: 0x28, home: 0x7C, menu: 0x43, ch_up: 0x00, ch_down: 0x01 } }
    ] },
    { id: 'sony', name: "Sony", sets: [
      { id: 'sony', label: "Sony Bravia", source: "Flipper-IRDB Sony/Sony_RMF-TX500U.ir; power_on/power_off: Flipper-IRDB Sony/Sony_XBR.ir", protocol: 'SIRC', address: 0x01,
        keys: { power: 0x15, vol_up: 0x12, vol_down: 0x13, mute: 0x14, input: 0x25, up: 0x74, down: 0x75, left: 0x34,
          right: 0x33, ok: 0x65, back: [0x97, 0x23, 'SIRC15'], home: 0x60, menu: [0xC4, 0x4B, 'SIRC15'], ch_up: 0x10,
          ch_down: 0x11, power_on: 0x2E, power_off: 0x2F } }
    ] },
    { id: 'vizio', name: "Vizio", sets: [
      { id: 'vizio', label: "Vizio SmartCast / Vizio TV", source: "Flipper-IRDB Vizio/Vizio_V705-G1.ir", protocol: 'NEC', address: 0x04,
        keys: { power: 0x08, vol_up: 0x02, vol_down: 0x03, mute: 0x09, input: 0x2F, up: 0x45, down: 0x46, left: 0x47,
          right: 0x48, ok: 0x44, back: 0x4A, home: 0x2D, menu: 0x4F, ch_up: 0x00, ch_down: 0x01 } }
    ] },
    { id: 'philips', name: "Philips", sets: [
      { id: 'philips_rc6', label: "Philips (RC6; Android TV / Saphi, EU)", source: "Flipper-IRDB Philips/Philips_TV_48OLED806.ir", protocol: 'RC6', address: 0x00,
        keys: { power: 0x0C, vol_up: 0x10, vol_down: 0x11, mute: 0x0D, input: 0x38, up: 0x58, down: 0x59, left: 0x5A,
          right: 0x5B, ok: 0x5C, back: 0x0A, home: 0x54, menu: 0x57, ch_up: 0x20, ch_down: 0x21 } },
      { id: 'philips_roku', label: "Philips Roku TV (US)", source: "Flipper-IRDB Philips/Philips_40PFL6533_F7D.ir", protocol: 'NECext', address: 0xC7EA,
        keys: { power: 0xE817, vol_up: 0xF00F, vol_down: 0xEF10, mute: 0xDF20, up: 0xE619, down: 0xCC33, left: 0xE11E,
          right: 0xD22D, ok: 0xD52A, back: 0x9966, home: 0xFC03, menu: 0x9E61, play_pause: 0xB34C } },
      { id: 'philips_rc5', label: "Older Philips (RC5)", source: "Flipper-IRDB Philips/Philips_14GX8510.ir", protocol: 'RC5', address: 0x00,
        keys: { power: 0x0C, vol_up: 0x10, vol_down: 0x11, mute: 0x0D, input: 0x38, ch_up: 0x20, ch_down: 0x21 } }
    ] },
    { id: 'panasonic', name: "Panasonic", sets: [
      { id: 'panasonic', label: "Panasonic Viera", source: "Flipper-IRDB Panasonic/N2QAYB001109_full.ir", protocol: 'Kaseikyo', address: 0x00200280,
        keys: { power: 0x03D0, vol_up: 0x0200, vol_down: 0x0210, mute: 0x0320, input: 0x50, up: [0x01200280, 0xA0],
          down: [0x01200280, 0xB0], left: [0x01200280, 0xE0], right: [0x01200280, 0xF0], ok: [0x01200280, 0x90],
          back: [0x03200280, 0x0140], home: [0x02200289, 0x0150], menu: [0x01200280, 0x0120], ch_up: 0x0340,
          ch_down: 0x0350 } }
    ] },
    { id: 'sharp', name: "Sharp", sets: [
      { id: 'sharp_aquos', label: "Sharp Aquos (Sharp protocol)", source: "Flipper-IRDB RAW Sharp/Sharp_LC-RC1-16.ir", protocol: 'Sharp', address: 0x01,
        keys: { power: 0x16, vol_up: 0x14, vol_down: 0x15, mute: 0x17, input: 0x13, up: 0x57, down: 0x58, left: 0xF5,
          right: 0xF6, ok: 0xF7, home: [0x11, 0x27], menu: 0x20, ch_up: 0x11, ch_down: 0x12 } },
      { id: 'sharp_nec', label: "Sharp Aquos (newer EU models, NEC 7F00)", source: "Flipper-IRDB Sharp/Sharp_Aquos_32BG3E.ir", protocol: 'NECext', address: 0x7F00,
        keys: { power: 0xF50A, vol_up: 0xE11E, vol_down: 0xA05F, mute: 0xAF50, input: 0xAC53, up: 0xA15E, down: 0xA956,
          left: 0xA45B, right: 0xA758, ok: 0xA55A, menu: 0xA857, ch_up: 0xE01F, ch_down: 0xA35C } },
      { id: 'sharp_roku', label: "Sharp Roku TV (Roku TV code)", source: "Flipper-IRDB TCL/TCL_50S423.ir", protocol: 'NECext', address: 0xC7EA,
        keys: { power: 0xE817 } },
      { id: 'sharp_roku_nec', label: "Sharp Roku TV (NEC 0x04 code as captured)", source: "Flipper-IRDB Sharp/Sharp_Roku_TV.ir", protocol: 'NEC', address: 0x04,
        keys: { power: 0x08 } }
    ] },
    { id: 'toshiba', name: "Toshiba", sets: [
      { id: 'toshiba_firetv', label: "Toshiba Fire TV Edition", source: "Flipper-IRDB Toshiba/toshiba_firetv_v2.ir; menu: Flipper-IRDB Toshiba/Toshiba_50C350LC.ir", protocol: 'NECext', address: 0x7D02,
        keys: { power: 0xB946, vol_up: 0xF30C, vol_down: 0xE619, mute: 0xB34C, up: 0xB748, down: 0xB24D, left: 0xB14E,
          right: 0xB649, ok: 0xB54A, back: 0xF20D, home: 0x609F, menu: 0xBA45, play_pause: 0xA45B, ch_up: 0xF00F,
          ch_down: 0xA55A } },
      { id: 'toshiba_nec', label: "Toshiba (classic, NEC 0x40)", source: "Flipper-IRDB Toshiba/Toshiba_CT-32F2.ir; input: Flipper-IRDB Toshiba/Toshiba_32AV502U.ir", protocol: 'NEC', address: 0x40,
        keys: { power: 0x12, vol_up: 0x1A, vol_down: 0x1E, mute: 0x10, input: 0x0F, ch_up: 0x1B, ch_down: 0x1F } },
      { id: 'toshiba_rc5', label: "Toshiba (RC5, EU)", source: "Flipper-IRDB Toshiba/Toshiba_Ct-8563.ir", protocol: 'RC5', address: 0x01,
        keys: { power: 0x0C, vol_up: 0x10, vol_down: 0x11, mute: 0x0D, up: 0x14, down: 0x13, left: 0x15, right: 0x16,
          ok: 0x35, back: 0x0A, home: 0x2E, menu: 0x30, ch_up: 0x20, ch_down: 0x21 } }
    ] },
    { id: 'insignia', name: "Insignia", sets: [
      { id: 'insignia_firetv', label: "Insignia Fire TV Edition", source: "Flipper-IRDB Amazon/FireTV_Omni_Series_4K.ir; power: Flipper-IRDB Insignia/Insignia_NS_RCFNA_21.ir", protocol: 'NECext', address: 0x7D02,
        keys: { power: 0xB946, vol_up: 0xF30C, vol_down: 0xE619, mute: 0xB34C, up: 0xB748, down: 0xB24D, left: 0xB14E,
          right: 0xB649, ok: 0xB54A, back: 0xF20D, home: 0x609F, menu: 0xBA45, play_pause: 0xA45B, ch_up: 0xF00F,
          ch_down: 0xA55A } },
      { id: 'insignia', label: "Insignia (NS-RC remotes, NEC 0586)", source: "Flipper-IRDB Insignia/Insignia_NS_RC9DNA-14.ir", protocol: 'NECext', address: 0x0586,
        keys: { power: 0xF00F, vol_up: 0xF30C, vol_down: 0xF20D, mute: 0xF10E, input: 0xE21D, up: 0xBD42, down: 0xBC43,
          left: 0xE916, right: 0xEA15, ok: 0xE718, menu: 0xEB14, ch_up: 0xF50A, ch_down: 0xF40B } },
      { id: 'insignia_roku', label: "Insignia Roku TV (Roku TV code)", source: "Flipper-IRDB TCL/TCL_50S423.ir", protocol: 'NECext', address: 0xC7EA,
        keys: { power: 0xE817 } }
    ] },
    { id: 'roku', name: "Roku TV (TCL, Hisense, onn., Philips, Sharp, Insignia...)", sets: [
      { id: 'roku_tv', label: "Roku TV", source: "Flipper-IRDB TCL/TCL_50S423.ir", protocol: 'NECext', address: 0xC7EA,
        keys: { power: 0xE817, vol_up: 0xF00F, vol_down: 0xEF10, mute: 0xDF20, up: 0xE619, down: 0xCC33, left: 0xE11E,
          right: 0xD22D, ok: 0xD52A, back: 0x9966, home: 0xFC03, menu: 0x9E61, play_pause: 0xB34C } }
    ] }
  ];
  /*@@END_BRANDS@@*/

  function findSet(brandId, setId) {
    for (var i = 0; i < BRANDS.length; i++) {
      if (BRANDS[i].id !== brandId) continue;
      var s = BRANDS[i].sets;
      for (var j = 0; j < s.length; j++) if (s[j].id === setId) return s[j];
    }
    return null;
  }
  function resolve(brandId, setId, key) {
    var s = findSet(brandId, setId), v = s && s.keys.hasOwnProperty(key) ? s.keys[key] : null;
    if (v === null) return null;
    if (typeof v === 'number') return { protocol: s.protocol, address: s.address, command: v };
    return { protocol: v[2] || s.protocol, address: v[0], command: v[1] };
  }
  function keyPattern(brandId, setId, key, opts) {
    var r = resolve(brandId, setId, key);
    return r ? encode(r.protocol, r.address, r.command, opts) : null;
  }
  function powerCandidates(brandId) {
    var out = [];
    for (var i = 0; i < BRANDS.length; i++) {
      if (brandId && BRANDS[i].id !== brandId) continue;
      for (var j = 0; j < BRANDS[i].sets.length; j++) {
        var s = BRANDS[i].sets[j];
        if (s.keys.hasOwnProperty('power')) out.push({ brand: BRANDS[i].id, set: s.id, label: s.label });
      }
    }
    return out;
  }
  var PROTOCOLS = [];
  for (var k in P) if (P.hasOwnProperty(k)) PROTOCOLS.push(k);

  return { encode: encode, keyPattern: keyPattern, resolve: resolve, powerCandidates: powerCandidates, snapCarrier: snapCarrier,
    BRANDS: BRANDS, KEYS: KEYS, PROTOCOLS: PROTOCOLS, MAX_TOTAL_US: MAX_TOTAL };
})();
