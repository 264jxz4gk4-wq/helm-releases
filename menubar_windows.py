import threading
import webbrowser
import subprocess
import ipaddress
import os
import sys
import socket
import concurrent.futures
import requests
from flask import Flask, request, jsonify, send_from_directory
from PIL import Image, ImageDraw
import pystray
import math

# ── paths ──────────────────────────────────────────────────────────────────
def resource(path):
    if hasattr(sys, '_MEIPASS'):
        # First check next to exe, then in _MEIPASS
        next_to_exe = os.path.join(os.path.dirname(sys.executable), path)
        if os.path.exists(next_to_exe):
            return next_to_exe
        return os.path.join(sys._MEIPASS, path)
    return os.path.join(os.path.dirname(__file__), path)

def get_adb():
    return resource('adb.exe')

def get_ui_dir():
    return resource('ui')

ADB = None  # resolved lazily

# Helm is a windowed app, so every console program it starts (adb.exe) would
# get a console window of its own, flashing up on each action. Ask Windows
# not to create one. subprocess.run goes through Popen, so this covers it.
if sys.platform == 'win32':
    _CREATE_NO_WINDOW = 0x08000000

    class _QuietPopen(subprocess.Popen):
        def __init__(self, *args, **kwargs):
            kwargs.setdefault('creationflags', _CREATE_NO_WINDOW)
            super().__init__(*args, **kwargs)

    subprocess.Popen = _QuietPopen
UI_DIR = None  # resolved lazily

# ── Flask ───────────────────────────────────────────────────────────────────

# ── Security helpers ────────────────────────────────────────────────────────
# Everything here used to run through `shell=True` with caller-supplied
# strings interpolated in, so /adb was a remote shell for anyone on the LAN.
import re as _re

# Only what Helm's UI sends. The server is reachable from the LAN, so nothing
# here may touch this computer's files: no push/pull, no local-path install,
# no port forwarding.
ALLOWED_ADB_SUBCOMMANDS = {
    'connect', 'disconnect', 'devices', 'get-state', 'shell', 'uninstall',
    'reboot', 'version',
}
_ADB_FLAGS_WITH_VALUE = {'-s', '-P', '-H', '-L', '-t'}
_IP_RE = _re.compile(r'^[0-9]{1,3}(\.[0-9]{1,3}){3}$')
_PAIR_RE = _re.compile(r'^[0-9]{1,3}(\.[0-9]{1,3}){3}:[0-9]{1,5}$')
_CODE_RE = _re.compile(r'^[0-9]{6}$')

def safe_pair_address(value):
    value = (value or '').strip()
    return value if _PAIR_RE.match(value) else None

def safe_pair_code(value):
    value = (value or '').strip()
    return value if _CODE_RE.match(value) else None

def validate_adb_command(raw):
    """Return (ok, argv_after_adb, error). Never returns a program name."""
    cmd = (raw or '').strip()
    if not cmd.startswith('adb '):
        return False, None, 'only adb commands are allowed'
    args = cmd[4:].split()
    if not args:
        return False, None, 'empty adb command'
    i = 0
    while i < len(args) and args[i].startswith('-'):
        i += 2 if args[i] in _ADB_FLAGS_WITH_VALUE else 1
    if i >= len(args):
        return False, None, 'no adb subcommand given'
    if args[i] not in ALLOWED_ADB_SUBCOMMANDS:
        return False, None, 'adb subcommand not allowed: %s' % args[i]
    return True, args, None

def safe_ip(value):
    """Only dotted-quad addresses reach a subprocess argument list."""
    value = (value or '').split(':')[0].strip()
    return value if _IP_RE.match(value) else None


app = Flask(__name__)

def adb(ip, cmd):
    ip = safe_ip(ip)
    if not ip:
        return 'error: invalid ip'
    args = (cmd or '').split()
    if not args or args[0] not in ALLOWED_ADB_SUBCOMMANDS:
        return 'error: adb subcommand not allowed'
    result = subprocess.run(
        [get_adb(), '-s', f'{ip}:5555'] + args,
        capture_output=True, text=True, timeout=60
    )
    return result.stdout + result.stderr


@app.before_request
def block_dns_rebinding():
    # DNS rebinding works by getting the browser to send a *hostname* that
    # resolves to us. A bare IP literal in Host cannot be rebound that way,
    # so allow any IP and reject names. This also avoids breaking users on
    # unusual LAN ranges (Tailscale's 100.x, and so on).
    host = (request.host or '').split(':')[0].strip('[]')
    if host not in ('localhost', '::1'):
        try:
            ipaddress.ip_address(host)
        except ValueError:
            return jsonify({'error': 'invalid Host header'}), 403
    if request.method == 'POST':
        refused = post_refused()
        if refused:
            return jsonify({'error': refused}), 403
    return None

def post_refused():
    """Why a POST must be refused, or None.

    A web page can send a "simple" cross-site POST (a form, or text/plain)
    without a CORS preflight, so requests must say they are JSON, which a
    cross-site page can only do after a preflight we never answer. And when
    a browser names the page that sent it (Origin), it must be our own page.
    """
    if not request.is_json:
        return 'requests must be JSON'
    origin = request.headers.get('Origin')
    if origin is not None and origin.rstrip('/') != request.host_url.rstrip('/'):
        return 'cross-origin request refused'
    return None

@app.route('/')
def index():
    return send_from_directory(get_ui_dir(), 'index.html')

@app.route('/adb', methods=['POST'])
def adb_route():
    data = request.json
    ip = data.get('ip', '')
    cmd = data.get('cmd', '')
    command = data.get('command', '')
    install_url = data.get('install_url', '')
    if install_url:
        # Store downloads are all https; anything else (file:, ftp:, http:)
        # could read local files or be swapped in transit.
        if not str(install_url).startswith('https://'):
            return jsonify({'output': '', 'error': 'only https downloads are allowed'}), 400
        safe = safe_ip(ip)
        if not safe:
            return jsonify({'output': '', 'error': 'invalid ip'}), 400
        try:
            import tempfile, urllib.request
            with tempfile.NamedTemporaryFile(suffix='.apk', delete=False) as f:
                tmp = f.name
            # TLS verification stays ON. Disabling it let anyone on the path
            # swap the APK being installed on the user's TV.
            with urllib.request.urlopen(install_url, timeout=120) as u, open(tmp, "wb") as out:
                out.write(u.read())
            result = subprocess.run(
                [get_adb(), '-s', f'{safe}:5555', 'install', '-r', tmp],
                capture_output=True, text=True, timeout=300
            )
            os.unlink(tmp)
            return jsonify({'output': result.stdout + result.stderr, 'error': ''})
        except Exception as e:
            return jsonify({'output': '', 'error': str(e)})
    if command:
        ok, args, err = validate_adb_command(command)
        if not ok:
            return jsonify({'output': '', 'error': err}), 400
        try:
            result = subprocess.run([get_adb()] + args, capture_output=True, text=True, timeout=30)
            return jsonify({'output': result.stdout, 'error': result.stderr})
        except Exception as e:
            return jsonify({'output': '', 'error': str(e)})
    if not ip or not cmd:
        return jsonify({'error': 'Missing ip or cmd'}), 400
    output = adb(ip, cmd)
    return jsonify({'output': output, 'error': ''})

@app.route('/connect', methods=['POST'])
def connect():
    data = request.json
    ip = data.get('ip', '')
    ip = safe_ip(ip)
    if not ip:
        return jsonify({'output': '', 'error': 'invalid ip'}), 400
    subprocess.run([get_adb(), 'connect', f'{ip}:5555'], capture_output=True)
    output = adb(ip, 'shell getprop ro.product.model')
    return jsonify({'output': output.strip(), 'error': ''})

def _do_adb_pair_win(adb_path, pair_address, code, timeout=15):
    """Attempt adb pair and return (success, output_string)."""
    try:
        result = subprocess.run(
            [adb_path, 'pair', pair_address, code],
            capture_output=True, text=True, timeout=timeout
        )
        out = result.stdout + result.stderr
        if 'successfully paired' in out.lower():
            return True, out
        return False, out
    except subprocess.TimeoutExpired:
        return False, 'timeout'
    except Exception as e:
        return False, str(e)

@app.route('/pair', methods=['POST'])
def pair_route():
    import time as _time
    data = request.json or {}
    pair_address = data.get('pair_address', '')
    code = data.get('code', '')
    adb_path = get_adb()

    if not pair_address or not code:
        return jsonify({'success': False, 'error': 'pair_address and code required'})

    pair_address = safe_pair_address(pair_address)
    code = safe_pair_code(code)
    if not pair_address:
        return jsonify({'success': False, 'error': 'pair_address must look like 192.168.1.45:37829'}), 400
    if not code:
        return jsonify({'success': False, 'error': 'code must be the 6 digits shown on the TV'}), 400

    ip = pair_address.split(':')[0]

    # Step 1: try pairing normally
    success, pair_out = _do_adb_pair_win(adb_path, pair_address, code)

    # Step 2: if protocol fault, reset ADB server and retry once
    if not success and ('protocol fault' in pair_out.lower() or 'error' in pair_out.lower() or 'failed' in pair_out.lower()):
        try:
            subprocess.run([adb_path, 'kill-server'], capture_output=True, timeout=5)
            _time.sleep(0.5)
            subprocess.Popen(
                [adb_path, 'nodaemon', 'server'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            _time.sleep(1.5)
            success, pair_out = _do_adb_pair_win(adb_path, pair_address, code)
        except Exception:
            pass

    if pair_out == 'timeout':
        return jsonify({'success': False, 'error': 'Pairing timed out — make sure the code on screen matches'})

    if not success:
        return jsonify({'success': False, 'error': pair_out.strip() or 'Pairing failed — get a fresh code from the TV and try again'})

    # Step 3: connect on port 5555
    _time.sleep(1)
    try:
        conn_result = subprocess.run(
            [adb_path, 'connect', f'{ip}:5555'],
            capture_output=True, text=True, timeout=10
        )
        conn_out = conn_result.stdout + conn_result.stderr
        connected = 'connected to' in conn_out.lower()
        if connected:
            model_result = subprocess.run(
                [adb_path, '-s', f'{ip}:5555', 'shell', 'getprop', 'ro.product.model'],
                capture_output=True, text=True, timeout=5
            )
            model = model_result.stdout.strip() or 'Unknown device'
            return jsonify({'success': True, 'ip': ip, 'model': model})
        else:
            return jsonify({'success': False, 'error': f'Paired but could not connect: {conn_out.strip()}'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

def _local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))   # no packet is sent; this picks the LAN interface
        return s.getsockname()[0]
    except Exception:
        return '192.168.1.1'
    finally:
        s.close()

# ---- Wake-on-LAN ----
# Some TVs keep listening for a "magic packet" while they're off. The onn.
# 4K Plus runs a vendor service for exactly this (magic_wake_daemon, started
# from /vendor/etc/init/magic_wake_daemon.rc), so Helm's Power button can
# turn the TV on even after it has stopped answering adb. The packet is 6
# bytes of 0xFF then the TV's MAC address 16 times, sent as a UDP broadcast
# (ports 9 and 7, the two that WoL listeners use).
_MAC_RE = _re.compile(r'^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$')

def send_magic_packet(mac, ip=None):
    packet = b'\xff' * 6 + bytes.fromhex(mac.replace(':', '')) * 16
    targets = ['255.255.255.255']
    if ip:
        targets.append('.'.join(ip.split('.')[:3] + ['255']))  # the TV's own /24
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        for target in targets:
            for port in (9, 7):
                try:
                    s.sendto(packet, (target, port))
                except OSError:
                    pass
    finally:
        s.close()

@app.route('/wake', methods=['POST'])
def wake_route():
    data = request.json or {}
    mac = str(data.get('mac', '')).strip()
    ip = str(data.get('ip', '')).strip().split(':')[0]
    if not _MAC_RE.match(mac) or mac.lower() in ('00:00:00:00:00:00', '02:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff'):
        return jsonify({'success': False, 'error': 'mac must look like 88:42:d0:f4:48:76'}), 400
    if ip and not _IP_RE.match(ip):
        return jsonify({'success': False, 'error': 'invalid ip'}), 400
    try:
        send_magic_packet(mac, ip or None)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

# ---- TV remote without developer mode (Google TV / Android TV) ----
# Google's own remote protocol: pair once with a code on the TV screen, then
# keys and app links work with no developer options. See atvremote.py.
import atvremote
TV_REMOTE = atvremote.TvRemoteManager(os.path.join(os.path.expanduser('~'), '.helm'))
_TVR_CODE_RE = _re.compile(r'^[0-9A-Fa-f]{6}$')

def _tvr_ip(data):
    ip = str(data.get('ip', '')).strip().split(':')[0]
    return ip if _IP_RE.match(ip) else None

@app.route('/tv-remote/status', methods=['GET'])
def tv_remote_status():
    return jsonify({'available': True})

@app.route('/tv-remote/pair-start', methods=['POST'])
def tv_remote_pair_start():
    ip = _tvr_ip(request.json or {})
    if not ip:
        return jsonify({'success': False, 'error': 'invalid ip'}), 400
    try:
        TV_REMOTE.pair_start(ip)
        return jsonify({'success': True})
    except atvremote.PairingError as e:
        return jsonify({'success': False, 'error': str(e)})
    except OSError as e:
        return jsonify({'success': False, 'error': "Couldn't reach the TV's remote service (%s). Is it a Google TV or Android TV, and on the same Wi-Fi?" % e})

@app.route('/tv-remote/pair-finish', methods=['POST'])
def tv_remote_pair_finish():
    data = request.json or {}
    ip, code = _tvr_ip(data), str(data.get('code', '')).strip()
    if not ip or not _TVR_CODE_RE.match(code):
        return jsonify({'success': False, 'error': 'the code is 6 characters: numbers and the letters A to F'}), 400
    try:
        device = TV_REMOTE.pair_finish(ip, code)
        return jsonify({'success': True, 'device': device})
    except (atvremote.PairingError, atvremote.NotPaired) as e:
        return jsonify({'success': False, 'error': str(e)})
    except OSError as e:
        return jsonify({'success': False, 'error': str(e)})

@app.route('/tv-remote/key', methods=['POST'])
def tv_remote_key():
    data = request.json or {}
    ip = _tvr_ip(data)
    try:
        key = int(data.get('key'))
    except (TypeError, ValueError):
        key = -1
    if not ip or not 0 < key < 400:
        return jsonify({'success': False, 'error': 'invalid ip or key'}), 400
    try:
        TV_REMOTE.press(ip, key)
        return jsonify({'success': True})
    except atvremote.NotPaired:
        return jsonify({'success': False, 'error': 'not_paired'})
    except OSError as e:
        return jsonify({'success': False, 'error': 'unreachable', 'detail': str(e)})

@app.route('/tv-remote/text', methods=['POST'])
def tv_remote_text():
    data = request.json or {}
    ip, text = _tvr_ip(data), str(data.get('text', ''))
    if not ip or not text or len(text) > 500:
        return jsonify({'success': False, 'error': 'invalid ip or text'}), 400
    try:
        TV_REMOTE.type_text(ip, text)
        return jsonify({'success': True})
    except atvremote.NoTextBox:
        return jsonify({'success': False, 'error': 'no_text_box'})
    except atvremote.NotPaired:
        return jsonify({'success': False, 'error': 'not_paired'})
    except OSError as e:
        return jsonify({'success': False, 'error': 'unreachable', 'detail': str(e)})

@app.route('/tv-remote/state', methods=['POST'])
def tv_remote_state():
    ip = _tvr_ip(request.json or {})
    if not ip:
        return jsonify({'success': False, 'error': 'invalid ip'}), 400
    try:
        return jsonify(dict(success=True, **TV_REMOTE.state(ip)))
    except atvremote.NotPaired:
        return jsonify({'success': False, 'error': 'not_paired'})
    except OSError as e:
        return jsonify({'success': False, 'error': 'unreachable', 'detail': str(e)})

@app.route('/tv-remote/launch', methods=['POST'])
def tv_remote_launch():
    data = request.json or {}
    ip, url = _tvr_ip(data), str(data.get('url', '')).strip()
    if not ip or len(url) > 500 or not _re.match(r'^(https?|market)://', url):
        return jsonify({'success': False, 'error': 'invalid ip or link'}), 400
    try:
        TV_REMOTE.launch(ip, url)
        return jsonify({'success': True})
    except atvremote.NotPaired:
        return jsonify({'success': False, 'error': 'not_paired'})
    except OSError as e:
        return jsonify({'success': False, 'error': 'unreachable', 'detail': str(e)})

@app.route('/scan-network', methods=['GET'])
def scan_network_route():
    """Find TVs with network debugging on in this computer's /24.

    Checks port 5555 with a plain socket first, so adb only runs for the few
    addresses that answer, not all 254.
    """
    subnet = '.'.join(_local_ip().split('.')[:3])

    def port_open(n):
        ip = f'{subnet}.{n}'
        try:
            with socket.create_connection((ip, 5555), timeout=0.6):
                return ip
        except OSError:
            return None

    with concurrent.futures.ThreadPoolExecutor(max_workers=64) as ex:
        candidates = [ip for ip in ex.map(port_open, range(1, 255)) if ip]

    def identify(ip):
        try:
            r = subprocess.run([get_adb(), 'connect', f'{ip}:5555'],
                               capture_output=True, text=True, timeout=5)
            if 'connected to' not in r.stdout.lower():
                return None
            m = subprocess.run([get_adb(), '-s', f'{ip}:5555', 'shell', 'getprop', 'ro.product.model'],
                               capture_output=True, text=True, timeout=4)
            return {'ip': ip, 'model': m.stdout.strip() or 'Unknown device'}
        except Exception:
            return None

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
        found = [d for d in ex.map(identify, candidates) if d]
    return jsonify({'devices': found, 'subnet': subnet})

@app.route('/version')
def version():
    return jsonify({'version': '1.0.0'})

def run_flask():
    app.run(host='0.0.0.0', port=5001, debug=False, use_reloader=False)

# ── Icon ────────────────────────────────────────────────────────────────────
def make_icon():
    size = 64
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx, cy = size // 2, size // 2
    scale = size / 1024
    primary = (46, 134, 255)
    outer = int(280 * scale)
    d.ellipse([cx-outer, cy-outer, cx+outer, cy+outer], outline=primary, width=max(int(28*scale),2))
    inner = int(120 * scale)
    d.ellipse([cx-inner, cy-inner, cx+inner, cy+inner], outline=primary, width=max(int(20*scale),2))
    hub = int(55 * scale)
    d.ellipse([cx-hub, cy-hub, cx+hub, cy+hub], fill=primary)
    for angle in range(0, 360, 45):
        rad = math.radians(angle)
        x1 = cx + math.sin(rad) * inner
        y1 = cy - math.cos(rad) * inner
        x2 = cx + math.sin(rad) * outer
        y2 = cy - math.cos(rad) * outer
        d.line([x1, y1, x2, y2], fill=primary, width=max(int(18*scale),2))
        ball = max(int(22*scale),3)
        d.ellipse([x2-ball, y2-ball, x2+ball, y2+ball], fill=primary)
    return img

# ── Tray ────────────────────────────────────────────────────────────────────
def open_ui(icon, item):
    webbrowser.open('http://localhost:5001')

CURRENT_VERSION = '1.3.11'

def do_update(download_url, icon):
    try:
        import tempfile, zipfile, shutil
        import tkinter.messagebox as mb
        # TLS verification MUST stay on: this downloads an executable that is
        # then run with the user's privileges. `requests` ships its own CA
        # bundle, which also avoids the missing-root-certs problem that makes
        # urllib fail inside a PyInstaller bundle.
        tmp_zip = os.path.join(tempfile.gettempdir(), 'HelmUpdate.zip')
        with requests.get(download_url, stream=True, timeout=120) as r:
            r.raise_for_status()
            with open(tmp_zip, 'wb') as f:
                for chunk in r.iter_content(65536):
                    f.write(chunk)
        extract_dir = os.path.join(tempfile.gettempdir(), 'HelmUpdate')
        if os.path.exists(extract_dir):
            shutil.rmtree(extract_dir)
        with zipfile.ZipFile(tmp_zip, 'r') as z:
            z.extractall(extract_dir)
        exe_dir = os.path.dirname(sys.executable) if hasattr(sys, '_MEIPASS') else os.path.dirname(__file__)
        bat = os.path.join(tempfile.gettempdir(), 'helm_updater.bat')
        with open(bat, 'w') as f:
            f.write('@echo off\n')
            f.write('timeout /t 2 /nobreak > nul\n')
            f.write(f'xcopy /E /Y /I "{extract_dir}\\Helm" "{exe_dir}"\n')
            f.write(f'start "" "{os.path.join(exe_dir, "Helm.exe")}"\n')
            f.write('del "%~f0"\n')
        subprocess.Popen(f'cmd /c "{bat}"', shell=True)
        icon.stop()
        os._exit(0)
    except Exception as e:
        import tkinter.messagebox as mb
        mb.showerror('Update Failed', str(e))

def check_update(icon, item):
    try:
        r = requests.get('https://raw.githubusercontent.com/264jxz4gk4-wq/helm-releases/main/version.json', timeout=5)
        data = r.json()
        latest = data.get('version', CURRENT_VERSION)
        if latest == CURRENT_VERSION:
            import tkinter.messagebox as mb
            mb.showinfo('Helm', 'You are on the latest version!')
            return
        import tkinter.messagebox as mb
        answer = mb.askyesno('Helm Update', f"Version {latest} is available!\n\n{data.get('notes', '')}\n\nInstall now?")
        if answer:
            download_url = data.get('windows_download', '')
            if download_url:
                threading.Thread(target=do_update, args=(download_url, icon), daemon=True).start()
    except Exception as e:
        import tkinter.messagebox as mb
        mb.showerror('Update Check Failed', str(e))

def quit_app(icon, item):
    icon.stop()
    os._exit(0)

def run_tray():
    icon_img = make_icon()
    adb_status = 'ADB: ✓ Found' if os.path.exists(get_adb()) else 'ADB: ✗ Not found'
    menu = pystray.Menu(
        pystray.MenuItem('Helm — TV Manager', None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('● Running on port 5001', None, enabled=False),
        pystray.MenuItem(adb_status, None, enabled=False),
        pystray.MenuItem('Version 1.0.0', None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('Open Helm', open_ui, default=True),
        pystray.MenuItem('Check for Updates', check_update),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem('Quit', quit_app),
    )
    icon = pystray.Icon('Helm', icon_img, 'Helm — TV Manager', menu)
    icon.run()

# ── Main ────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    import logging
    log_path = os.path.join(os.path.dirname(sys.executable) if hasattr(sys, '_MEIPASS') else os.path.dirname(__file__), 'helm.log')
    logging.basicConfig(filename=log_path, level=logging.DEBUG, format='%(asctime)s %(message)s')
    logging.info(f'Starting Helm')
    logging.info(f'ADB path: {get_adb()}')
    logging.info(f'ADB exists: {os.path.exists(get_adb())}')
    logging.info(f'UI dir: {get_ui_dir()}')
    logging.info(f'UI exists: {os.path.exists(get_ui_dir())}')
    threading.Thread(target=run_flask, daemon=True).start()
    import time; time.sleep(1)
    webbrowser.open('http://localhost:5001')
    run_tray()
