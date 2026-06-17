import rumps
import sys
import subprocess
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
CURRENT_VERSION = "1.0.0"
VERSION_URL = "https://raw.githubusercontent.com/264jxz4gk4-wq/helm-releases/main/version.json"
PORT = 5001
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

@flask_app.route('/adb', methods=['POST', 'OPTIONS'])
def adb_route():
    if request.method == 'OPTIONS':
        resp = flask_app.make_default_options_response()
        resp.headers['Access-Control-Allow-Origin'] = '*'
        resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        return resp
    body = request.json
    adb = find_adb() or 'adb'
    if 'command' in body:
        cmd = body['command']
        if cmd.startswith('adb '):
            cmd = adb + cmd[3:]
        try:
            result = subprocess.run(cmd.split(), capture_output=True, text=True, timeout=30)
            return jsonify({'output': result.stdout, 'error': result.stderr})
        except Exception as e:
            return jsonify({'output': '', 'error': str(e)})
    elif 'install_url' in body:
        url = body['install_url']
        ip = body['ip']
        try:
            tmp = tempfile.NamedTemporaryFile(suffix='.apk', delete=False)
            urllib.request.urlretrieve(url, tmp.name)
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

@flask_app.after_request
def add_cors(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return response

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
