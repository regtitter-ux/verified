const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require('discord.js');
const { loadJSON, saveJSON } = require('./database.js');
const { logFunds } = require('./fundslog.js');
const { REFERRAL_RATE } = require('./referral.js'); // referrer earns 10% of each referred user's withdrawal
const cryptopay = require('./cryptopay.js');

const WITHDRAW_CHANNEL = '1521877173647184054';
const THRESHOLD = 10;                       // auto-withdraw once balance reaches this
const MANUAL_USER = '833442190427684914';   // only this user may adjust balances manually
const ADMIN_BOT_ID = process.env.ADMIN_BOT_ID || '1514533989434789998'; // authors payout requests
const OWNER_ID = process.env.OWNER_ID || '743913502997086219';         // bot owner — gets admin-side alerts

// Crypto Pay error names that only the bot owner can fix (app settings /
// token). Ping the OWNER, not the affected user — and don't promise the
// user a "will retry" because retry keeps failing until the owner acts.
const CRYPTOPAY_ADMIN_ERRORS = new Set([
    'METHOD_DISABLED', 'ACCESS_TOKEN_INVALID', 'UNAUTHORIZED', 'CHECKS_DISABLED'
]);

const round2 = (n) => +(Number(n) || 0).toFixed(2);

// A user's `refBonusAccrued` tracks how much of their current balance came
// from referral bonuses (rather than their own click/join/manual earnings).
// That portion is excluded from the base used to compute their referrer's
// 10% — otherwise every level up the chain would earn 10%-of-10% and the
// platform's referral overhead would compound geometrically. Consuming the
// pool FIFO at withdrawal time keeps upstream payouts bounded to exactly one
// level. Mutates `s` in place; returns the eligible portion of `amount`.
function drainRefBonusPool(s, amount) {
    const accrued = Number(s?.refBonusAccrued) || 0;
    const consumed = Math.min(amount, accrued);
    if (s) s.refBonusAccrued = round2(accrued - consumed);
    return round2(amount - consumed);
}

const statusLabel = (status) => (status === 'completed' ? 'Completed' : 'In processing');

const HISTORY_PAGE_SIZE = 10;

// Ephemeral withdrawal-history view: title shows total actually withdrawn (completed).
// Paginated at 10 withdrawals per page with prev/next buttons.
const buildHistoryView = (userId, page = 0) => {
    const settings = loadJSON('settings.json');
    const list = Array.isArray(settings[userId]?.withdrawals) ? settings[userId].withdrawals : [];

    const totalWithdrawn = round2(
        list.filter(w => w.status === 'completed').reduce((sum, w) => sum + (Number(w.amount) || 0), 0)
    );

    const sorted = [...list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const pageCount = Math.max(1, Math.ceil(sorted.length / HISTORY_PAGE_SIZE));
    const current = Math.min(Math.max(0, page), pageCount - 1);

    const embed = new EmbedBuilder()
        .setTitle(`Withdrawal history — $${totalWithdrawn.toFixed(2)} withdrawn`)
        .setColor('#5865F2');

    if (sorted.length === 0) {
        embed.setDescription('*No withdrawal requests yet.*');
        return { embeds: [embed], components: [] };
    }

    const slice = sorted.slice(current * HISTORY_PAGE_SIZE, current * HISTORY_PAGE_SIZE + HISTORY_PAGE_SIZE);
    for (const w of slice) {
        const ts = Math.floor((w.createdAt || 0) / 1000);
        embed.addFields({
            name: `${w.status === 'completed' ? '🟢' : '🟠'} $${round2(w.amount).toFixed(2)} — ${statusLabel(w.status)}`,
            value: ts ? `<t:${ts}:f>` : '​',
            inline: false
        });
    }
    embed.setFooter({ text: `Page ${current + 1}/${pageCount}` });

    const components = [];
    if (pageCount > 1) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`history_page:${current - 1}`)
                .setLabel('◀ Prev')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(current === 0),
            new ButtonBuilder()
                .setCustomId(`history_page:${current + 1}`)
                .setLabel('Next ▶')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(current >= pageCount - 1)
        ));
    }

    return { embeds: [embed], components };
};

const asList = (clients) => (Array.isArray(clients) ? clients : [clients]).filter(Boolean);

// Find a bot that can reach the payout channel — prefer the admin bot so it authors
// the request and can later process the photo/text reply that completes it.
async function findPayoutChannel(clients) {
    const list = asList(clients);
    const ordered = [
        ...list.filter(c => c.user?.id === ADMIN_BOT_ID),
        ...list.filter(c => c.user?.id !== ADMIN_BOT_ID)
    ];
    for (const c of ordered) {
        const ch = c.channels.cache.get(WITHDRAW_CHANNEL) || await c.channels.fetch(WITHDRAW_CHANNEL).catch(() => null);
        if (ch) return ch;
    }
    return null;
}

// Pay the referrer of `referredId` their cut (10%) of a withdrawal. Whoever lists
// referredId in their `referrals` earns it; the bonus lands on their balance and
// can itself trigger their own payout (guarded against referral cycles).
// `amount` here is the referrer-eligible portion (own earnings only) — the
// caller has already drained the referred user's `refBonusAccrued` pool so
// bonuses don't cascade further up the chain.
function payReferral(clients, referredId, amount, _seen) {
    if (!(amount > 0)) return;
    const settings = loadJSON('settings.json');
    const referrerId = Object.keys(settings).find(
        (uid) => uid !== referredId && Array.isArray(settings[uid].referrals) && settings[uid].referrals.includes(referredId)
    );
    if (!referrerId) return;

    const bonus = round2(amount * REFERRAL_RATE);
    if (bonus <= 0) return;

    settings[referrerId].balance = round2((Number(settings[referrerId].balance) || 0) + bonus);
    // Remember this credit as "bonus, not own earnings" so it will be
    // excluded from the base when the referrer eventually withdraws.
    settings[referrerId].refBonusAccrued = round2((Number(settings[referrerId].refBonusAccrued) || 0) + bonus);
    saveJSON('settings.json', settings);

    logFunds(clients, {
        type: 'credit', creatorId: referrerId, userId: referredId,
        amount: bonus, reason: 'Referral bonus (10% of withdrawal)'
    });

    // The referrer's bonus may push them over the threshold too.
    maybeAutoWithdraw(clients, referrerId, _seen).catch(() => null);
}

// If the user's balance reached the threshold, create a withdrawal request and post it
// from the service bot (whichever instance can see the payout channel).
async function maybeAutoWithdraw(clients, userId, _seen = new Set()) {
    if (_seen.has(userId)) return; // guard against referral cycles (A refers B refers A)
    _seen.add(userId);

    const settings = loadJSON('settings.json');
    const s = settings[userId];
    if (!s) return;

    const balance = round2(s.balance);
    if (balance < THRESHOLD) return;

    const amount = balance;

    // Fully-automatic USDT payout. Two modes the owner opts a user into; both
    // reserve the balance atomically first (set 0 + save, before any await) so a
    // concurrent trigger can't double-pay. The bonus-first drain excludes any
    // referral income from what the referrer earns 10% on, so commissions don't
    // compound.
    //
    // Direct transfer (no check) takes precedence: money lands straight in the
    // recipient's @CryptoBot wallet, no claim link. Needs their Telegram id.
    if (cryptopay.enabled() && s.autoTransfer && s.tgUserId) {
        s.balance = 0;
        const eligible = drainRefBonusPool(s, amount);
        saveJSON('settings.json', settings);
        return autoPayViaTransfer(clients, userId, amount, _seen, eligible);
    }
    // Otherwise fall back to a redeemable USDT check the user claims themselves.
    if (cryptopay.enabled() && s.autoPayout) {
        s.balance = 0;
        const eligible = drainRefBonusPool(s, amount);
        saveJSON('settings.json', settings);
        return autoPayViaCheck(clients, userId, amount, _seen, eligible);
    }

    // ---- Manual flow: file a request for staff to complete ----
    const requisites = (s.requisites || '').trim();

    s.balance = 0;
    if (!Array.isArray(s.withdrawals)) s.withdrawals = [];
    const withdrawal = {
        id: `${userId}-${Date.now()}`,
        amount,
        requisites,
        status: 'processing',
        createdAt: Date.now()
    };
    s.withdrawals.push(withdrawal);
    // See drainRefBonusPool comment — own earnings only feed the upstream 10%.
    const eligible = drainRefBonusPool(s, amount);
    saveJSON('settings.json', settings);

    // Referral: pay whoever referred this user 10% of the eligible portion.
    payReferral(clients, userId, eligible, _seen);

    try {
        const channel = await findPayoutChannel(clients);
        if (!channel) return;
        const user = await channel.client.users.fetch(userId).catch(() => null);

        const embed = new EmbedBuilder()
            .setTitle('New withdrawal request')
            .setColor('#FEE75C')
            .addFields(
                { name: 'User', value: `<@${userId}>${user ? ` (${user.tag})` : ''}`, inline: false },
                { name: 'Amount', value: `$${amount.toFixed(2)}`, inline: false },
                { name: 'Payment details', value: requisites || '*Not set*', inline: false },
                { name: 'Status', value: statusLabel('processing'), inline: false }
            )
            .setFooter({ text: `req:${userId}:${withdrawal.id}` })
            .setTimestamp();

        await channel.send({ content: `<@${userId}>`, embeds: [embed] });
    } catch (e) {
        console.error('[ERROR] Failed to post withdrawal request:', e);
    }
}

// Put a reserved amount back on the user's balance (payout failed/deferred).
function refundReserved(userId, amount) {
    const settings = loadJSON('settings.json');
    if (!settings[userId]) settings[userId] = { advText: '', serverAds: {}, partners: [] };
    settings[userId].balance = round2((Number(settings[userId].balance) || 0) + amount);
    saveJSON('settings.json', settings);
}

// Notify the money owner that a payout was deferred — throttled to once per 6h so a
// persistently under-funded app doesn't DM-spam on every new credit.
async function alertPayoutDeferred(clients, userId, amount, why) {
    const settings = loadJSON('settings.json');
    const now = Date.now();
    if (settings[userId] && settings[userId]._payoutAlertAt && now - settings[userId]._payoutAlertAt < 6 * 3600000) return;
    if (settings[userId]) { settings[userId]._payoutAlertAt = now; saveJSON('settings.json', settings); }
    await dmOwner(clients, userId, {
        content: `⚠️ Your auto-payout of **$${amount.toFixed(2)} USDT** is delayed: ${why}. It will retry automatically on your next earnings.`
    }).catch(() => null);
    console.error(`[CRYPTOPAY] payout deferred for ${userId}: ${why}`);
}

// Ping the bot OWNER when Crypto Pay hits an admin-side error (method
// disabled, token invalid). 6h dedupe on the owner keyed record so repeated
// user triggers don't spam. The affected user's balance is always refunded
// so nothing gets lost while the owner is fixing the settings.
async function alertOwnerCryptoPayConfig(clients, why) {
    const settings = loadJSON('settings.json');
    if (!settings[OWNER_ID]) settings[OWNER_ID] = { advText: '', serverAds: {}, partners: [] };
    const now = Date.now();
    if (settings[OWNER_ID]._cpAdminAlertAt && now - settings[OWNER_ID]._cpAdminAlertAt < 6 * 3600000) return;
    settings[OWNER_ID]._cpAdminAlertAt = now;
    saveJSON('settings.json', settings);
    const lines = [
        `⚠️ **Crypto Pay auto-payouts are failing:** \`${why}\`.`,
        '',
        'Fix in **@CryptoBot → Crypto Pay → My Apps → [this app]**:',
        '• `METHOD_DISABLED` / `CHECKS_DISABLED` → enable the **Checks** method for USDT.',
        '• `UNAUTHORIZED` / `ACCESS_TOKEN_INVALID` → regenerate the API token and update `CRYPTO_PAY_TOKEN` in Railway.',
        '',
        "All user balances have been refunded — nobody lost money. Payouts resume automatically on their next earnings after the fix."
    ];
    await dmOwner(clients, OWNER_ID, { content: lines.join('\n') }).catch(() => null);
    console.error(`[CRYPTOPAY] admin-side failure: ${why}`);
}

// The balance was already reserved (set to 0). Issue a USDT check and deliver the
// claim link to the user; on any failure, refund the reservation so it retries later.
// `eligibleForReferral` is the portion of `amount` that should feed the referrer's
// 10% (i.e. `amount` minus any referral bonus the user is withdrawing back out).
async function autoPayViaCheck(clients, userId, amount, _seen, eligibleForReferral = amount) {
    // Make sure the app actually has the funds before issuing the check.
    const available = await cryptopay.usdtAvailable().catch(() => null);
    if (available === null) { refundReserved(userId, amount); return alertPayoutDeferred(clients, userId, amount, 'Crypto Pay is unreachable'); }
    if (available < amount) { refundReserved(userId, amount); return alertPayoutDeferred(clients, userId, amount, `insufficient app USDT balance (have $${round2(available).toFixed(2)})`); }

    let check;
    try {
        check = await cryptopay.createUsdtCheck(amount);
    } catch (e) {
        refundReserved(userId, amount);
        const msg = e.message || 'unknown';
        // Admin-side error: ping the OWNER with actionable instructions and
        // send the affected user a truthful "waiting on admin" message
        // instead of the misleading "will retry automatically".
        if (CRYPTOPAY_ADMIN_ERRORS.has(msg)) {
            await alertOwnerCryptoPayConfig(clients, msg);
            await dmOwner(clients, userId, {
                content: `⚠️ Your auto-payout of **$${amount.toFixed(2)} USDT** is on hold — the admin has been notified. Your balance has been restored; it'll be sent as soon as the payout system is restored.`
            }).catch(() => null);
            return;
        }
        return alertPayoutDeferred(clients, userId, amount, `check creation failed (${msg})`);
    }

    // Record the completed withdrawal.
    const settings = loadJSON('settings.json');
    if (!settings[userId]) settings[userId] = { advText: '', serverAds: {}, partners: [] };
    if (!Array.isArray(settings[userId].withdrawals)) settings[userId].withdrawals = [];
    const withdrawal = {
        id: `${userId}-${Date.now()}`,
        amount,
        status: 'completed',
        method: 'cryptopay_check',
        checkId: check.check_id,
        createdAt: Date.now(),
        completedAt: Date.now()
    };
    settings[userId].withdrawals.push(withdrawal);
    saveJSON('settings.json', settings);

    // Audit log: the payout is a debit off the user's balance.
    logFunds(clients, {
        type: 'debit', creatorId: userId, amount,
        reason: `Auto-payout (USDT check #${check.check_id})`
    });

    // Referral: pay whoever referred this user 10% of the eligible portion.
    payReferral(clients, userId, eligibleForReferral, _seen);

    // Deliver the claim link privately to the user (this IS the payout).
    const url = check.bot_check_url || `https://t.me/${cryptopay.HOST === 'pay.crypt.bot' ? 'CryptoBot' : 'CryptoTestnetBot'}?start=check_${check.check_id}`;
    await dmOwner(clients, userId, {
        content: `✅ Your withdrawal of **$${amount.toFixed(2)} USDT** is ready.\nClaim it in @CryptoBot: ${url}`
    }).catch(() => null);

    // Audit record in the payout channel — WITHOUT the claim link (that goes only to the user).
    try {
        const channel = await findPayoutChannel(clients);
        if (channel) {
            const user = await channel.client.users.fetch(userId).catch(() => null);
            const embed = new EmbedBuilder()
                .setTitle('Withdrawal auto-paid (USDT check)')
                .setColor('#57F287')
                .addFields(
                    { name: 'User', value: `<@${userId}>${user ? ` (${user.tag})` : ''}`, inline: false },
                    { name: 'Amount', value: `$${amount.toFixed(2)}`, inline: false },
                    { name: 'Check ID', value: `\`${check.check_id}\``, inline: false },
                    { name: 'Status', value: statusLabel('completed'), inline: false }
                )
                .setFooter({ text: `auto:${userId}:${withdrawal.id}` })
                .setTimestamp();
            await channel.send({ embeds: [embed] });
        }
    } catch (e) {
        console.error('[CRYPTOPAY] audit post failed:', e.message);
    }
}

// The balance was already reserved (set to 0). Send USDT DIRECTLY to the user's
// Crypto Pay balance (no check to claim) using their configured Telegram id.
// On any failure, refund the reservation so it retries on the next earnings.
async function autoPayViaTransfer(clients, userId, amount, _seen, eligibleForReferral = amount) {
    const settings0 = loadJSON('settings.json');
    const tgUserId = String(settings0[userId]?.tgUserId || '').trim();
    if (!/^\d{5,15}$/.test(tgUserId)) {
        refundReserved(userId, amount);
        return alertOwnerTransferConfig(clients, userId, amount, 'no valid Telegram id configured');
    }

    // Make sure the app actually has the funds before transferring.
    const available = await cryptopay.usdtAvailable().catch(() => null);
    if (available === null) { refundReserved(userId, amount); return alertPayoutDeferred(clients, userId, amount, 'Crypto Pay is unreachable'); }
    if (available < amount) { refundReserved(userId, amount); return alertPayoutDeferred(clients, userId, amount, `insufficient app USDT balance (have $${round2(available).toFixed(2)})`); }

    const withdrawalId = `${userId}-${Date.now()}`;
    let transfer;
    try {
        // spend_id = withdrawalId → idempotent; a network retry can't double-pay.
        try {
            transfer = await cryptopay.transferUsdt(tgUserId, amount, withdrawalId, { comment: 'Vemoni payout' });
        } catch (e) {
            // Some apps aren't allowed to attach comments — the comment is
            // cosmetic, so retry the SAME transfer (same spend_id) without it.
            if ((e.message || '') === 'CANNOT_ATTACH_COMMENT') {
                transfer = await cryptopay.transferUsdt(tgUserId, amount, withdrawalId);
            } else throw e;
        }
    } catch (e) {
        refundReserved(userId, amount);
        const msg = e.message || 'unknown';
        if (CRYPTOPAY_ADMIN_ERRORS.has(msg)) {
            await alertOwnerCryptoPayConfig(clients, msg);
            await dmOwner(clients, userId, {
                content: `⚠️ Your auto-payout of **$${amount.toFixed(2)} USDT** is on hold — the admin has been notified. Your balance has been restored; it'll be sent as soon as the payout system is restored.`
            }).catch(() => null);
            return;
        }
        // Bad recipient (wrong id / never used @CryptoBot) — the OWNER set the
        // Telegram id, so ping the owner to fix it rather than the user.
        if (msg === 'USER_NOT_FOUND' || msg === 'RECIPIENT_NOT_FOUND') {
            return alertOwnerTransferConfig(clients, userId, amount, `Crypto Pay rejected the recipient (${msg}) — check the Telegram id`);
        }
        return alertPayoutDeferred(clients, userId, amount, `direct transfer failed (${msg})`);
    }

    // Record the completed withdrawal.
    const settings = loadJSON('settings.json');
    if (!settings[userId]) settings[userId] = { advText: '', serverAds: {}, partners: [] };
    if (!Array.isArray(settings[userId].withdrawals)) settings[userId].withdrawals = [];
    const withdrawal = {
        id: withdrawalId,
        amount,
        status: 'completed',
        method: 'cryptopay_transfer',
        transferId: transfer.transfer_id || null,
        tgUserId,
        createdAt: Date.now(),
        completedAt: Date.now()
    };
    settings[userId].withdrawals.push(withdrawal);
    saveJSON('settings.json', settings);

    logFunds(clients, {
        type: 'debit', creatorId: userId, amount,
        reason: `Auto-payout (direct USDT transfer #${transfer.transfer_id || '?'} → tg:${tgUserId})`
    });

    // Referral: pay whoever referred this user 10% of the eligible portion.
    payReferral(clients, userId, eligibleForReferral, _seen);

    // The money is already in their @CryptoBot wallet — just tell them.
    await dmOwner(clients, userId, {
        content: `✅ Your withdrawal of **$${amount.toFixed(2)} USDT** has been sent directly to your @CryptoBot wallet.`
    }).catch(() => null);

    // Audit record in the payout channel.
    try {
        const channel = await findPayoutChannel(clients);
        if (channel) {
            const user = await channel.client.users.fetch(userId).catch(() => null);
            const embed = new EmbedBuilder()
                .setTitle('Withdrawal auto-paid (direct USDT transfer)')
                .setColor('#57F287')
                .addFields(
                    { name: 'User', value: `<@${userId}>${user ? ` (${user.tag})` : ''}`, inline: false },
                    { name: 'Amount', value: `$${amount.toFixed(2)}`, inline: false },
                    { name: 'Telegram ID', value: `\`${tgUserId}\``, inline: false },
                    { name: 'Transfer ID', value: `\`${transfer.transfer_id || '—'}\``, inline: false },
                    { name: 'Status', value: statusLabel('completed'), inline: false }
                )
                .setFooter({ text: `auto:${userId}:${withdrawal.id}` })
                .setTimestamp();
            await channel.send({ embeds: [embed] });
        }
    } catch (e) {
        console.error('[CRYPTOPAY] transfer audit post failed:', e.message);
    }
}

// Ping the service OWNER when a direct transfer can't go out because its
// per-user config (the Telegram id they entered) is wrong. Throttled 6h per
// affected user so a repeatedly-triggering balance doesn't spam.
async function alertOwnerTransferConfig(clients, userId, amount, why) {
    const settings = loadJSON('settings.json');
    const now = Date.now();
    if (settings[userId] && settings[userId]._transferAlertAt && now - settings[userId]._transferAlertAt < 6 * 3600000) return;
    if (settings[userId]) { settings[userId]._transferAlertAt = now; saveJSON('settings.json', settings); }
    await dmOwner(clients, OWNER_ID, {
        content: `⚠️ **Прямой авто-вывод не прошёл** для <@${userId}> на **$${amount.toFixed(2)} USDT**: ${why}.\nПроверь Telegram ID получателя в настройках баланса. Баланс пользователя восстановлен — выплата повторится после исправления.`
    }).catch(() => null);
    console.error(`[CRYPTOPAY] transfer config issue for ${userId}: ${why}`);
}

// Mark a withdrawal as completed. Returns the withdrawal object or null.
function completeWithdrawal(userId, withdrawalId) {
    const settings = loadJSON('settings.json');
    const list = settings[userId]?.withdrawals;
    if (!Array.isArray(list)) return null;

    const w = list.find(x => x.id === withdrawalId);
    if (!w || w.status === 'completed') return null;

    w.status = 'completed';
    w.completedAt = Date.now();
    saveJSON('settings.json', settings);
    return w;
}

// Handle manual balance adjustment: "+10 <userId>" / "-5 <userId>" from MANUAL_USER only.
// Returns true if the message was a manual-balance command (handled), false otherwise.
async function handleManualBalance(message, clients) {
    const m = message.content.trim().match(/^([+-])\s*(\d+(?:[.,]\d+)?)\s+(\d{17,20})$/);
    if (!m) return false;
    if (message.author.id !== MANUAL_USER) return false;

    const sign = m[1] === '-' ? -1 : 1;
    const amount = round2(m[2].replace(',', '.'));
    const targetId = m[3];

    const settings = loadJSON('settings.json');
    if (!settings[targetId]) settings[targetId] = { advText: '', serverAds: {}, partners: [] };
    const s = settings[targetId];

    // Manual adjustments may drive the balance negative (e.g. clawing back an overpayment).
    s.balance = round2((Number(s.balance) || 0) + sign * amount);
    saveJSON('settings.json', settings);

    await message.reply(
        `✅ ${sign > 0 ? 'Added' : 'Removed'} $${amount.toFixed(2)} ${sign > 0 ? 'to' : 'from'} <@${targetId}>. New balance: **$${s.balance.toFixed(2)}**`
    ).catch(() => null);

    if (sign > 0) await maybeAutoWithdraw(clients || message.client, targetId);
    return true;
}

// Send a DM to the money owner from the single bot they actually use (never all at once).
async function dmOwner(clients, ownerId, payload) {
    const settings = loadJSON('settings.json');
    const botId = settings[ownerId]?.botId;
    const list = asList(clients);
    // Prefer the user's own bot, then fall back to any other instance.
    const ordered = [
        ...list.filter(c => c.user?.id === botId),
        ...list.filter(c => c.user?.id !== botId)
    ];
    for (const c of ordered) {
        const target = await c.users.fetch(ownerId).catch(() => null);
        if (!target) continue;
        const ok = await target.send(payload).then(() => true).catch(() => false);
        if (ok) return true; // one bot delivered — stop
    }
    return false;
}

// Complete a withdrawal by replying to its request embed with a photo (no command needed).
// Marks the request completed, attaches the proof photo, and DMs the owner.
// Returns true if the message was handled as a proof, false otherwise.
async function handleDone(message, clients) {
    if (!message.reference?.messageId) return false; // must be a reply

    const reqMsg = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    const footer = reqMsg?.embeds?.[0]?.footer?.text || '';
    const fm = footer.match(/^req:(\d{17,20}):(.+)$/);
    if (!reqMsg || !fm) return false; // replied message isn't a withdrawal request → fall through

    // Only the bot that authored the request processes it (prevents duplicates across bots).
    if (reqMsg.author.id !== message.client.user.id) return true;

    const ownerId = fm[1];
    const withdrawalId = fm[2];

    const isAdmin = message.member?.permissions?.has(PermissionsBitField.Flags.Administrator);
    if (!isAdmin && message.author.id !== MANUAL_USER) return false; // not staff → ignore

    // Proof can be a photo (screenshot) OR text (e.g. a redeemable check link).
    const photo = message.attachments.find(a => (a.contentType || '').startsWith('image/')) || message.attachments.first();
    const proofText = (message.content || '').trim();
    if (!photo && !proofText) return false; // nothing to attach as proof

    const w = completeWithdrawal(ownerId, withdrawalId);
    if (!w) {
        await message.reply('ℹ️ This withdrawal is already completed or not found.').catch(() => null);
        return true;
    }

    const amountStr = round2(w.amount).toFixed(2);
    const fileName = photo ? (photo.name || 'proof.png').replace(/\s+/g, '_') : null;

    // Edit the request message: completed + proof (photo or text), and drop any components.
    try {
        const embed = EmbedBuilder.from(reqMsg.embeds[0]).setColor('#57F287');
        const fields = embed.data.fields || [];
        const statusField = fields.find(f => f.name === 'Status');
        if (statusField) statusField.value = statusLabel('completed');
        embed.setFields(fields);

        let files = [];
        if (photo) {
            embed.setImage(`attachment://${fileName}`);
            files = [{ attachment: photo.url, name: fileName }];
        } else {
            embed.addFields({ name: 'Check', value: proofText.slice(0, 1024), inline: false });
        }
        await reqMsg.edit({ embeds: [embed], components: [], files });
    } catch (e) {
        console.error('[ERROR] Failed to edit withdrawal request:', e);
    }

    // DM the owner from the single bot they use.
    const dm = { content: `✅ Your withdrawal of **$${amountStr}** has been completed` };
    if (photo) dm.files = [{ attachment: photo.url, name: fileName }];
    else dm.content += `\n${proofText}`;
    await dmOwner(clients, ownerId, dm);

    return true;
}

module.exports = {
    WITHDRAW_CHANNEL,
    THRESHOLD,
    MANUAL_USER,
    buildHistoryView,
    maybeAutoWithdraw,
    completeWithdrawal,
    handleManualBalance,
    handleDone,
    statusLabel
};
