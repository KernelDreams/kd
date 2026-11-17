"""Большая фикстура UI-графа ComfyUI (часть Б): четыре копии настоящего воркфлоу «Hires Character Portrait»
(ComfyUI-Model-Librarian, example_workflows) со сдвигом позиций и новыми id нод и проводов; на каждую копию — группа."""
import json, sys
src, out = sys.argv[1], sys.argv[2]
wf = json.load(open(src))
nodes, links, groups = [], [], []
nid = lid = 0
for k in range(4):
    dx, dy = (k % 2) * 3500, (k // 2) * 1100
    idmap, lmap = {}, {}
    for n in wf['nodes']:
        nid += 1
        idmap[n['id']] = nid
    for l in wf['links']:
        lid += 1
        lmap[l[0]] = lid
    xs, ys, xe, ye = [], [], [], []
    for n in wf['nodes']:
        m = json.loads(json.dumps(n))
        m['id'] = idmap[n['id']]
        p = m['pos'] if isinstance(m['pos'], list) else [m['pos']['0'], m['pos']['1']]
        m['pos'] = [p[0] + dx, p[1] + dy]
        sz = m['size'] if isinstance(m['size'], list) else [m['size']['0'], m['size']['1']]
        xs.append(m['pos'][0]); ys.append(m['pos'][1]); xe.append(m['pos'][0] + sz[0]); ye.append(m['pos'][1] + sz[1])
        for i in m.get('inputs') or []:
            if i.get('link') is not None: i['link'] = lmap[i['link']]
        for o in m.get('outputs') or []:
            if o.get('links'): o['links'] = [lmap[x] for x in o['links']]
        nodes.append(m)
    for l in wf['links']:
        links.append([lmap[l[0]], idmap[l[1]], l[2], idmap[l[3]], l[4], l[5]])
    groups.append({'title': f'портрет {k + 1}', 'bounding': [min(xs) - 30, min(ys) - 60, max(xe) - min(xs) + 60, max(ye) - min(ys) + 90], 'color': '#3f789e'})
big = dict(wf)
big.update({'nodes': nodes, 'links': links, 'groups': groups, 'last_node_id': nid, 'last_link_id': lid})
json.dump(big, open(out, 'w'), ensure_ascii=False, indent=1)
print(len(nodes), len(links), len(groups))
