"""Google TV / Android TV remote control without developer mode.

Speaks the same protocol as Google's TV remote (the Google TV phone app and
the "TV remote" in Android's quick settings): the TV's built-in
com.google.android.tv.remote.service listens on port 6467 for pairing and
6466 for remote control, both over TLS with a client certificate. Pairing
shows a 6-character code on the TV once; after that, Helm can press keys
and open apps with no developer options on the TV at all.

No third-party packages: the protobuf messages, the RSA key and the
self-signed certificate are all done here with the standard library, so
the Mac and Windows builds need nothing new.

Protocol references (Apache-2.0): tronikos/androidtvremote2 and Google's
polo pairing protocol (android.googlesource.com/platform/external/
google-tv-pairing-protocol). Field numbers below come from their .proto
files.
"""
import hashlib
import os
import secrets
import socket
import ssl
import threading
import time
import base64

PAIR_PORT = 6467
REMOTE_PORT = 6466

# ---------------------------------------------------------------- protobuf
def _varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)

def _read_varint(buf, pos):
    shift = result = 0
    while True:
        if pos >= len(buf):
            raise IndexError('truncated varint')
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, pos
        shift += 7

def pb(*fields):
    """Encode a message from (field_number, value) pairs. ints -> varint,
    bytes/str -> length-delimited (use pb() for nested messages)."""
    out = bytearray()
    for num, val in fields:
        if val is None:
            continue
        if isinstance(val, bool):
            val = int(val)
        if isinstance(val, int):
            out += _varint(num << 3) + _varint(val)
        else:
            if isinstance(val, str):
                val = val.encode()
            out += _varint((num << 3) | 2) + _varint(len(val)) + val
    return bytes(out)

def pb_parse(buf):
    """Decode one message level into {field: [values]} (bytes for nested)."""
    fields, pos = {}, 0
    while pos < len(buf):
        key, pos = _read_varint(buf, pos)
        num, wt = key >> 3, key & 7
        if wt == 0:
            val, pos = _read_varint(buf, pos)
        elif wt == 2:
            ln, pos = _read_varint(buf, pos)
            val, pos = buf[pos:pos + ln], pos + ln
        elif wt == 1:
            val, pos = buf[pos:pos + 8], pos + 8
        elif wt == 5:
            val, pos = buf[pos:pos + 4], pos + 4
        else:
            raise ValueError('bad wire type %d' % wt)
        fields.setdefault(num, []).append(val)
    return fields

def _send(sock, msg):
    sock.sendall(_varint(len(msg)) + msg)

def _recv(sock, timeout=10):
    sock.settimeout(timeout)
    buf = b''
    while True:
        try:
            ln, pos = _read_varint(buf, 0)
            if len(buf) >= pos + ln:
                return buf[pos:pos + ln]
        except IndexError:
            pass
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError('the TV closed the connection')
        buf += chunk

# ------------------------------------------------------------------- RSA
def _is_probable_prime(n, rounds=40):
    if n < 2:
        return False
    for p in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        if n % p == 0:
            return n == p
    d, s = n - 1, 0
    while d % 2 == 0:
        d //= 2
        s += 1
    for _ in range(rounds):
        a = secrets.randbelow(n - 3) + 2
        x = pow(a, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(s - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True

def _prime(bits):
    while True:
        c = secrets.randbits(bits) | (1 << (bits - 1)) | (1 << (bits - 2)) | 1
        if _is_probable_prime(c):
            return c

def rsa_keygen(bits=2048, e=65537):
    while True:
        p, q = _prime(bits // 2), _prime(bits // 2)
        if p == q:
            continue
        phi = (p - 1) * (q - 1)
        try:
            d = pow(e, -1, phi)
        except ValueError:
            continue
        n = p * q
        if n.bit_length() == bits:
            return {'n': n, 'e': e, 'd': d, 'p': p, 'q': q}

# ------------------------------------------------------------------- DER
def _der_len(n):
    if n < 0x80:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, 'big')
    return bytes([0x80 | len(b)]) + b

def _tlv(tag, content):
    return bytes([tag]) + _der_len(len(content)) + content

def _int(n):
    b = n.to_bytes(max(1, (n.bit_length() + 8) // 8), 'big')   # leading 0 keeps it positive
    return _tlv(0x02, b)

def _seq(*parts):
    return _tlv(0x30, b''.join(parts))

def _oid(dotted):
    nums = [int(x) for x in dotted.split('.')]
    out = bytearray([40 * nums[0] + nums[1]])
    for n in nums[2:]:
        enc = [n & 0x7F]
        n >>= 7
        while n:
            enc.append(0x80 | (n & 0x7F))
            n >>= 7
        out += bytes(reversed(enc))
    return _tlv(0x06, bytes(out))

def _utf8(s):
    return _tlv(0x0C, s.encode())

def _utctime(t):
    return _tlv(0x17, time.strftime('%y%m%d%H%M%SZ', time.gmtime(t)).encode())

_SHA256_RSA = _seq(_oid('1.2.840.113549.1.1.11'), b'\x05\x00')
_RSA_ENC = _seq(_oid('1.2.840.113549.1.1.1'), b'\x05\x00')

def _sign(key, data):
    digest_info = _seq(_seq(_oid('2.16.840.1.101.3.4.2.1'), b'\x05\x00'), _tlv(0x04, hashlib.sha256(data).digest()))
    k = (key['n'].bit_length() + 7) // 8
    em = b'\x00\x01' + b'\xff' * (k - len(digest_info) - 3) + b'\x00' + digest_info
    return pow(int.from_bytes(em, 'big'), key['d'], key['n']).to_bytes(k, 'big')

def make_cert(key, common_name='Helm'):
    name = _seq(_tlv(0x31, _seq(_oid('2.5.4.3'), _utf8(common_name))))
    now = int(time.time())
    spki = _seq(_RSA_ENC, _tlv(0x03, b'\x00' + _seq(_int(key['n']), _int(key['e']))))
    tbs = _seq(
        _tlv(0xA0, _int(2)),                          # v3
        _int(secrets.randbits(63) | 1),               # serial
        _SHA256_RSA, name,
        _seq(_utctime(now - 86400), _utctime(now + 20 * 365 * 86400)),
        name, spki)
    return _seq(tbs, _SHA256_RSA, _tlv(0x03, b'\x00' + _sign(key, tbs)))

def private_key_der(key):
    p, q, d = key['p'], key['q'], key['d']
    return _seq(_int(0), _int(key['n']), _int(key['e']), _int(d), _int(p), _int(q),
                _int(d % (p - 1)), _int(d % (q - 1)), _int(pow(q, -1, p)))

def _pem(label, der):
    b = base64.b64encode(der).decode()
    return ('-----BEGIN %s-----\n' % label + '\n'.join(b[i:i + 64] for i in range(0, len(b), 64)) +
            '\n-----END %s-----\n' % label)

def _der_read(buf, pos):
    tag = buf[pos]
    ln = buf[pos + 1]
    pos += 2
    if ln & 0x80:
        nb = ln & 0x7F
        ln = int.from_bytes(buf[pos:pos + nb], 'big')
        pos += nb
    return tag, buf[pos:pos + ln], pos + ln

def cert_rsa_public(der):
    """(modulus, exponent) from a DER X.509 certificate."""
    _, cert, _ = _der_read(der, 0)
    _, tbs, _ = _der_read(cert, 0)
    pos, items = 0, []
    while pos < len(tbs):
        tag, val, pos = _der_read(tbs, pos)
        items.append((tag, val))
    if items[0][0] == 0xA0:            # explicit version
        items = items[1:]
    spki = items[5][1]                 # serial, sigalg, issuer, validity, subject, spki
    pos = 0
    _, _alg, pos = _der_read(spki, pos)
    _, bitstr, _ = _der_read(spki, pos)
    _, rsa, _ = _der_read(bitstr[1:], 0)
    _, n, p2 = _der_read(rsa, 0)
    _, e, _ = _der_read(rsa, p2)
    return int.from_bytes(n, 'big'), int.from_bytes(e, 'big')

# ------------------------------------------------------------- identity
def ensure_identity(folder):
    """Helm's own certificate + key (made once, kept in `folder`)."""
    os.makedirs(folder, exist_ok=True)
    cert_path = os.path.join(folder, 'tvremote-cert.pem')
    key_path = os.path.join(folder, 'tvremote-key.pem')
    if not (os.path.exists(cert_path) and os.path.exists(key_path)):
        key = rsa_keygen()
        with open(key_path, 'w') as f:
            f.write(_pem('RSA PRIVATE KEY', private_key_der(key)))
        try:
            os.chmod(key_path, 0o600)
        except OSError:
            pass
        with open(cert_path, 'w') as f:
            f.write(_pem('CERTIFICATE', make_cert(key)))
    return cert_path, key_path

def _context(cert_path, key_path):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE          # the TV's certificate is self-signed
    ctx.load_cert_chain(cert_path, key_path)
    return ctx

def _connect(ip, port, cert_path, key_path, timeout=8):
    raw = socket.create_connection((ip, port), timeout=timeout)
    return _context(cert_path, key_path).wrap_socket(raw)

# ---------------------------------------------------------------- pairing
OK = 200

def _outer(**fields):
    # OuterMessage: protocol_version=1, status=2, pairing_request=10,
    # options=20, configuration=30, secret=40
    parts = [(1, 2), (2, OK)]
    for num, val in sorted(fields.items()):
        parts.append((int(num[1:]), val))
    return pb(*parts)

_HEX6 = pb((1, 3), (2, 6))   # Encoding: ENCODING_TYPE_HEXADECIMAL, 6 symbols

class Pairing:
    """start() makes the TV show a code; finish(code) completes pairing."""

    def __init__(self, ip, cert_path, key_path, client_name='Helm'):
        self.ip, self.cert_path, self.key_path, self.client_name = ip, cert_path, key_path, client_name
        self.sock = None

    def _expect(self, field):
        msg = pb_parse(_recv(self.sock))
        status = msg.get(2, [OK])[0]
        if status != OK:
            raise PairingError({400: 'the TV reported an error', 401: 'the TV rejected the pairing settings',
                                402: "that code doesn't match the one on the TV"}.get(status, 'status %d' % status))
        if field not in msg:
            raise PairingError('unexpected reply from the TV')
        return msg

    def start(self):
        self.sock = _connect(self.ip, PAIR_PORT, self.cert_path, self.key_path)
        _send(self.sock, _outer(f10=pb((1, 'atvremote'), (2, self.client_name))))
        self._expect(11)                                            # pairing_request_ack
        _send(self.sock, _outer(f20=pb((1, _HEX6), (3, 1))))         # options: input, hex 6
        self._expect(20)                                            # options
        _send(self.sock, _outer(f30=pb((1, _HEX6), (2, 1))))         # configuration
        self._expect(31)                                            # configuration_ack -> code on screen

    def finish(self, code):
        code = code.strip().upper()
        if len(code) != 6 or any(c not in '0123456789ABCDEF' for c in code):
            raise PairingError('the code is 6 characters: numbers and the letters A to F')
        with open(self.cert_path, 'rb') as f:
            pem = f.read().decode()
        client_der = base64.b64decode(''.join(l for l in pem.splitlines() if not l.startswith('-----')))
        cn, ce = cert_rsa_public(client_der)
        sn, se = cert_rsa_public(self.sock.getpeercert(binary_form=True))
        h = hashlib.sha256()
        h.update(bytes.fromhex('%X' % cn))
        h.update(bytes.fromhex('0%X' % ce))
        h.update(bytes.fromhex('%X' % sn))
        h.update(bytes.fromhex('0%X' % se))
        h.update(bytes.fromhex(code[2:]))
        digest = h.digest()
        if digest[0] != int(code[:2], 16):
            raise PairingError("that code doesn't match the one on the TV")
        _send(self.sock, _outer(f40=pb((1, digest))))
        self._expect(41)                                            # secret_ack: paired
        self.close()

    def close(self):
        try:
            if self.sock:
                self.sock.close()
        except OSError:
            pass
        self.sock = None

class PairingError(Exception):
    pass

# ----------------------------------------------------------------- remote
FEATURES = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 5) | (1 << 6) | (1 << 9)   # ping, key, ime, power, volume, app link

class Remote:
    """A live remote-control connection. Answers the TV's pings in the
    background; press()/launch() send keys and app links."""

    def __init__(self, ip, cert_path, key_path):
        self.ip = ip
        self.sock = _connect(ip, REMOTE_PORT, cert_path, key_path)
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.closed = False
        self.device = {}
        self.is_on = None
        self.app = None              # package of the app on screen (from IME messages)
        self.volume = None           # {'level', 'max', 'muted'}
        self.ime = None              # (ime_counter, field_counter) while a text box is focused
        threading.Thread(target=self._reader, daemon=True).start()
        if not self.ready.wait(10):
            self.close()
            raise ConnectionError("the TV didn't finish setting up the remote")
        if self.closed:
            # The TV hangs up on certificates it hasn't paired with.
            raise NotPaired('the TV closed the remote connection')

    def _send(self, msg):
        with self.lock:
            _send(self.sock, msg)

    def _reader(self):
        try:
            while not self.closed:
                msg = pb_parse(_recv(self.sock, timeout=None))
                if 1 in msg:                                        # remote_configure
                    info = pb_parse(pb_parse(msg[1][0]).get(2, [b''])[0])
                    self.device = {'model': info.get(1, [b''])[0].decode(errors='replace'),
                                   'vendor': info.get(2, [b''])[0].decode(errors='replace')}
                    feats = pb_parse(msg[1][0]).get(1, [FEATURES])[0] & FEATURES
                    self._send(pb((1, pb((1, feats), (2, pb((3, 1), (4, '1'), (5, 'atvremote'), (6, '1.0.0')))))))
                elif 2 in msg:                                      # remote_set_active
                    self._send(pb((2, pb((1, FEATURES)))))
                elif 8 in msg:                                      # ping -> pong
                    val = pb_parse(msg[8][0]).get(1, [0])[0]
                    self._send(pb((9, pb((1, val)))))
                elif 20 in msg:                                     # remote_ime_key_inject: app on screen
                    info = pb_parse(pb_parse(msg[20][0]).get(1, [b''])[0])
                    pkg = info.get(12, [b''])[0]
                    if pkg:
                        self.app = pkg.decode(errors='replace')
                elif 21 in msg:                                     # remote_ime_batch_edit: a text box has focus
                    be = pb_parse(msg[21][0])
                    self.ime = (be.get(1, [0])[0], be.get(2, [0])[0])
                elif 50 in msg:                                     # remote_set_volume_level
                    v = pb_parse(msg[50][0])
                    self.volume = {'level': v.get(7, [0])[0], 'max': v.get(6, [0])[0], 'muted': bool(v.get(8, [0])[0])}
                elif 40 in msg:                                     # remote_start
                    self.is_on = bool(pb_parse(msg[40][0]).get(1, [0])[0])
                    self.ready.set()
        except Exception:
            pass
        finally:
            self.closed = True
            self.ready.set()

    def press(self, keycode, direction=3):
        """keycode: Android KeyEvent number (KEYCODE_HOME = 3, ...). SHORT press."""
        if self.closed:
            raise ConnectionError('not connected')
        self._send(pb((10, pb((1, int(keycode)), (2, direction)))))

    def type_text(self, text):
        """Put `text` in the text box focused on the TV (replaces what's there),
        the way Google's remote app types."""
        if self.closed:
            raise ConnectionError('not connected')
        if not self.ime:
            raise NoTextBox('no text box is open on the TV')
        ime_counter, field_counter = self.ime
        at = len(text) - 1
        edit = pb((1, 1), (2, pb((1, at), (2, at), (3, text))))
        self._send(pb((21, pb((1, ime_counter), (2, field_counter), (3, edit)))))

    def launch(self, url):
        """Open an app by link, e.g. https://www.youtube.com or market://details?id=..."""
        if self.closed:
            raise ConnectionError('not connected')
        self._send(pb((90, pb((1, url)))))

    def close(self):
        self.closed = True
        try:
            self.sock.close()
        except OSError:
            pass

# ------------------------------------------------------- for Helm's server
class TvRemoteManager:
    """What Helm's /tv-remote routes call. One pairing in progress and one
    live remote connection per TV, reused between key presses."""

    def __init__(self, folder):
        self.folder = folder
        self._identity = None
        self._lock = threading.Lock()
        self._pairings = {}
        self._remotes = {}

    def identity(self):
        with self._lock:
            if not self._identity:
                self._identity = ensure_identity(self.folder)
            return self._identity

    def pair_start(self, ip):
        cert, key = self.identity()
        old = self._pairings.pop(ip, None)
        if old:
            old.close()
        p = Pairing(ip, cert, key)
        p.start()
        self._pairings[ip] = p

    def pair_finish(self, ip, code):
        p = self._pairings.get(ip)
        if not p:
            raise PairingError('start pairing again: the code on the TV has expired')
        try:
            p.finish(code)
        finally:
            self._pairings.pop(ip, None)
        r = self._remote(ip)
        return r.device

    def _remote(self, ip):
        r = self._remotes.get(ip)
        if r and not r.closed:
            return r
        cert, key = self.identity()
        try:
            r = Remote(ip, cert, key)
        except ssl.SSLError as e:
            raise NotPaired(str(e))
        except ConnectionResetError as e:
            raise NotPaired(str(e))
        self._remotes[ip] = r
        return r

    def press(self, ip, keycode):
        for attempt in (0, 1):
            r = self._remote(ip)
            try:
                r.press(keycode)
                return
            except (OSError, ConnectionError):
                r.close()
                if attempt:
                    raise

    def type_text(self, ip, text):
        r = self._remote(ip)
        r.type_text(text)

    def state(self, ip):
        r = self._remote(ip)
        return {'app': r.app, 'volume': r.volume, 'device': r.device, 'typing': bool(r.ime)}

    def launch(self, ip, url):
        for attempt in (0, 1):
            r = self._remote(ip)
            try:
                r.launch(url)
                return
            except (OSError, ConnectionError):
                r.close()
                if attempt:
                    raise

class NotPaired(Exception):
    pass

class NoTextBox(Exception):
    pass

# ---------------------------------------------------------------- testing
if __name__ == '__main__':
    import sys
    folder = os.path.join(os.path.expanduser('~'), '.helm')
    ip, what = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else 'pair')
    print('Getting Helm\'s remote certificate ready (first time takes a few seconds)...')
    cert, key = ensure_identity(folder)
    if what == 'pair':
        p = Pairing(ip, cert, key)
        p.start()
        code = input('Type the code shown on the TV: ')
        p.finish(code)
        print('Paired!')
        what = 'test'
    r = Remote(ip, cert, key)
    print('Connected to', r.device, '- TV is', 'on' if r.is_on else 'off')
    if what == 'test':
        print('Pressing Home in 2 seconds...')
        time.sleep(2)
        r.press(3)
        time.sleep(1)
        print('Done. Did the TV go to the home screen?')
    r.close()
