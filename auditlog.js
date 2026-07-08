// Admin action audit log.
//
// fundslog records money movements; this records WHO in the panel did WHAT —
// balance edits, share/rate changes, admin/manager grants, ad/kran toggles,
// card and feed edits, token rotation, etc. Kept so a multi-person team is
// accountable and abuse is traceable. Rolling, capped, stored on the volume.
const { loadJSON, saveJSON } = require('./database.js');

const KEEP = Number(process.env.AUDIT_KEEP) || 5000;

function loadAudit() { const r = loadJSON('auditlog.json', []); return Array.isArray(r) ? r : []; }

function logAction(userId, action, detail) {
    try {
        const list = loadAudit();
        list.push({
            ts: Date.now(),
            userId: String(userId || ''),
            action: String(action || ''),
            detail: detail == null ? '' : String(detail).slice(0, 500)
        });
        while (list.length > KEEP) list.shift();
        saveJSON('auditlog.json', list);
    } catch (e) { console.error('[AUDIT]', e.message); }
}

// Most-recent-first, capped.
function recent(limit = 300) {
    const l = loadAudit();
    return l.slice(-Math.max(0, limit)).reverse();
}

module.exports = { logAction, recent, loadAudit };
