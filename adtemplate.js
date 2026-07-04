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

// Turn the argument passed to !adv3 into the final ad text.
// If it's a bare sponsor link and the template has a {link} slot → fill it in.
// Otherwise treat the argument as literal ad text (old behaviour).
function applyTemplate(gid, rawArg) {
    const arg = (rawArg || '').trim();
    if (isLink(arg)) {
        const tmpl = getTemplate(gid);
        if (tmpl.includes('{link}')) return tmpl.split('{link}').join(arg.replace(/^<|>$/g, ''));
    }
    return arg;
}

module.exports = { DEFAULT_TEMPLATE, getTemplate, setTemplate, applyTemplate, isLink };
