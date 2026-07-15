// Home-page server feed ("Communities already earning with us").
//
// The list is owner-managed from the admin panel and served publicly to the
// marketing site (GET /feed). Adding a server resolves its Discord invite to a
// guild id / name / icon; the site still refreshes live member counts from the
// visitor's browser. When feedservers.json is missing we fall back to the
// original curated defaults so the feed is never empty on a fresh volume.
const crypto = require('crypto');
const { loadJSON, saveJSON } = require('./database.js');

const DEFAULT_FEED = [
    { code: 'mikutag', name: 'MIKU TAG・CHAT・SOCIAL', members: 230357, color: '#39c5bb', accent: 'linear-gradient(150deg,#39c5bb,#2f8f9c)', letter: 'M', id: '1369047464073498776', icon: 'dfab23ce3751ac4872b859eac2151ea8' },
    { code: 'yaoitag', name: 'YA0I TAG・CHAT・SOCIAL', members: 175561, color: '#e63b7a', accent: 'linear-gradient(150deg,#e63b7a,#7c2d6b)', letter: 'Y', id: '1369363539332042853', icon: 'a_355f16ede56cb094740b46546eee0a73' },
    { code: 'tagyuri', name: 'YURI TAG・CHAT・SOCIAL', members: 132614, color: '#a855f7', accent: 'linear-gradient(150deg,#a855f7,#5b2ea6)', letter: 'Y', id: '1369076925389078609', icon: '113818409cc1ab5871354f52a7e36283' },
    { code: 'teto', name: 'TETO TAG・CHAT・SOCIAL', members: 65274, color: '#d1004b', accent: 'linear-gradient(150deg,#d1004b,#7a0030)', letter: 'T', id: '1369106099608748102', icon: 'a_9421492e28203f89f5003ea2ee618537' },
    { code: 'ggif', name: 'GIFLAND СНГ', members: 50897, color: '#5865f2', accent: 'linear-gradient(150deg,#5865f2,#333a99)', letter: 'G', id: '972405591140085791', icon: 'a_096abac0dd6b01694ef7aaceaf24e613' },
    { name: 'Guild Tags | 55k+ Guilds Server Tags', members: 71156, color: '#8b5cf6', accent: 'linear-gradient(150deg,#8b5cf6,#4c2d8f)', letter: 'G', id: '724948162101293056', link: 'https://top.gg/discord/servers/724948162101293056', img: 'assets/gtl.svg' },
    { code: 'S7ftaq8qN', name: 'Server Tags', members: null, color: '#f59e0b', accent: 'linear-gradient(150deg,#f59e0b,#a85d06)', letter: 'S' },
    { code: 'lovecat', name: 'lovecat', members: null, color: '#f472b6', accent: 'linear-gradient(150deg,#f472b6,#8f2d5c)', letter: 'L' },
    { code: '9eAUqwcuC', name: 'Server', members: null, color: '#22d3ee', accent: 'linear-gradient(150deg,#22d3ee,#0e6d80)', letter: 'S' }
];

// Manual corrections for feed entries whose stored icon/invite went stale — a
// server changed its icon AND its old invite expired, so the feed can't resolve
// the new one on its own. Keyed by guild id; applied on read so the current
// avatar always shows without mutating the stored file.
const ICON_OVERRIDES = {
    // sunlace — icon + invite changed; old hash 404s at the sizes we request.
    '1346550267386007592': { icon: '62e92c5f8f9e57253125584c0398debc', code: 'EpfpUng7f' }
};

function loadFeed() {
    const raw = loadJSON('feedservers.json', null);
    const list = Array.isArray(raw) ? raw : DEFAULT_FEED.map((s) => ({ ...s }));
    return list.map((s) => {
        const o = s && s.id && ICON_OVERRIDES[String(s.id)];
        return o ? { ...s, ...o } : s;
    });
}
function saveFeed(list) {
    saveJSON('feedservers.json', Array.isArray(list) ? list : []);
    return loadFeed();
}

const PALETTE = ['#5865f2', '#e63b7a', '#a855f7', '#39c5bb', '#f59e0b', '#22d3ee', '#f472b6', '#8b5cf6', '#d1004b', '#10b981'];
function colorFor(seed) {
    const h = crypto.createHash('sha1').update(String(seed || '')).digest();
    return PALETTE[h[0] % PALETTE.length];
}

// Build a feed card item from a resolved Discord invite object.
function itemFromInvite(inv, code) {
    const g = inv?.guild || {};
    const color = colorFor(g.id || code);
    const name = g.name || 'Server';
    return {
        code,
        id: g.id || null,
        name,
        icon: g.icon || null,
        members: (inv && (inv.approximate_member_count ?? inv.memberCount)) ?? null,
        color,
        accent: `linear-gradient(150deg, ${color}, ${color}88)`,
        letter: (name.trim()[0] || 'S').toUpperCase()
    };
}

module.exports = { loadFeed, saveFeed, itemFromInvite, DEFAULT_FEED };
