#!/usr/bin/env python3
"""Build the Sellium Conversation Console layer (source console version, English neutral
object metadata, HT brand) into .tmp/htsellium. Read-only on the source console repo and the package repo.
Scratch output only; never committed.

Required env vars:
  SELLIUM_SOURCE_DIR   path to the source console repo (the one containing force-app/)
  SELLIUM_PACKAGE_DIR  path to the Sellium package repo (the one containing force-app/)
Optional:
  SELLIUM_EXCLUDE      extra regex alternation (case-insensitive, matched at the start of an item
                       name) for client-vertical components that must never be copied,
                       e.g. 'clientA|clientB_'. Keep client names here, not in the repo."""
import os, sys, shutil, re, json
def _need(name):
    v = os.environ.get(name)
    if not v:
        sys.exit('error: environment variable %s is required (see the docstring of this script)' % name)
    return v
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
D = os.path.join(_need('SELLIUM_SOURCE_DIR'), 'force-app/main/default')
P = os.path.join(_need('SELLIUM_PACKAGE_DIR'), 'force-app/main/default')
EXCL = os.environ.get('SELLIUM_EXCLUDE', '').strip('| ')
OUT = os.path.join(ROOT, '.tmp/htsellium')
O = os.path.join(OUT, 'force-app/main/default')
HT_APPS = os.path.join(ROOT, 'force-app/main/default/applications')  # retrieved ht-global (HT brand)
EXISTING_CMDT = os.path.join(ROOT, '.tmp/ht-cmdt.json')

# types never taken from source/package (client vertical / org-specific config)
SKIP_TOPS = re.compile(r'^(customMetadata|namedCredentials|externalCredentials|translations|objectTranslations|'
    r'profiles|settings|remoteSiteSettings|cspTrustedSites|sharingRules|roles|groups|permissionsetgroups|'
    r'mutingpermissionsets|email|components|cachePartitions|contentassets)$')
VERTICAL = re.compile(r'(?i)^(sellium(?!Logo)|devops|verificacion|sfdcinternal|platform\.|selliumwork'
    + ('|' + EXCL if EXCL else '') + ')')
# Source-only Sellium-owned items to add (not in package repo)
SRC_EXTRA = re.compile(r'^(Conversation|Vantegrate)')
CRED_PS = re.compile(r'(AiCredential|MetaCloudCredential)')
BASE_PS = re.compile(r'^(ConversationCampaigns|ConversationConsole|VantegrateAudit)')

if os.path.exists(OUT):
    shutil.rmtree(OUT)
os.makedirs(O)
log = {'src': 0, 'repo': 0, 'extra': [], 'objects_repo_meta': 0}

def cp(src, rel, tag):
    t = os.path.join(O, rel)
    os.makedirs(os.path.dirname(t), exist_ok=True)
    shutil.copy2(src, t); log[tag] += 1

def files(base):
    for r, _, fs in os.walk(base):
        for f in fs:
            yield os.path.relpath(os.path.join(r, f), base)

def pick(rel):
    d, p = os.path.join(D, rel), os.path.join(P, rel)
    if os.path.exists(d): cp(d, rel, 'src')
    else: cp(p, rel, 'repo')

def vertical_file(rel):
    return bool(VERTICAL.match(os.path.basename(rel).split('.')[0].split('-')[-1] if False else os.path.basename(rel)))

# ---- scope: Sellium console only (Revio = campaigns/audiences/templates/journeys/benefits/brand library excluded) ----
REVIO = re.compile(r'(?i)(campaign|audience|template|journey|redemption|benefit|brandlibrary|brandasset|automations|'
                   r'stepcampaign|contactjourneys|revio|vantegrate|opensetup_none)')
REVIO_OBJ = re.compile(r'(?i)^(ConversationAudience|ConversationAudienceMember|ConversationBrandAsset|ConversationCampaign.*|'
                       r'ConversationJourney.*|ConversationRedemption|ConversationTemplate|ConversationFollowUpTemplate)__(c|mdt)$')
# console needs these Revio-named items to compile/run; filled in by dry-run iteration (see NEEDED_FILE)
NEEDED_FILE = os.path.join(HERE, 'sellium-needed-revio.txt')
NEEDED = set(l.strip() for l in open(NEEDED_FILE)) if os.path.exists(NEEDED_FILE) else set()
def revio(top, name):
    base = name.split('.')[0] if top in ('classes','triggers','permissionsets') else name
    if (top + '/' + base) in NEEDED: return False
    return bool(REVIO.search(base))
TOPS_ALLOW = {'applications': {'Conversation_Console'}, 'tabs': {'Conversation_Home','Conversation_Console','Conversation_Console_Setup'},
 'flexipages': {'Conversation_Home','Conversation_Console_Setup','Conversation_Console_Workspace','Conversation_Communication_Record'},
 'quickActions': {'Conversation__c.Open_In_Console'},
 'reportTypes': {'Sellium_Conversations','Sellium_Conversations_with_Events','Sellium_Conversations_with_Messages'},
 'reports': {'Sellium_Reports'}, 'dashboards': {'Sellium_Dashboards'},
 'staticresources': {'ConversationChannelIcons'}}
def top_allowed(top, f):
    if top not in TOPS_ALLOW: return None
    first = f.split(os.sep)[0]
    key = re.sub(r'(\.[a-zA-Z]+-meta\.xml|\.(app|tab|flexipage|quickAction|reportType|reportFolder|dashboardFolder|resource)-meta\.xml|\.json|\.[a-z]+)$', '', first)
    key = re.sub(r'\.(app|tab|flexipage|quickAction|reportType|reportFolder|dashboardFolder|resource).*$', '', first)
    return key in TOPS_ALLOW[top] or (top+'/'+key) in NEEDED

# ---- objects: non-Revio objects fully; Revio objects only fields (object already in org, needed to compile) ----
for obj in sorted(set(os.listdir(os.path.join(P, 'objects'))) | set(os.listdir(os.path.join(D, 'objects')))):
    if VERTICAL.match(obj) and not obj.startswith('Vantegrate'): continue
    if not (obj in ('Account','Contact') or SRC_EXTRA.match(obj)): continue
    base = os.path.join('objects', obj)
    prepo = os.path.isdir(os.path.join(P, base))
    dset = set(files(os.path.join(D, base))) if os.path.isdir(os.path.join(D, base)) else set()
    pset = set(files(os.path.join(P, base))) if prepo else set()
    # The source is the source of truth for code/fields (package repo is newer in places: repo-only items are NOT taken)
    rels = (dset & pset) if '__' not in obj else dset
    if prepo: rels |= {f for f in pset if f.endswith('.object-meta.xml')}
    if not dset and '__' in obj: continue
    if not prepo and '__' in obj: log['extra'].append('objects/' + obj)
    fields_only = bool(REVIO_OBJ.match(obj)) and (base not in NEEDED)
    for f in sorted(rels):
        rel = os.path.join(base, f)
        if fields_only and not f.startswith(('fields' + os.sep, 'recordTypes' + os.sep, 'compactLayouts' + os.sep)): continue
        if f.endswith('.object-meta.xml'):
            if os.path.exists(os.path.join(P, rel)): cp(os.path.join(P, rel), rel, 'repo'); log['objects_repo_meta'] += 1
            else: log['extra'].append('NO-REPO-OBJECT-META ' + rel)
        else:
            pick(rel)

# ---- other types ----
for top in sorted(set(os.listdir(P)) | set(os.listdir(D))):
    if top == 'objects' or SKIP_TOPS.match(top) or top in ('translations',): continue
    tp, td = os.path.join(P, top), os.path.join(D, top)
    rels = set()
    if top == 'layouts' and os.path.isdir(tp): rels = set(files(tp))
    if os.path.isdir(td):
        for f in files(td):
            first = f.split(os.sep)[0]
            if top in ('classes','triggers','lwc','flexipages','tabs','quickActions','customPermissions','notificationtypes','messageChannels','labels','permissionsets','staticresources','applications','reportTypes','reports','dashboards') and (SRC_EXTRA.match(first) or re.match(r'^(Sellium_|ConversationChannelIcons)',first) or top=='labels'):
                rels.add(f)
    for f in sorted(rels):
        rel = os.path.join(top, f); first = f.split(os.sep)[0]
        if first.startswith('Vantegrate') or first.startswith('vantegrate'): continue
        if top in ('aura','pathAssistants','documents','components','cachePartitions','sharingRules','customPermissions_none'): continue
        ta = top_allowed(top, f)
        if ta is False or (ta is None and top in TOPS_ALLOW): continue
        if ta is None:
            if top == 'permissionsets':
                if not re.match(r'^Conversation(Console)', first) or CRED_PS.search(first): continue
            elif top == 'customPermissions':
                if first.startswith(('Revio','Sellium_Supervisor_Comercial','SelliumCarga','SelliumWork')): continue
            elif top == 'layouts':
                if 'Formato' in first: continue
                if re.match(r'^(Account|Contact|Order|Lead|Opportunity|Case|Asset|Event|Task|User|Global|Product2|Pricebook|Solution|Contract|Campaign|Idea|Individual|ListEmail|Enhanced|ProcessEx)', first): continue
                if re.match(r'^(Conversation[A-Za-z]*)__', first) and REVIO_OBJ.match(first.split('-')[0]): continue
            elif top == 'labels':
                pass
            elif revio(top, first): continue
        if top == 'staticresources': pass
        pick(rel)
        if not os.path.exists(os.path.join(P, rel)): log['extra'].append(rel)

# ---- dependency closure: add Revio-named classes/LWC the console strictly needs; drop tests whose deps are absent ----
def read(p):
    try: return open(p, encoding='utf-8', errors='ignore').read()
    except Exception: return ''
dcls = {f[:-4] for f in os.listdir(os.path.join(D, 'classes')) if f.endswith('.cls')}
dlwc = set(os.listdir(os.path.join(D, 'lwc')))
OC = os.path.join(O, 'classes'); OL = os.path.join(O, 'lwc'); OT = os.path.join(O, 'triggers')
os.makedirs(OL, exist_ok=True)
# Console LWC set (source version). The generic loop above only seeds SRC_EXTRA names (capitalised), which never matches
# lwc bundle names, so seed the console bundles explicitly; the closure below pulls whatever they import.
CONSOLE_LWC = ['conversationConsole', 'conversationInbox', 'conversationThread', 'conversationUtils', 'conversationHome',
               'conversationConsoleSetup', 'conversationBlockManager', 'conversationFolderManager', 'conversationConfirmDialog',
               'conversationAssignDialog', 'conversationNotes', 'conversationSheet', 'conversationSupervision']
for nm in CONSOLE_LWC:
    if not os.path.isdir(os.path.join(OL, nm)):
        shutil.copytree(os.path.join(D, 'lwc', nm), os.path.join(OL, nm))
VERT_CLS = re.compile(r'(?i)^(Sellium(?!Logo)' + ('|' + EXCL if EXCL else '') + ')')
pulled = {'classes': [], 'lwc': [], 'vertical_pulled': [], 'tests_dropped': []}
def inc_cls(): return {f[:-4] for f in os.listdir(OC) if f.endswith('.cls')}
def is_test(name): return '@istest' in read(os.path.join(OC, name + '.cls')).lower()
def strip(text):
    text = re.sub(r'/\*.*?\*/', ' ', text, flags=re.S)
    text = re.sub(r'//[^\n]*', ' ', text)
    return re.sub(r"'(?:\\.|[^'\\\n])*'", "''", text)
def tok(text): return set(re.findall(r'\b[A-Za-z_][A-Za-z0-9_]*\b', text))
changed = True
while changed:
    changed = False
    have = inc_cls()
    seeds = []
    for n in have:
        if not is_test(n): seeds.append(strip(read(os.path.join(OC, n + '.cls'))))
    for f in os.listdir(OT):
        if f.endswith('.trigger'): seeds.append(strip(read(os.path.join(OT, f))))
    for l in os.listdir(OL):
        for fn in files(os.path.join(OL, l)) if os.path.isdir(os.path.join(OL, l)) else []:
            t = read(os.path.join(OL, l, fn))
            seeds.append(t)
            for m in re.findall(r'@salesforce/apex/(\w+)\.', t): seeds.append(m)
            for m in re.findall(r'c/(\w+)', t) + re.findall(r'<c-([a-z0-9-]+)', t):
                nm = m if m in dlwc else None
                if nm is None:
                    cand = [x for x in dlwc if x.lower() == m.replace('-', '').lower()]
                    nm = cand[0] if cand else None
                if nm and not os.path.isdir(os.path.join(OL, nm)):
                    shutil.copytree(os.path.join(D, 'lwc', nm), os.path.join(OL, nm)); pulled['lwc'].append(nm); changed = True
    refs = set()
    for t in seeds: refs |= tok(t)
    for c in sorted(refs & dcls):
        if c in have: continue
        # tests are only added by being non-test dependencies (helpers); skip pure test classes
        if VERT_CLS.match(c):
            pulled['vertical_pulled'].append(c); continue
        if re.search(r'Test$', c) and '@istest' in read(os.path.join(D, 'classes', c + '.cls')).lower(): continue
        for ext in ('.cls', '.cls-meta.xml'):
            shutil.copy2(os.path.join(D, 'classes', c + ext), os.path.join(OC, c + ext))
        pulled['classes'].append(c); changed = True
# drop tests referencing classes that are not in the build
changed = True
while changed:
    changed = False
    have = inc_cls()
    for n in sorted(have):
        if not is_test(n): continue
        miss = (tok(strip(read(os.path.join(OC, n + '.cls')))) & dcls) - have
        if miss:
            for ext in ('.cls', '.cls-meta.xml'): os.remove(os.path.join(OC, n + ext))
            pulled['tests_dropped'].append(n); changed = True
# production classes referencing a LWC-less/aura etc. are not checked (compile handles it)
log['pulled'] = pulled

# ---- org's Redemption (Revio benefit) object is older (master-detail to ConversationBenefitCampaign__c): drop the Redemption
# object permission from the integration permset so it validates; Revio objects are not part of this deploy.
t = os.path.join(O, 'permissionsets', 'ConversationConsole_IntegrationAccess.permissionset-meta.xml')
if os.path.exists(t):
    x = open(t, encoding='utf-8').read()
    x = re.sub(r'\s*<objectPermissions>(?:(?!</objectPermissions>).)*?<object>ConversationRedemption__c</object>.*?</objectPermissions>', '', x, flags=re.S)
    open(t, 'w', encoding='utf-8').write(x)

# ---- English: where the source carries Spanish user-visible text and the package repo has the same item in English,
# take the repo's text for that tag occurrence (positional, only when tag counts match). Nothing else changes.
SPN = re.compile(r'[áéíóúñ¿¡]|\b(del|los|las|para|con|sin|una|que|su|conversaci[oó]n|mensaje|plantilla|campa[nñ]a|cliente|cuenta|contacto|pedido|l[ií]neas|segmentos|todas|bajas|bandeja)\b', re.I)
TAGS = ('label', 'pluralLabel', 'inlineHelpText', 'errorMessage', 'relationshipLabel', 'title')
english_fixed = []; english_left = []
for r, _, fs in os.walk(O):
    for f in fs:
        if not f.endswith('.xml'): continue
        p = os.path.join(r, f); rel = os.path.relpath(p, O)
        if rel.split(os.sep)[0] in ('classes', 'lwc', 'labels', 'customMetadata'): continue
        t = open(p, encoding='utf-8').read(); new = t; pr = os.path.join(P, rel)
        rt = open(pr, encoding='utf-8').read() if os.path.exists(pr) else None
        for tag in TAGS:
            rx = re.compile(r'(<%s>)([^<]*)(</%s>)' % (tag, tag))
            dv = rx.findall(new)
            if not any(SPN.search(v[1]) for v in dv): continue
            rv = rx.findall(rt) if rt else []
            if len(rv) == len(dv):
                it = iter(rv)
                def sub(m):
                    rvv = next(it)[1]
                    return m.group(0) if (not SPN.search(m.group(2)) or SPN.search(rvv)) else m.group(1) + rvv + m.group(3)
                new = rx.sub(sub, new)
        if new != t:
            open(p, 'w', encoding='utf-8').write(new); english_fixed.append(rel)
        for tag in TAGS:
            for m in re.finditer(r'<%s>([^<]*)</%s>' % (tag, tag), new):
                if SPN.search(m.group(1)): english_left.append((rel, tag, m.group(1)[:80]))
# remaining Spanish: no English counterpart in the package -> drop Spanish help text (optional element), translate known list views
TRANSL = {'Todas las bajas': 'All opt-outs', 'Bajas activas': 'Active opt-outs'}
stripped = 0
for rel, tag, val in list(english_left):
    p = os.path.join(O, rel); t = open(p, encoding='utf-8').read()
    if tag == 'inlineHelpText' and 'Describe how the agent' not in val:
        t2 = re.sub(r'\s*<inlineHelpText>[^<]*</inlineHelpText>', '', t); stripped += 1
    elif tag == 'label' and val in TRANSL:
        t2 = t.replace('<label>%s</label>' % val, '<label>%s</label>' % TRANSL[val])
    else: continue
    open(p, 'w', encoding='utf-8').write(t2)
english_left = [e for e in english_left if not (e[1] == 'inlineHelpText' and 'Describe how the agent' not in e[2]) and e[2] not in TRANSL]
log['spanish_helptext_stripped'] = stripped
log['english_fixed'] = len(english_fixed); log['english_left'] = english_left

# ---- English overrides: items that exist only in Spanish in both the source and the package repo (exact-string, per file) ----
OVERRIDES = {
 'objects/ConversationCampaign__c/fields/Provinces__c.field-meta.xml': [('Neuquén', 'Neuquen'), ('Río Negro', 'Rio Negro')],
 'objects/ConversationConsoleSetting__mdt/fields/PersonaHowItSpeaks__c.field-meta.xml': [('Argentino rioplatense: voseá, cercano y vivo.', 'Friendly and direct: warm, close, lively.')],
 'objects/ConversationMessagePart__c/fields/DeliveryStatus__c.field-meta.xml': [('Estado de entrega de esta parte.', 'Delivery status of this part.')],
 'objects/ConversationMessagePart__c/fields/ExternalMessageId__c.field-meta.xml': [('Id de Meta de esta parte.', 'Meta id of this part.')],
 'objects/Account/fields/ConversationStationCode__c.field-meta.xml': [('Estación Santa Rosa', 'Santa Rosa Station')],
 'labels/CustomLabels.labels-meta.xml': [('the ficha', 'the detail page'), ('the ficha shows', 'the detail page shows')],
}
english_overridden = []
for rel, pairs in OVERRIDES.items():
    p_ = os.path.join(O, rel)
    if not os.path.exists(p_): continue
    t = open(p_, encoding='utf-8').read(); n = t
    for a, b in pairs: n = n.replace(a, b)
    if n != t:
        open(p_, 'w', encoding='utf-8').write(n); english_overridden.append(rel)
log['english_overridden'] = english_overridden
log['english_left'] = [e for e in log['english_left'] if not any(e[2].startswith(a[:20]) for a, _ in OVERRIDES.get(e[0], []))]

# ---- Custom metadata: only package catalog records missing in ht-global ----
have = set()
if os.path.exists(EXISTING_CMDT):
    have = {x['fullName'] for x in json.load(open(EXISTING_CMDT))['result']}
added = []
for f in sorted(os.listdir(os.path.join(P, 'customMetadata'))):
    name = f.replace('.md-meta.xml', '')
    if name not in have and name != 'ConversationBrand.Default':
        cp(os.path.join(P, 'customMetadata', f), os.path.join('customMetadata', f), 'repo'); added.append(name)

# ---- HT brand on apps (source/package apps carry Sellium/source branding) ----
for app in ('Conversation_Console',):
    t = os.path.join(O, 'applications', app + '.app-meta.xml')
    s = open(t, encoding='utf-8').read()
    ht = os.path.join(HT_APPS, app + '.app-meta.xml')
    if os.path.exists(ht):
        m = re.search(r'<brand>.*?</brand>', open(ht, encoding='utf-8').read(), re.S)
    else:
        m = None
    if m:
        s = re.sub(r'<brand>.*?</brand>', m.group(0), s, flags=re.S) if '<brand>' in s else s
        open(t, 'w', encoding='utf-8').write(s)

open(os.path.join(OUT, '.forceignore'), 'w').write('package.xml\n\n**/jsconfig.json\n**/.eslintrc.json\n\n**/__tests__/**\n\nnode_modules/\n**/tsconfig.json\n**/*.ts\n')
open(os.path.join(OUT, 'sfdx-project.json'), 'w').write(
    '{"packageDirectories":[{"path":"force-app","default":true}],"sourceApiVersion":"67.0"}')
print(json.dumps({k: (v if not isinstance(v, list) else v) for k, v in log.items()}, indent=1))
print('cmdt added:', added)
