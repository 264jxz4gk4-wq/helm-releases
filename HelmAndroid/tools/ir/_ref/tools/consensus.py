import os, re, sys, glob, collections
sys.path.insert(0, os.path.dirname(__file__))
from survey import parse, ROOT
# Normalize Flipper key names to Helm keys (exact-ish matching on lowercase, non-alnum stripped)
MAP = {
 'power': ['power','pwr','tvpower','tvpwr','onoff','tvonoff','powa','powertoggle'],
 'vol_up': ['volup','volumeup','volplus','vup','volumeplus'],
 'vol_down': ['voldn','voldown','volumedown','volminus','vdown','voln','voldwn','volumeminus'],
 'mute': ['mute'],
 'input': ['input','source','src','inputsource','tvav','tvvideo','av'],
 'up': ['up','arrowup','navup','menuup','uparrow','cursorup'],
 'down': ['down','dn','arrowdown','navdn','navdown','menudown','downarrow','dwn','cursordown'],
 'left': ['left','arrowleft','navlft','navleft','menuleft','leftarrow','cursorleft'],
 'right': ['right','arrowright','navrgt','navright','menuright','rightarrow','cursorright'],
 'ok': ['ok','enter','select','navok','menuenter','enterok','ctr','center','entermiddle','set'],
 'back': ['back','return','navback','menuback','returnback','goback'],
 'home': ['home','smarthub','hub','smart','menuhome','navhome'],
 'menu': ['menu','navmenu'],
 'play_pause': ['playpause','playpa','pauseplay','playpaus'],
 'ch_up': ['chnext','chup','channelup','chanelup','prup','pup','chplus','pplus'],
 'ch_down': ['chprev','chdown','chdn','channeldown','chaneldown','prdown','pdown','chminus','pminus','chdwn'],
 'power_on': ['poweron','pwron','on','discreteon','poweronly_on'],
 'power_off': ['poweroff','pwroff','off','poweroffonly','discreteoff'],
 'settings': ['settings','setup','navsetting'],
 'exit': ['exit','navexit'],
}
REV = {}
for k, vs in MAP.items():
    for v in vs: REV[v] = k
def norm(name):
    n = name.lower().strip()
    n = re.sub(r'\+$', 'plus', n); n = re.sub(r'-$', 'minus', n)
    return re.sub(r'[^a-z0-9]', '', n)
def helmkey(name):
    return REV.get(norm(name))
def le(s):
    b = [int(x, 16) for x in s.split()]
    return sum(v << (8*i) for i, v in enumerate(b))
if __name__ == '__main__':
    brand = sys.argv[1]; fam = sys.argv[2] if len(sys.argv) > 2 else None
    agg = collections.defaultdict(lambda: collections.defaultdict(list))
    files = sorted(glob.glob(os.path.join(ROOT, brand, '*.ir')))
    for f in files:
        for s in parse(f):
            if s.get('type') != 'parsed': continue
            key = helmkey(s['name'])
            if not key: continue
            famk = '%s/%s' % (s['protocol'], s['address'])
            if fam and famk != fam: continue
            agg[(famk, key)][s['command']].append(os.path.basename(f).replace('.ir','') + ':' + s['name'])
    for (famk, key) in sorted(agg):
        d = agg[(famk, key)]
        print('%-28s %-10s' % (famk, key), ' | '.join('%s x%d [%s]' % (c, len(v), ', '.join(v)[:150]) for c, v in sorted(d.items(), key=lambda kv: -len(kv[1]))))
