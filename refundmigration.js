// One-time refund for wrongly-clawed partner payouts.
//
// A leave-clawback used to fire even when the sponsor's ad had been off for
// days, because the ad-off opt-out was keyed by the wrong guild (see the fix in
// joincheck.js). This returns those amounts to partners.
//
// A 'left' joinlink record qualifies for a refund only if the member left AFTER
// the sponsor's ad had DEFINITIVELY gone stale: leftAt > lastShow + window,
// where lastShow is the most recent time that sponsor's ad was displayed
// (sponsorshow.json). Because lastShow is the newest show ever recorded, a
// leave later than lastShow+window provably happened while the ad was off — so
// clawbacks that occurred during an active campaign are left untouched (a
// currently-running sponsor has a recent lastShow, so nothing after it
// qualifies). Refunded records are finalized as 'settled' (the join is kept),
// matching what the fixed clawback logic now does going forward.
//
// Runs once, guarded by a marker in migrations.json; also idempotent because it
// flips each refunded record off 'left', so a re-run can't double-pay.
const { loadJSON, saveJSON } = require('./database.js');
const { EmbedBuilder } = require('discord.js');
const poster = require('./poster.js');

const MARKER = 'refundAdOffClawbacks_v1';
const SHOW_STALE_MS = Number(process.env.SPONSOR_SHOW_STALE_MS) || 30 * 60 * 1000;
const LOG_CHANNEL = process.env.FUNDS_LOG_CHANNEL || '1522955113860173854';
const ADMIN_BOT_ID = process.env.ADMIN_BOT_ID || '1514533989434789998';
const round2 = (n) => +((Number(n) || 0).toFixed(2));

async function runOnce(clients) {
    const marks = loadJSON('migrations.json', {});
    if (marks && marks[MARKER]) return; // already done

    const list = loadJSON('joinlinks.json', []);
    const settings = loadJSON('settings.json', {});
    const shows = loadJSON('sponsorshow.json', {});
    if (!Array.isArray(list)) { markDone(marks, { skipped: 'no joinlinks' }); return; }

    const now = Date.now();
    let refundedRecords = 0;
    let refundedTotal = 0;
    const perPartner = {};

    for (const rec of list) {
        if (!rec || rec.status !== 'left') continue;
        const leftAt = Number(rec.leftAt) || 0;
        if (!leftAt) continue;                                  // unknown leave time → skip (conservative)
        const lastShow = Number(shows?.[rec.guildId]) || 0;
        if (leftAt <= lastShow + SHOW_STALE_MS) continue;       // ad may have been live → don't refund

        const amt = round2(rec.amount);
        if (settings[rec.creatorId]) {
            settings[rec.creatorId].balance = round2((Number(settings[rec.creatorId].balance) || 0) + amt);
        } else if (amt > 0) {
            // Partner record vanished — recreate a minimal one so the credit lands.
            settings[rec.creatorId] = { advText: '', serverAds: {}, partners: [], balance: amt };
        }
        rec.status = 'settled';
        rec.settledAt = now;
        rec.refundedAt = now;
        rec.refundReason = 'ad-off-clawback-refund';
        refundedRecords++;
        if (amt > 0) {
            refundedTotal = round2(refundedTotal + amt);
            perPartner[rec.creatorId] = round2((perPartner[rec.creatorId] || 0) + amt);
        }
    }

    if (refundedRecords > 0) {
        saveJSON('joinlinks.json', list);
        saveJSON('settings.json', settings);
    }
    markDone(marks, { refundedRecords, refundedTotal: round2(refundedTotal), partners: Object.keys(perPartner).length, at: now });

    console.log(`[REFUND] ad-off clawback refund: ${refundedRecords} records, $${round2(refundedTotal).toFixed(2)} to ${Object.keys(perPartner).length} partners`);
    await postSummary(clients, refundedRecords, round2(refundedTotal), perPartner).catch(() => null);
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
        .setTitle('Возврат ошибочных списаний (реклама спонсора была выключена)')
        .setDescription('Возвращено партнёрам за выходы участников, случившиеся когда реклама спонсора уже не показывалась.')
        .addFields(
            { name: 'Записей возвращено', value: String(records), inline: true },
            { name: 'Сумма', value: `**+$${total.toFixed(2)}**`, inline: true },
            { name: 'Партнёров', value: String(Object.keys(perPartner).length), inline: true },
            { name: 'Топ получателей', value: top.slice(0, 1024), inline: false }
        )
        .setTimestamp();
    await channel.send({ embeds: [embed] }).catch(() => null);
}

module.exports = { runOnce };
