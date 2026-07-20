// DMALL access list.
//
// The owner can grant individual users access to the DMALL broadcast console
// (in addition to the owner and admins, who always have it). The list is just a
// set of Discord user IDs persisted to dmall-access.json.
const { loadJSON, saveJSON } = require('./database.js');

function loadAccess() {
    const raw = loadJSON('dmall-access.json', null);
    const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.users) ? raw.users : []);
    return arr.filter((x) => /^\d{17,20}$/.test(String(x)));
}
function saveAccess(list) {
    const clean = [...new Set((list || []).map((x) => String(x)).filter((x) => /^\d{17,20}$/.test(x)))];
    saveJSON('dmall-access.json', clean);
    return clean;
}
function isDmall(id) { return loadAccess().includes(String(id || '')); }

module.exports = { loadAccess, saveAccess, isDmall };
