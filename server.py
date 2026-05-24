import subprocess
import json
import urllib.request
import os
import tempfile
import shutil
from http.server import HTTPServer, BaseHTTPRequestHandler

def find_adb():
    # Check common locations
    locations = [
        '/usr/local/bin/adb',
        '/opt/homebrew/bin/adb',
        os.path.expanduser('~/Library/Android/sdk/platform-tools/adb'),
        '/usr/bin/adb',
    ]
    for loc in locations:
        if os.path.exists(loc):
            return loc
    # Try which
    result = subprocess.run(['which', 'adb'], capture_output=True, text=True)
    if result.stdout.strip():
        return result.stdout.strip()
    return None

def install_adb():
    # Try homebrew first
    brew = shutil.which('brew')
    if brew:
        subprocess.run([brew, 'install', 'android-platform-tools'], check=True)
        return find_adb()
    return None

class ADBHandler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        if self.path == '/status':
            adb = find_adb()
            response = {
                'status': 'ok',
                'adb_found': adb is not None,
                'adb_path': adb,
                'platform': 'mac'
            }
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())
        elif self.path == '/install-adb':
            try:
                adb = install_adb()
                response = {'success': adb is not None, 'adb_path': adb}
            except Exception as e:
                response = {'success': False, 'error': str(e)}
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(response).encode())

    def do_POST(self):
        length = int(self.headers['Content-Length'])
        body = json.loads(self.rfile.read(length))

        adb = find_adb() or 'adb'

        if 'command' in body:
            cmd = body.get('command', '')
            # Replace 'adb' with actual adb path
            if cmd.startswith('adb '):
                cmd = adb + cmd[3:]
            try:
                result = subprocess.run(cmd.split(), capture_output=True, text=True, timeout=30)
                response = {'output': result.stdout, 'error': result.stderr}
            except Exception as e:
                response = {'output': '', 'error': str(e)}

        elif 'install_url' in body:
            url = body['install_url']
            ip = body['ip']
            try:
                print(f'Downloading {url}...')
                tmp = tempfile.NamedTemporaryFile(suffix='.apk', delete=False)
                urllib.request.urlretrieve(url, tmp.name)
                print(f'Installing to {ip}...')
                result = subprocess.run(
                    [adb, '-s', f'{ip}:5555', 'install', '-r', tmp.name],
                    capture_output=True, text=True, timeout=120
                )
                os.unlink(tmp.name)
                response = {'output': result.stdout, 'error': result.stderr}
            except Exception as e:
                response = {'output': '', 'error': str(e)}

        elif 'install_to_phone' in body:
            # Install APK directly to the Mac (for testing) or local device
            url = body['install_to_phone']
            try:
                tmp = tempfile.NamedTemporaryFile(suffix='.apk', delete=False)
                urllib.request.urlretrieve(url, tmp.name)
                # Open the APK with the default handler
                subprocess.run(['open', tmp.name])
                response = {'output': 'Success', 'error': ''}
            except Exception as e:
                response = {'output': '', 'error': str(e)}

        else:
            response = {'output': '', 'error': 'Unknown command'}

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(response).encode())

    def log_message(self, format, *args):
        print(f'Request: {args}')

print('Helm Server running on port 5001')
print(f'ADB found: {find_adb()}')
HTTPServer(('0.0.0.0', 5001), ADBHandler).serve_forever()
