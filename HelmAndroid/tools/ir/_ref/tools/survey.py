import os, re, sys, glob, collections
ROOT = os.path.join(os.path.dirname(__file__), '..', 'flipper-irdb', 'TVs')
def parse(path):
    out = []; cur = None
    for line in open(path, encoding='utf-8', errors='replace'):
        line = line.rstrip('\n')
        if line.startswith('#'):
            if cur: out.append(cur); cur = None
            continue
        m = re.match(r'^(\w+):\s*(.*)$', line)
        if not m: continue
        k, v = m.group(1), m.group(2).strip()
        if k == 'name':
            if cur: out.append(cur)
            cur = {'name': v}
        elif cur is not None:
            cur[k] = v
    if cur: out.append(cur)
    return out
def le(s):
    b = [int(x, 16) for x in s.split()]
    return sum(v << (8*i) for i, v in enumerate(b))
if __name__ == '__main__':
    for b in sys.argv[1:]:
        for f in sorted(glob.glob(os.path.join(ROOT, b, '*.ir'))):
            sigs = parse(f)
            protos = collections.Counter((s.get('protocol','RAW'), s.get('address','')) for s in sigs)
            names = [s['name'] for s in sigs]
            pw = [ (s.get('protocol','RAW'), s.get('address',''), s.get('command','')) for s in sigs if s['name'].lower().startswith('power')]
            print('==', os.path.relpath(f, ROOT), len(sigs), dict(protos))
            print('   names:', ', '.join(names))
            print('   power:', pw)
