import rumps
import sys
import subprocess
import ipaddress
import threading
import shutil
import os
import json
import urllib.request
import tempfile
import webbrowser
import time
import socket
import concurrent.futures
from flask import Flask, request, jsonify, send_from_directory
from zeroconf import ServiceInfo, Zeroconf

def resource_path(relative_path):
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, relative_path)
    return os.path.join(BASE_DIR, relative_path)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UI_DIR = os.path.join(BASE_DIR, 'ui')
CURRENT_VERSION = "1.2.5"
VERSION_URL = "https://raw.githubusercontent.com/264jxz4gk4-wq/helm-releases/main/version.json"
PORT = 5001

# ── Security: constrain /adb to real adb invocations ────────────────────────
# The /adb route used to pass any string that did not start with "adb " to
# subprocess untouched, which made it an arbitrary-command endpoint.
ALLOWED_ADB_SUBCOMMANDS = {
    'connect', 'disconnect', 'reconnect', 'devices', 'shell', 'install',
    'uninstall', 'pair', 'get-state', 'start-server', 'kill-server',
    'wait-for-device', 'forward', 'reverse', 'push', 'pull', 'reboot',
    'root', 'unroot', 'tcpip', 'usb',
}
_ADB_FLAGS_WITH_VALUE = {'-s', '-P', '-H', '-L', '-t'}

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

LAUNCH_AGENT_PATH = os.path.expanduser('~/Library/LaunchAgents/com.helm.server.plist')

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return '127.0.0.1'

def find_adb():
    locations = [
        '/usr/local/bin/adb',
        '/opt/homebrew/bin/adb',
        os.path.expanduser('~/Library/Android/sdk/platform-tools/adb'),
    ]
    for loc in locations:
        if os.path.exists(loc):
            return loc
    result = subprocess.run(['which', 'adb'], capture_output=True, text=True)
    if result.stdout.strip():
        return result.stdout.strip()
    return None

def install_adb():
    brew = shutil.which('brew')
    if brew:
        subprocess.run([brew, 'install', 'android-platform-tools'])
        return find_adb()
    return None

def check_for_update():
    try:
        with urllib.request.urlopen(VERSION_URL, timeout=5) as r:
            data = json.loads(r.read())
        latest = data.get('version', CURRENT_VERSION)
        if latest != CURRENT_VERSION:
            return data
    except:
        pass
    return None

def is_launch_at_login():
    return os.path.exists(LAUNCH_AGENT_PATH)

def enable_launch_at_login():
    app_path = os.path.abspath(os.path.join(BASE_DIR, '..', '..', '..', '..'))
    executable = os.path.join(app_path, 'Contents', 'MacOS', 'Helm')
    if not os.path.exists(executable):
        executable = os.path.abspath(sys.executable)
    plist = f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.helm.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>{executable}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
</dict>
</plist>'''
    os.makedirs(os.path.dirname(LAUNCH_AGENT_PATH), exist_ok=True)
    with open(LAUNCH_AGENT_PATH, 'w') as f:
        f.write(plist)
    subprocess.run(['launchctl', 'load', LAUNCH_AGENT_PATH])

def disable_launch_at_login():
    if os.path.exists(LAUNCH_AGENT_PATH):
        subprocess.run(['launchctl', 'unload', LAUNCH_AGENT_PATH])
        os.remove(LAUNCH_AGENT_PATH)

def start_bonjour():
    try:
        ip = get_local_ip()
        hostname = socket.gethostname()
        zc = Zeroconf()
        info = ServiceInfo(
            "_helm._tcp.local.",
            "Helm Server._helm._tcp.local.",
            addresses=[socket.inet_aton(ip)],
            port=PORT,
            properties={
                'version': CURRENT_VERSION,
                'name': hostname,
                'platform': 'mac'
            },
        )
        zc.register_service(info)
        return zc
    except Exception as e:
        print(f"Bonjour failed: {e}")
        return None

flask_app = Flask(__name__, static_folder=UI_DIR)

@flask_app.route('/')
def index():
    return send_from_directory(UI_DIR, 'index.html')

@flask_app.route('/status')
def status():
    adb = find_adb()
    return jsonify({'status': 'ok', 'adb_found': adb is not None, 'adb_path': adb, 'platform': 'mac', 'version': CURRENT_VERSION})

@flask_app.route('/check-update')
def check_update():
    update = check_for_update()
    if update:
        return jsonify({'update': True, 'version': update.get('version'), 'notes': update.get('notes'), 'url': update.get('mac_download')})
    return jsonify({'update': False})

@flask_app.route('/install-adb')
def install_adb_route():
    result = install_adb()
    return jsonify({'success': result is not None, 'adb_path': result})

@flask_app.route('/adb', methods=['POST'])
def adb_route():
    body = request.json or {}
    adb = find_adb() or 'adb'
    if 'command' in body:
        ok, args, err = validate_adb_command(body['command'])
        if not ok:
            return jsonify({'output': '', 'error': err}), 400
        try:
            result = subprocess.run([adb] + args, capture_output=True, text=True, timeout=30)
            return jsonify({'output': result.stdout, 'error': result.stderr})
        except Exception as e:
            return jsonify({'output': '', 'error': str(e)})
    elif 'install_url' in body:
        url = body['install_url']
        ip = body['ip']
        try:
            tmp = tempfile.NamedTemporaryFile(suffix='.apk', delete=False)
            # Follow redirects (needed for mirror-based URLs like mirrors.kodi.tv)
            import urllib.request as _ur
            opener = _ur.build_opener(_ur.HTTPRedirectHandler())
            with opener.open(url, timeout=60) as resp, open(tmp.name, 'wb') as f:
                f.write(resp.read())
            result = subprocess.run(
                [adb, '-s', f'{ip}:5555', 'install', '-r', tmp.name],
                capture_output=True, text=True, timeout=120
            )
            os.unlink(tmp.name)
            return jsonify({'output': result.stdout, 'error': result.stderr})
        except Exception as e:
            return jsonify({'output': '', 'error': str(e)})
    return jsonify({'output': '', 'error': 'Unknown command'})

@flask_app.route('/scan-network', methods=['GET'])
def scan_network_route():
    adb = find_adb() or 'adb'

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        local_ip = s.getsockname()[0]
    except Exception:
        local_ip = '192.168.1.1'
    finally:
        s.close()

    subnet = '.'.join(local_ip.split('.')[:3])

    def try_connect(host_num):
        ip = f'{subnet}.{host_num}'
        try:
            result = subprocess.run(
                [adb, 'connect', f'{ip}:5555'],
                capture_output=True, text=True, timeout=1.5
            )
            if 'connected to' in result.stdout.lower():
                model = subprocess.run(
                    [adb, '-s', f'{ip}:5555', 'shell', 'getprop', 'ro.product.model'],
                    capture_output=True, text=True, timeout=2
                )
                return {'ip': ip, 'model': model.stdout.strip() or 'Unknown device'}
        except Exception:
            return None
        return None

    found = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=40) as executor:
        results = executor.map(try_connect, range(1, 255))
        for r in results:
            if r:
                found.append(r)

    return jsonify({'devices': found, 'subnet': subnet})

@flask_app.route('/pair', methods=['POST'])
def pair_route():
    data = request.json or {}
    pair_address = data.get('pair_address', '')  # e.g. "192.168.1.45:37829"
    code = data.get('code', '')                  # e.g. "123456"
    adb = find_adb() or 'adb'

    if not pair_address or not code:
        return jsonify({'success': False, 'error': 'pair_address and code required'})

    ip = pair_address.split(':')[0]

    # Step 1: pair
    try:
        pair_result = subprocess.run(
            [adb, 'pair', pair_address, code],
            capture_output=True, text=True, timeout=15
        )
        pair_out = pair_result.stdout + pair_result.stderr
        if 'failed' in pair_out.lower() or 'error' in pair_out.lower():
            return jsonify({'success': False, 'error': pair_out.strip()})
    except subprocess.TimeoutExpired:
        return jsonify({'success': False, 'error': 'Pairing timed out — make sure the code on screen matches'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

    # Step 2: connect (standard port 5555 opens after pairing)
    import time as _time
    _time.sleep(1)
    try:
        conn_result = subprocess.run(
            [adb, 'connect', f'{ip}:5555'],
            capture_output=True, text=True, timeout=10
        )
        conn_out = conn_result.stdout + conn_result.stderr
        connected = 'connected to' in conn_out.lower()

        if connected:
            model_result = subprocess.run(
                [adb, '-s', f'{ip}:5555', 'shell', 'getprop', 'ro.product.model'],
                capture_output=True, text=True, timeout=5
            )
            model = model_result.stdout.strip() or 'Unknown device'
            return jsonify({'success': True, 'ip': ip, 'model': model})
        else:
            return jsonify({'success': False, 'error': f'Paired but could not connect: {conn_out.strip()}'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})

@flask_app.before_request
def block_dns_rebinding():
    # No CORS headers are sent at all: the UI is served by this same server
    # (same origin), and the React Native app is not a browser so CORS does
    # not apply to it. Without a wildcard ACAO header, a hostile web page
    # cannot read our responses -- but it could still reach us by pointing
    # its own domain at 127.0.0.1 (DNS rebinding), so check Host directly.
    # DNS rebinding works by getting the browser to send a *hostname* that
    # resolves to us. A bare IP literal in Host cannot be rebound that way,
    # so allow any IP and reject names. This also avoids breaking users on
    # unusual LAN ranges (Tailscale's 100.x, and so on).
    host = (request.host or '').split(':')[0].strip('[]')
    if host in ('localhost', '::1'):
        return None
    try:
        ipaddress.ip_address(host)
        return None
    except ValueError:
        return jsonify({'error': 'invalid Host header'}), 403

class HelmServer(rumps.App):
    def __init__(self):
        paths = [os.path.join(os.path.dirname(sys.executable), "..", "Resources", "helm_icon.png"), os.path.join(os.path.dirname(sys.executable), "helm_icon.png"), os.path.join(BASE_DIR, "helm_icon.png"), "/Users/sethdoornbos/Desktop/Helm.app/Contents/Resources/helm_icon.png"]
        icon_path = next((p for p in paths if os.path.exists(p)), None)
        open(os.path.expanduser("~/helm_debug.log"), "w").write(f"icon_path: {icon_path}\nexists: {os.path.exists(icon_path) if icon_path else False}\nsys.executable: {sys.executable}\n")
        if icon_path is None or not os.path.exists(icon_path):
            icon_path = None
        super().__init__('', icon=icon_path, template=False, quit_button=None)
        if icon_path:
            self.title = ''
        login_check = '✓ Launch at Login' if is_launch_at_login() else 'Launch at Login'
        self.menu = [
            rumps.MenuItem('Helm', callback=None),
            None,
            rumps.MenuItem('● Running on port 5001', callback=None),
            rumps.MenuItem('ADB: Checking...', callback=None),
            rumps.MenuItem(f'Version {CURRENT_VERSION}', callback=None),
            None,
            rumps.MenuItem('Open Helm', callback=self.open_ui),
            rumps.MenuItem(login_check, callback=self.toggle_launch_at_login),
            rumps.MenuItem('Install ADB', callback=self.install_adb_action),
            None,
            rumps.MenuItem('Quit Helm', callback=self.quit_app),
        ]
        self.zeroconf = None
        self.start_server()
        self.check_adb()
        threading.Thread(target=self.auto_open, daemon=True).start()
        threading.Thread(target=self.update_check, daemon=True).start()
        threading.Thread(target=self.start_bonjour_thread, daemon=True).start()

    def auto_open(self):
        time.sleep(1.5)
        webbrowser.open('http://localhost:5001')

    def update_check(self):
        time.sleep(5)
        update = check_for_update()
        if update:
            rumps.notification(
                'Helm Update Available',
                f"Version {update.get('version')} is ready!",
                update.get('notes', 'Open Helm to update')
            )

    def start_bonjour_thread(self):
        time.sleep(2)
        self.zeroconf = start_bonjour()

    def start_server(self):
        def run():
            flask_app.run(host='0.0.0.0', port=PORT, debug=False, use_reloader=False)
        thread = threading.Thread(target=run, daemon=True)
        thread.start()

    def check_adb(self):
        adb = find_adb()
        self.menu['ADB: Checking...'].title = 'ADB: ✓ Found' if adb else 'ADB: ✗ Not found'

    def open_ui(self, _):
        webbrowser.open('http://localhost:5001')

    def toggle_launch_at_login(self, sender):
        if is_launch_at_login():
            disable_launch_at_login()
            sender.title = 'Launch at Login'
            rumps.notification('Helm', 'Launch at Login disabled', 'Helm won\'t start automatically')
        else:
            enable_launch_at_login()
            sender.title = '✓ Launch at Login'
            rumps.notification('Helm', 'Launch at Login enabled!', 'Helm will start automatically on login')

    def install_adb_action(self, _):
        rumps.notification('Helm', 'Installing ADB...', 'This may take a minute')
        result = install_adb()
        if result:
            rumps.notification('Helm', 'ADB Installed!', 'Ready to connect to devices')
            self.check_adb()
        else:
            rumps.notification('Helm', 'ADB Install Failed', 'Install Homebrew first from brew.sh')

    def quit_app(self, _):
        if self.zeroconf:
            self.zeroconf.close()
        rumps.quit_application()

if __name__ == '__main__':
    os.makedirs(UI_DIR, exist_ok=True)
    HelmServer().run()
