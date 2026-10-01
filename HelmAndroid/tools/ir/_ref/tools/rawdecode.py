import os, sys, glob, subprocess
sys.path.insert(0, os.path.dirname(__file__))
from survey import parse, ROOT
from consensus import helmkey
HERE = os.path.dirname(os.path.abspath(__file__))
brands = sys.argv[1:]
items = []
for b in brands:
    for f in sorted(glob.glob(os.path.join(ROOT, b, '*.ir'))):
        for s in parse(f):
            if s.get('type') == 'raw' and 'data' in s:
                items.append((os.path.relpath(f, ROOT), s['name'], s.get('frequency','?'), s['data']))
inp = ''.join('%s|%s\n' % (it[2] if it[2] != '?' else '38000', it[3]) for it in items)
out = subprocess.run([os.path.join(HERE, '..', 'irpref.sh'), 'decode'], input=inp, capture_output=True, text=True).stdout.splitlines()
fz = subprocess.run([os.path.join(HERE, '..', 'fzhost', 'fzhost'), 'dec'], input=''.join(it[3] + '\n' for it in items), capture_output=True, text=True).stdout.splitlines()
for it, o, z in zip(items, out, fz):
    print('%-45s %-18s %-9s %s || FZ: %s' % (it[0][:45], it[1][:18], helmkey(it[1]) or '-', o[:160], z[:60]))
