import threading
import webbrowser
import subprocess
import os
import sys
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
UI_DIR = None  # resolved lazily

# ── Flask ───────────────────────────────────────────────────────────────────
app = Flask(__name__)

def adb(ip, cmd):
    adb_path = get_adb()
    full = f'{adb_path} -s {ip}:5555 {cmd}'
    result = subprocess.run(full, shell=True, capture_output=True, text=True, timeout=60)
    return result.stdout + result.stderr

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
        try:
            import tempfile, urllib.request
            with tempfile.NamedTemporaryFile(suffix='.apk', delete=False) as f:
                tmp = f.name
            import ssl
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            with urllib.request.urlopen(install_url, context=ctx) as u, open(tmp, "wb") as out:
                out.write(u.read())
            result = subprocess.run(f'{get_adb()} -s {ip}:5555 install -r "{tmp}"', shell=True, capture_output=True, text=True, timeout=300)
            os.unlink(tmp)
            return jsonify({'output': result.stdout + result.stderr, 'error': ''})
        except Exception as e:
            return jsonify({'output': '', 'error': str(e)})
    if command:
        adb_path = get_adb()
        if command.startswith('adb '):
            command = adb_path + command[3:]
        try:
            result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=30)
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
    subprocess.run(f'{get_adb()} connect {ip}:5555', shell=True, capture_output=True)
    output = adb(ip, 'shell getprop ro.product.model')
    return jsonify({'output': output.strip(), 'error': ''})

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

def check_update(icon, item):
    try:
        r = requests.get('https://raw.githubusercontent.com/264jxz4gk4-wq/helm-releases/main/version.json', timeout=5)
        data = r.json()
        import tkinter.messagebox as mb
        mb.showinfo('Helm Update', f"Version {data['version']} available!\n\n{data.get('notes','')}")
    except:
        pass

def quit_app(icon, item):
    icon.stop()
    os._exit(0)

def run_tray():
    icon_img = make_icon()
    menu = pystray.Menu(
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
