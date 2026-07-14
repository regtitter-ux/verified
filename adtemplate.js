// Default ad-text templates for verification cards.
//
// The owner sets a template once (globally, or per server) with `/advertising-text`;
// the template contains a `{link}` placeholder. After that, `!adv3 <link>` (or
// `!adv3 <serverId> <link>`) only needs the sponsor link — the bot drops it into the
// template's `{link}` and stores the finished ad text.
//
// Stored in adtemplates.json: { "default": "<template>", "servers": { "<gid>": "<template>" } }
const { loadJSON, saveJSON } = require('./database.js');

const DEFAULT_TEMPLATE =
    '# To complete verification, you must join the server: {link}\n' +
    '- After joining, click the button again';

function load() {
    const t = loadJSON('adtemplates.json', {});
    return {
        default: typeof t.default === 'string' ? t.default : '',
        servers: t && typeof t.servers === 'object' && t.servers ? t.servers : {}
    };
}

// The template that applies to a target: a server id, or null/'' for the global default.
// Falls back to the per-server template → global default → built-in example.
function getTemplate(gid) {
    const t = load();
    if (gid && typeof t.servers[gid] === 'string' && t.servers[gid].trim()) return t.servers[gid];
    if (t.default && t.default.trim()) return t.default;
    return DEFAULT_TEMPLATE;
}

function setTemplate(gid, text) {
    const t = load();
    if (gid) t.servers[gid] = text;
    else t.default = text;
    saveJSON('adtemplates.json', t);
}

// A single-token sponsor link (Discord invite or plain URL), optionally wrapped in <>.
const LINK_RE = /^<?(?:https?:\/\/\S+|(?:discord(?:app)?\.com\/invite|discord\.gg)\/[\w-]+|\.gg\/[\w-]+)>?$/i;
const isLink = (s) => typeof s === 'string' && s.trim() !== '' && !/\s/.test(s.trim()) && LINK_RE.test(s.trim());

// Make a bare sponsor invite a full URL so it renders as a proper invite in
// Discord. `discord.gg/x`, `discordapp.com/invite/x` and `.gg/x` get `https://`
// prepended; anything that already has a scheme, or isn't a recognised Discord
// invite, is returned untouched — so a working link can never break.
function normalizeLink(s) {
    const a = String(s || '').trim().replace(/^<|>$/g, '');
    if (!a || /^https?:\/\//i.test(a)) return a;
    if (/^(?:www\.)?discord(?:app)?\.com\/invite\/[\w-]+/i.test(a)) return 'https://' + a.replace(/^www\./i, '');
    if (/^(?:www\.)?discord\.gg\/[\w-]+/i.test(a)) return 'https://' + a.replace(/^www\./i, '');
    if (/^\.gg\/[\w-]+/i.test(a)) return 'https://discord' + a; // .gg/x → https://discord.gg/x
    return a;
}

// Turn the argument passed to !adv3 into the final ad text.
// If it's a bare sponsor link and the template has a {link} slot → fill it in
// (normalising the link to a full https:// URL first). Otherwise treat the
// argument as literal ad text (old behaviour).
function applyTemplate(gid, rawArg) {
    const arg = (rawArg || '').trim();
    if (isLink(arg)) {
        const link = normalizeLink(arg);
        const tmpl = getTemplate(gid);
        if (tmpl.includes('{link}')) return tmpl.split('{link}').join(link);
        return link; // a bare link used as the whole ad → still normalise it
    }
    return arg;
}

// List every per-server template override that's currently set (non-empty).
function listServerTemplates() {
    const t = load();
    return Object.entries(t.servers)
        .filter(([, v]) => typeof v === 'string' && v.trim())
        .map(([gid, text]) => ({ gid, text }));
}

// A Discord-ready "📌 Server templates: …" block listing every per-server
// override. Returns '' when none are set, so callers can just append it.
function formatServerTemplatesBlock() {
    const items = listServerTemplates();
    if (!items.length) return '';
    const MAX_TOTAL = 1500;
    const MAX_SNIPPET = 400;
    let out = '\n\n📌 Server templates:';
    let shown = 0;
    for (const { gid, text } of items) {
        const snippet = text.length > MAX_SNIPPET ? text.slice(0, MAX_SNIPPET) + '…' : text;
        const chunk = `\n\`${gid}\`\n\`\`\`\n${snippet}\n\`\`\``;
        if (out.length + chunk.length > MAX_TOTAL) break;
        out += chunk;
        shown++;
    }
    if (shown < items.length) out += `\n…and ${items.length - shown} more`;
    return out;
}

module.exports = { DEFAULT_TEMPLATE, getTemplate, setTemplate, applyTemplate, isLink, normalizeLink, listServerTemplates, formatServerTemplatesBlock };
