// One-time refund for clawbacks charged after the join's campaign had already
// finished.
//
// The leave-clawback asked "is this SPONSOR being advertised right now?" — not
// "is the deal that produced this join still open?". So when a buyer started a
// NEW campaign for a server, every join delivered by an OLD, already-completed
// campaign for that same server became clawback-able again: a partner was charged
// for a leave from a deal that closed weeks earlier — often one they no longer
// even run, which is why it looked like "there's no ad, but I'm being charged".
// The forward fix is ad ERAS (see sponsorshow.js); this returns the money already
// taken.
//
// A 'left' record qualifies only when all three hold, so live campaigns are never
// touched:
//   • the join falls inside a campaign that has a completedAt,
//   • the member left AFTER that campaign completed,
//   • the join happened BEFORE it completed (i.e. it really was that campaign's).
// Refunded records are finalized as 'settled' (the join is kept), matching what
// the fixed logic now does going forward.
//
// Runs once (marker in migrations.json) and is idempotent anyway: each refunded
// record is flipped off 'left', so a re-run can't double-pay.
const { loadJSON, saveJSON } = require('./database.js');
const { EmbedBuilder } = require('discord.js');
const poster = require('./poster.js');
const partnerlog = require('./partnerlog.js');

const MARKER = 'refundCompletedCampaignClawbacks_v1';
const LOG_CHANNEL = process.env.FUNDS_LOG_CHANNEL || '1522955113860173854';
const ADMIN_BOT_ID = process.env.ADMIN_BOT_ID || '1514533989434789998';
const round2 = (n) => +((Number(n) || 0).toFixed(2));

// The campaign a join belongs to: the newest one for that sponsor that was
// already paid for when the member joined.
function campaignOf(rec, camps) {
    let best = null;
    for (const c of camps) {
        if (!c || c.sponsorGuildId !== rec.guildId) continue;
        const paid = Number(c.paidAt) || 0;
        if (!paid || paid > (Number(rec.ts) || 0)) continue;
        if (!best || paid > (Number(best.paidAt) || 0)) best = c;
    }
    return best;
}

function qualifies(rec, camps) {
    if (!rec || rec.status !== 'left') return false;
    const leftAt = Number(rec.leftAt) || 0;
    const ts = Number(rec.ts) || 0;
    if (!leftAt || !ts) return false;                 // unknown timing → skip (conservative)
    const c = campaignOf(rec, camps);
    if (!c) return false;                             // house ad / no campaign → can't tell → skip
    const done = Number(c.completedAt) || 0;
    return done > 0 && leftAt > done && ts <= done;
}

async function runOnce(clients) {
    const marks = loadJSON('migrations.json', {});
    if (marks && marks[MARKER]) return;

    const list = loadJSON('joinlinks.json', []);
    if (!Array.isArray(list)) { markDone(marks, { skipped: 'no joinlinks' }); return; }
    const camps = Object.values(loadJSON('campaigns.json', {}) || {});
    const settings = loadJSON('settings.json', {});

    const now = Date.now();
    let records = 0, total = 0;
    const perPartner = {};
    const logs = [];

    for (const rec of list) {
        if (!qualifies(rec, camps)) continue;
        const amt = round2(rec.amount);
        if (settings[rec.creatorId]) {
            settings[rec.creatorId].balance = round2((Number(settings[rec.creatorId].balance) || 0) + amt);
        } else if (amt > 0) {
            settings[rec.creatorId] = { advText: '', serverAds: {}, partners: [], balance: amt };
        }
        rec.status = 'settled';
        rec.settledAt = now;
        rec.refundedAt = now;
        rec.refundReason = 'completed-campaign-clawback-refund';
        records++;
        if (amt > 0) {
            total = round2(total + amt);
            perPartner[rec.creatorId] = round2((perPartner[rec.creatorId] || 0) + amt);
            logs.push({ uid: rec.creatorId, amount: amt, userId: rec.userId, guildId: rec.cardGuildId, sponsorGuildId: rec.guildId, srcId: `campclawrefund:${rec.id}` });
        }
    }

    if (records > 0) {
        saveJSON('joinlinks.json', list);
        saveJSON('settings.json', settings);
        // Mirror into each partner's activity log so the credit is visible next to
        // the debit they originally saw.
        for (const l of logs) {
            try {
                partnerlog.logEvent(l.uid, {
                    type: 'credit', amount: l.amount, reason: 'clawback_refund',
                    userId: l.userId, guildId: l.guildId, sponsorGuildId: l.sponsorGuildId, srcId: l.srcId
                });
            } catch { /* logging must never block the refund */ }
        }
    }
    markDone(marks, { records, total: round2(total), partners: Object.keys(perPartner).length, at: now });

    console.log(`[REFUND] completed-campaign clawbacks: ${records} records, $${round2(total).toFixed(2)} to ${Object.keys(perPartner).length} partners`);
    await postSummary(clients, records, round2(total), perPartner).catch(() => null);
}

function markDone(marks, detail) {
    const m = (marks && typeof marks === 'object') ? marks : {};
    m[MARKER] = detail || true;
    saveJSON('migrations.json', m);
}

async function postSummary(clients, records, total, perPartner) {
    if (!records) return;
    const channel = await poster.posterChannel(clients, LOG_CHANNEL);
    if (!channel) return;
    const top = Object.entries(perPartner).sort((a, b) => b[1] - a[1]).slice(0, 15)
        .map(([uid, amt]) => `<@${uid}> — +$${amt.toFixed(2)}`).join('\n') || '—';
    const embed = new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('Возврат списаний по завершённым кампаниям')
        .setDescription('Возвращено партнёрам за выходы участников, пришедших по кампаниям, которые на момент выхода уже были завершены.')
        .addFields(
            { name: 'Записей возвращено', value: String(records), inline: true },
            { name: 'Сумма', value: `**+$${total.toFixed(2)}**`, inline: true },
            { name: 'Партнёров', value: String(Object.keys(perPartner).length), inline: true },
            { name: 'Топ получателей', value: top.slice(0, 1024), inline: false }
        )
        .setTimestamp();
    await channel.send({ embeds: [embed] }).catch(() => null);
}

module.exports = { runOnce, qualifies, campaignOf };
