// Verification-card registry + remote management ("Экстренно" admin tab).
//
// Every /verify card is tracked here so the owner can list them, "shake" a
// broken one (rebuild the embed + button in place), change its owner/role,
// delete it, or re-publish it — all without touching who created it unless
// explicitly asked. Only the bot instance that AUTHORED a message can edit or
// delete it, so each op locates that instance in the fleet.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AuditLogEvent, PermissionsBitField,
    ContainerBuilder, SectionBuilder, TextDisplayBuilder, SeparatorBuilder, MessageFlags } = require('discord.js');
const https = require('https');
const { loadJSON, saveJSON } = require('./database.js');

// Fetch a small image URL (role icon) into a Buffer. Best-effort; null on error.
function fetchBuffer(url) {
    return new Promise((resolve) => {
        try {
            https.get(url, (res) => {
                if (res.statusCode !== 200) { res.resume(); return resolve(null); }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', () => resolve(null));
            }).on('error', () => resolve(null));
        } catch { resolve(null); }
    });
}

function loadCards() { const r = loadJSON('cards.json', []); return Array.isArray(r) ? r : []; }
function saveCards(list) { saveJSON('cards.json', Array.isArray(list) ? list : []); return loadCards(); }

// Insert or update a card record keyed by messageId.
function addCard(rec) {
    if (!rec || !rec.messageId) return null;
    const list = loadCards();
    const now = Date.now();
    const i = list.findIndex((c) => c.messageId === rec.messageId);
    if (i >= 0) { list[i] = { ...list[i], ...rec, updatedAt: now }; saveCards(list); return list[i]; }
    const merged = { createdAt: now, updatedAt: now, ...rec };
    list.push(merged); saveCards(list); return merged;
}
function removeCard(messageId) { saveCards(loadCards().filter((c) => c.messageId !== messageId)); }
function getCard(messageId) { return loadCards().find((c) => c.messageId === messageId) || null; }

// Every role id this card's stats live under — the current role plus any role
// it previously used (a "Сбросить роль" recreates the role with a new id, but
// the old verifications/clicks are keyed by the old id). Lets stats survive a
// role reset. Values may be null (a legacy card with no explicit role).
function cardRoleIds(card) {
    const ids = [(card && card.roleId) ? card.roleId : null];
    for (const r of (Array.isArray(card && card.roleHistory) ? card.roleHistory : [])) {
        const v = r || null;
        if (!ids.includes(v)) ids.push(v);
    }
    return ids;
}

// Mark a card deleted (kept in the registry so its stats survive) rather than
// dropping it. deletedBy = who removed it, when known.
function markDeleted(messageId, deletedBy = null) {
    const list = loadCards();
    const i = list.findIndex((c) => c.messageId === messageId);
    if (i < 0) return null;
    if (!list[i].deletedAt) {
        list[i].deletedAt = Date.now();
        list[i].deletedBy = deletedBy || list[i].deletedBy || null;
        saveCards(list);
        const c = list[i];
        try { require('./auditlog.js').logAction(c.deletedBy || 'system', 'card.delete', `owner ${c.creatorId || '?'} · guild ${c.guildId || '?'} · https://discord.com/channels/${c.guildId || ''}`, `card.delete|${c.messageId}`); } catch (_) { /* never block */ }
    } else if (deletedBy && !list[i].deletedBy) {
        list[i].deletedBy = deletedBy; saveCards(list);
    }
    return list[i];
}

const DEFAULT_DESCRIPTION = 'To gain full access to the server, you must complete verification\nClick the button';

// One bot gets a bespoke Components V2 (“embed v2”) card: a Verification section
// with a green button + an FAQ section with a button that opens the Q&A. The
// verify button keeps the exact same customId, so /verify role and the whole
// verification flow are unchanged — only the rendering differs.
const PERSONALIZED_BOT_ID = '1525109611441553560';

// FAQ shown ephemerally when the "Прочитать FaQ" button is pressed.
const FAQ_TEXT = [
    '## Часто задаваемые вопросы',
    '',
    '**Q: Почему мне нужна верификация?**',
    'A: Без верификации Ваш доступ к серверу ограничен',
    '',
    '**Q: Что даёт мне верификация?**',
    'A: При верификации Вы получите доступ к функционалу сервера',
    '',
    '**Q: Зачем вообще нужна верификация?**',
    'A: Верификация нужна чтобы предотвратить попытки рейда нашего сервера через бот-аккаунты',
    '',
    '**Q: Как обрабатываются мои данные?**',
    'A: Мы не собираем Ваши персональные данные в ходе верификации, за исключением необходимых для аналитики. Ваши персональные данные нам не нужны',
    '',
    '**Q: Как мне пройти верификацию?**',
    'A: Нажмите на кнопку «Пройти верификацию»'
].join('\n');

// The FAQ shown when "Прочитать FaQ" is pressed — a Components V2 container
// (embed v2), rendered ephemerally. Combines the V2 + Ephemeral message flags.
function buildFaqView() {
    const container = new ContainerBuilder()
        .setAccentColor(0x5865F2)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(FAQ_TEXT));
    return { components: [container], flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral };
}

// The bespoke Components V2 payload for PERSONALIZED_BOT_ID. creatorId is carried
// in BOTH the verify button (3rd segment) and the FAQ button so the join can be
// attributed even though there is no embed footer to read it from.
function buildPersonalCard(guild, creatorId, roleId) {
    const verifyBtn = new ButtonBuilder()
        .setCustomId(`start_verif_guild:${roleId || ''}:${creatorId || ''}`)
        .setLabel('Пройти верификацию').setStyle(ButtonStyle.Success);
    const faqBtn = new ButtonBuilder()
        .setCustomId(`verif_faq:${creatorId || ''}`)
        .setLabel('Прочитать FaQ').setStyle(ButtonStyle.Primary);
    const container = new ContainerBuilder()
        .setAccentColor(0x5865F2)
        .addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                    '## Верификация\nЗдесь Вы можете пройти верификацию чтобы получить доступ к серверу, чтобы пройти верификацию - нажмите на кнопку справа'))
                .setButtonAccessory(verifyBtn))
        .addSeparatorComponents(new SeparatorBuilder())
        .addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(
                    '## Часто задаваемые вопросы\nЧтобы просмотреть часто задаваемые вопросы - нажмите на кнопку справа'))
                .setButtonAccessory(faqBtn));
    return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

const DEFAULT_TITLE = 'Get verified!';
const DEFAULT_BUTTON_LABEL = 'Start Verification';
const DEFAULT_BUTTON_EMOJI = '🔐';
const DEFAULT_COLOR = 0x5865F2;

// Parse a #rrggbb / #rgb / rrggbb colour to an int, or null if invalid.
function parseColor(v) {
    if (v == null) return null;
    let s = String(v).trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.split('').map((ch) => ch + ch).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return parseInt(s, 16);
}

// The editable presentation fields carried on a card record, as buildCard opts.
// buttonEmoji is only included when explicitly set ('' means "no emoji"); absent
// means the default lock emoji.
function cardOpts(card) {
    const o = {};
    if (card && card.title != null) o.title = card.title;
    if (card && card.buttonLabel != null) o.buttonLabel = card.buttonLabel;
    if (card && card.color != null) o.color = card.color;
    if (card && Object.prototype.hasOwnProperty.call(card, 'buttonEmoji') && card.buttonEmoji !== undefined) o.buttonEmoji = card.buttonEmoji;
    return o;
}

// Mark a card as the guild's template for new /verify cards. Only one template
// per guild — turning it on clears the flag on every other card in that guild.
function setTemplate(messageId, on) {
    const card = getCard(messageId);
    if (!card) return null;
    if (on) {
        for (const c of loadCards()) {
            if (c.messageId !== messageId && c.guildId === card.guildId && c.isTemplate) addCard({ ...c, isTemplate: false });
        }
    }
    return addCard({ ...card, isTemplate: !!on });
}
// The active template for a guild, as { description, opts, fields } — or null.
// `fields` is the subset to persist on a newly created card so later rebuilds
// keep the same look.
function templateForGuild(guildId) {
    if (!guildId) return null;
    const tpl = loadCards().find((c) => !c.deletedAt && c.isTemplate && c.guildId === guildId);
    if (!tpl) return null;
    const fields = { description: tpl.description ?? null, title: tpl.title ?? null, buttonLabel: tpl.buttonLabel ?? null, color: tpl.color ?? null };
    if (Object.prototype.hasOwnProperty.call(tpl, 'buttonEmoji') && tpl.buttonEmoji !== undefined) fields.buttonEmoji = tpl.buttonEmoji;
    return { description: fields.description, opts: cardOpts(tpl), fields };
}

// The canonical verification-card message payload. `description` overrides the
// embed body per card (empty → the default text). `botId` selects the bespoke
// Components V2 layout for the one personalized bot. `opts` overrides the embed
// title, accent colour, button label and button emoji (opts.buttonEmoji === ''
// removes the emoji; omitted → default lock).
function buildCard(guild, creatorId, roleId, description, botId, opts = {}) {
    if (String(botId || '') === PERSONALIZED_BOT_ID) return buildPersonalCard(guild, creatorId, roleId);
    // Static png: a broken animated (a_) icon renders as a broken avatar in the embed.
    const icon = guild?.iconURL?.({ extension: 'png', forceStatic: true }) || null;
    const title = (opts.title && String(opts.title).trim()) ? String(opts.title) : DEFAULT_TITLE;
    const color = parseColor(opts.color);
    const embed = new EmbedBuilder()
        .setAuthor({ name: guild?.name || 'Server', iconURL: icon })
        .setTitle(title)
        .setDescription((description && String(description).trim()) ? String(description) : DEFAULT_DESCRIPTION)
        .setThumbnail(icon)
        .setColor(color == null ? DEFAULT_COLOR : color)
        .setFooter({ text: `Created by: ${creatorId}` });
    const label = (opts.buttonLabel && String(opts.buttonLabel).trim()) ? String(opts.buttonLabel) : DEFAULT_BUTTON_LABEL;
    const btn = new ButtonBuilder()
        .setCustomId(roleId ? `start_verif_guild:${roleId}` : 'start_verif_guild')
        .setLabel(label).setStyle(ButtonStyle.Primary);
    const emoji = Object.prototype.hasOwnProperty.call(opts, 'buttonEmoji') ? opts.buttonEmoji : DEFAULT_BUTTON_EMOJI;
    if (emoji) { try { btn.setEmoji(emoji); } catch (_) { /* invalid emoji → render without one */ } }
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(btn)] };
}

// Parse a message link / "channelId messageId" / "channelId-messageId".
function parseMsgRef(input) {
    const s = String(input || '').trim();
    let m = s.match(/channels\/\d+\/(\d+)\/(\d+)/);
    if (m) return { channelId: m[1], messageId: m[2] };
    m = s.match(/^(\d{17,20})\s*[-/\s]\s*(\d{17,20})$/);
    if (m) return { channelId: m[1], messageId: m[2] };
    return null;
}

// Recover a card's owner (footer), role (button customId) and embed body.
function extractCard(msg) {
    const footer = msg?.embeds?.[0]?.footer?.text || '';
    let creatorId = (footer.match(/Created by:\s*(\d{17,20})/) || [])[1] || null;
    const description = msg?.embeds?.[0]?.description || null;
    // Collect every button customId, recursing into Components V2 containers/
    // sections so the bespoke card's ids are found too.
    const ids = [];
    const walk = (comps) => {
        for (const comp of comps || []) {
            if (comp.customId || comp.custom_id) ids.push(comp.customId || comp.custom_id);
            if (comp.components) walk(comp.components);
            if (comp.accessory) walk([comp.accessory]);
        }
    };
    walk(msg?.components || []);
    let roleId = null;
    for (const cid of ids) {
        if (cid.startsWith('start_verif_guild')) {
            const parts = cid.split(':');
            roleId = parts[1] || null;
            if (!creatorId && parts[2]) creatorId = parts[2]; // V2 card carries the owner here
        } else if (!creatorId && cid.startsWith('verif_faq:')) {
            creatorId = cid.split(':')[1] || null;
        }
    }
    return { creatorId, roleId, description };
}

// Locate the message and the fleet client that AUTHORED it (the only one that
// can edit/delete). client is null when the message exists but no fleet bot
// wrote it. Returns null if the message can't be found at all.
async function locate(clients, channelId, messageId) {
    let seen = null;
    for (const c of Array.isArray(clients) ? clients : []) {
        const channel = await c.channels.fetch(channelId).catch(() => null);
        if (!channel || typeof channel.messages?.fetch !== 'function') continue;
        const msg = await channel.messages.fetch(messageId).catch(() => null);
        if (!msg) continue;
        seen = { client: null, channel, msg };
        if (msg.author?.id === c.user?.id) return { client: c, channel, msg };
    }
    return seen;
}

// Register (and shake) an existing card by reference — for cards created before
// tracking, or that fell out of the registry.
async function register(clients, ref) {
    const r = parseMsgRef(ref);
    if (!r) return { ok: false, error: 'bad-ref' };
    const loc = await locate(clients, r.channelId, r.messageId);
    if (!loc) return { ok: false, error: 'not-found' };
    if (!loc.client) return { ok: false, error: 'not-own-message' };
    const { creatorId, roleId, description } = extractCard(loc.msg);
    if (!creatorId) return { ok: false, error: 'not-a-card' };
    const desc = (description && description !== DEFAULT_DESCRIPTION) ? description : null;
    await loc.msg.edit(buildCard(loc.channel.guild, creatorId, roleId, desc, loc.client.user.id)).catch(() => null);
    const rec = addCard({ messageId: r.messageId, channelId: r.channelId, guildId: loc.channel.guild?.id || null, creatorId, roleId, description: desc, botId: loc.client.user.id });
    return { ok: true, card: rec };
}

// "Shake" a tracked card — rebuild it in place, keeping owner + role.
async function fix(clients, messageId) {
    const card = getCard(messageId);
    if (!card) return { ok: false, error: 'not-tracked' };
    const loc = await locate(clients, card.channelId, messageId);
    if (!loc) return { ok: false, error: 'not-found' };
    if (!loc.client) return { ok: false, error: 'not-own-message' };
    const ex = extractCard(loc.msg);
    const creatorId = card.creatorId || ex.creatorId;
    const roleId = card.roleId ?? ex.roleId;
    const description = card.description ?? ((ex.description && ex.description !== DEFAULT_DESCRIPTION) ? ex.description : null);
    if (!creatorId) return { ok: false, error: 'no-owner' };
    await loc.msg.edit(buildCard(loc.channel.guild, creatorId, roleId, description, loc.client.user.id, cardOpts(card)));
    addCard({ ...card, creatorId, roleId, description });
    return { ok: true };
}

// Change a card's owner and/or granted role (edits the live message).
async function edit(clients, messageId, patch = {}) {
    const card = getCard(messageId);
    if (!card) return { ok: false, error: 'not-tracked' };
    const loc = await locate(clients, card.channelId, messageId);
    if (!loc) return { ok: false, error: 'not-found' };
    if (!loc.client) return { ok: false, error: 'not-own-message' };
    const creatorId = patch.creatorId || card.creatorId;
    const roleId = patch.roleId !== undefined ? (patch.roleId || null) : card.roleId;
    let description = card.description ?? null;
    if (patch.description !== undefined) {
        const d = String(patch.description).trim();
        description = d ? patch.description : null; // empty → default text
    }
    // Presentation fields — null on the record means "use the default".
    let title = card.title ?? null;
    if (patch.title !== undefined) { const s = String(patch.title).trim(); title = s ? patch.title : null; }
    let buttonLabel = card.buttonLabel ?? null;
    if (patch.buttonLabel !== undefined) { const s = String(patch.buttonLabel).trim(); buttonLabel = s ? patch.buttonLabel : null; }
    let color = card.color ?? null;
    if (patch.color !== undefined) { color = parseColor(patch.color) != null ? String(patch.color).trim() : null; }
    // buttonEmoji: '' = no emoji, non-empty = custom, absent key = default lock.
    let hasEmoji = Object.prototype.hasOwnProperty.call(card, 'buttonEmoji') && card.buttonEmoji !== undefined;
    let buttonEmoji = hasEmoji ? card.buttonEmoji : undefined;
    if (patch.buttonEmoji !== undefined) { hasEmoji = true; const e = String(patch.buttonEmoji).trim(); buttonEmoji = e ? e.slice(0, 100) : ''; }
    if (!creatorId) return { ok: false, error: 'no-owner' };
    const opts = { title, buttonLabel, color };
    if (hasEmoji) opts.buttonEmoji = buttonEmoji;
    await loc.msg.edit(buildCard(loc.channel.guild, creatorId, roleId, description, loc.client.user.id, opts));
    const recPatch = { ...card, creatorId, roleId, description, title, buttonLabel, color };
    if (hasEmoji) recPatch.buttonEmoji = buttonEmoji;
    const rec = addCard(recPatch);
    return { ok: true, card: rec };
}

// Delete the card's message and move it to the "deleted" list (stats kept).
async function remove(clients, messageId, deletedBy = null) {
    const card = getCard(messageId);
    if (!card) return { ok: true, deleted: false };
    markDeleted(messageId, deletedBy); // set before the delete so the messageDelete event is a no-op
    const loc = await locate(clients, card.channelId, messageId);
    if (loc?.client) await loc.msg.delete().catch(() => null);
    return { ok: true, deleted: Boolean(loc?.client) };
}

// Re-publish: post a fresh card in the same channel, then delete the old one —
// keeping owner + role. Used when an in-place edit isn't enough.
async function republish(clients, messageId) {
    const card = getCard(messageId);
    if (!card) return { ok: false, error: 'not-tracked' };
    const loc = await locate(clients, card.channelId, messageId);
    if (!loc || !loc.client) return { ok: false, error: 'not-found' };
    const ex = extractCard(loc.msg);
    const creatorId = card.creatorId || ex.creatorId;
    const roleId = card.roleId ?? ex.roleId;
    const description = card.description ?? ((ex.description && ex.description !== DEFAULT_DESCRIPTION) ? ex.description : null);
    if (!creatorId) return { ok: false, error: 'no-owner' };
    const sent = await loc.channel.send(buildCard(loc.channel.guild, creatorId, roleId, description, loc.client.user.id, cardOpts(card))).catch(() => null);
    if (!sent) return { ok: false, error: 'send-failed' };
    await loc.msg.delete().catch(() => null);
    removeCard(messageId);
    const rec = addCard({ ...card, messageId: sent.id, channelId: sent.channelId, guildId: loc.channel.guild?.id || null, creatorId, roleId, description, botId: loc.client.user.id });
    return { ok: true, card: rec };
}

// Reset a card's verification role: recreate an identical role from scratch
// (name, colour, icon/emoji, server permissions AND every per-channel overwrite),
// repoint the card at the new role, then delete the old one. Deleting the old
// role strips it from every member, so everyone must verify again — without the
// owner manually rebuilding the role, its channel permissions and the card.
async function resetRole(clients, messageId) {
    const card = getCard(messageId);
    if (!card) return { ok: false, error: 'not-tracked' };
    const loc = await locate(clients, card.channelId, messageId);
    if (!loc) return { ok: false, error: 'not-found' };
    if (!loc.client) return { ok: false, error: 'not-own-message' };
    const guild = loc.channel.guild;
    if (!guild) return { ok: false, error: 'no-guild' };

    // Resolve the role: explicit card role, else the legacy "Verified" role.
    const oldRole = card.roleId
        ? guild.roles.cache.get(card.roleId)
        : guild.roles.cache.find((r) => r.name === 'Verified');
    if (!oldRole) return { ok: false, error: 'no-role' };
    if (oldRole.id === guild.id) return { ok: false, error: 'role-everyone' };
    if (oldRole.managed) return { ok: false, error: 'role-managed' }; // bot/integration role

    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) return { ok: false, error: 'no-perms' };
    // The bot's highest role must sit ABOVE the target to delete/recreate it.
    if (me.roles.highest.comparePositionTo(oldRole) <= 0) return { ok: false, error: 'role-too-high' };

    // 1) Recreate the role with identical core settings. Icon needs boost L2 —
    //    if it's rejected, retry without it rather than fail the whole reset.
    let icon = null;
    if (oldRole.icon) {
        icon = await fetchBuffer(oldRole.iconURL({ size: 256, extension: 'png' })).catch(() => null);
    }
    const baseOpts = {
        name: oldRole.name,
        color: oldRole.color,
        hoist: oldRole.hoist,
        mentionable: oldRole.mentionable,
        permissions: oldRole.permissions,
        reason: 'Verification reset — recreate role'
    };
    if (oldRole.unicodeEmoji) baseOpts.unicodeEmoji = oldRole.unicodeEmoji;
    let newRole;
    try {
        newRole = await guild.roles.create(icon ? { ...baseOpts, icon } : baseOpts);
    } catch (e) {
        if (!icon) return { ok: false, error: 'create-failed' };
        newRole = await guild.roles.create(baseOpts).catch(() => null);
        if (!newRole) return { ok: false, error: 'create-failed' };
    }

    // 2) Copy every per-channel permission overwrite from the old role.
    for (const channel of guild.channels.cache.values()) {
        if (!channel?.permissionOverwrites) continue;
        const ow = channel.permissionOverwrites.cache.get(oldRole.id);
        if (!ow) continue;
        const opts = {};
        for (const p of ow.allow.toArray()) opts[p] = true;
        for (const p of ow.deny.toArray()) opts[p] = false;
        await channel.permissionOverwrites.create(newRole, opts, { reason: 'Verification reset — copy overwrites' }).catch(() => null);
    }

    // 3) Match hierarchy position (best-effort), then remove the old role.
    await newRole.setPosition(oldRole.position).catch(() => null);
    await oldRole.delete('Verification reset — old role removed').catch(() => null);

    // 4) Repoint the card at the new role and rebuild its message. Keep the old
    //    role id in roleHistory so the card's stats (keyed by role) survive the
    //    reset instead of dropping to zero.
    const history = [...(Array.isArray(card.roleHistory) ? card.roleHistory : []), (card.roleId || null)]
        .filter((v, i, a) => a.indexOf(v) === i);
    const rec = addCard({ ...card, roleId: newRole.id, roleHistory: history });
    await loc.msg.edit(buildCard(guild, card.creatorId, newRole.id, card.description ?? null, card.botId, cardOpts(card))).catch(() => null);

    return { ok: true, card: rec, oldRoleId: oldRole.id, newRoleId: newRole.id, roleName: newRole.name };
}

// Can a deleted card be re-published in its original channel? Cache-based (no
// API calls) so it's cheap to compute for the whole deleted list. Returns
// { can, reason, botId }. reason ∈ 'no-owner' | 'no-bot' (kicked) |
// 'no-channel' (deleted) | 'no-perms' (can't post there).
function restoreInfo(clients, card) {
    if (!card || !card.creatorId) return { can: false, reason: 'no-owner' };
    if (!card.channelId || !card.guildId) return { can: false, reason: 'no-channel' };
    const arr = Array.isArray(clients) ? clients : [];
    // Prefer the bot that originally authored the card, then any fleet bot on the guild.
    let candidates = arr.filter((c) => c.guilds?.cache?.has(card.guildId));
    if (card.botId) {
        const own = candidates.find((c) => c.user?.id === card.botId);
        if (own) candidates = [own, ...candidates.filter((c) => c !== own)];
    }
    if (!candidates.length) return { can: false, reason: 'no-bot' };
    let sawChannel = false;
    for (const c of candidates) {
        const guild = c.guilds.cache.get(card.guildId);
        const channel = guild?.channels?.cache?.get(card.channelId);
        if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) continue;
        sawChannel = true;
        const me = guild.members?.me;
        const perms = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
        if (perms && perms.has(PermissionsBitField.Flags.ViewChannel) && perms.has(PermissionsBitField.Flags.SendMessages)) {
            return { can: true, reason: null, botId: c.user.id };
        }
    }
    return { can: false, reason: sawChannel ? 'no-perms' : 'no-channel' };
}

// Re-publish a previously deleted card in its ORIGINAL channel, keeping owner +
// role + description. The record moves to the new message id and its deleted
// markers are cleared; funnel stats (keyed by guild/role/creator) carry over.
async function restore(clients, messageId) {
    const card = getCard(messageId);
    if (!card) return { ok: false, error: 'not-tracked' };
    if (!card.deletedAt) return { ok: false, error: 'not-deleted' };
    const info = restoreInfo(clients, card);
    if (!info.can) return { ok: false, error: info.reason };
    const arr = Array.isArray(clients) ? clients : [];
    const client = arr.find((c) => c.user?.id === info.botId) || arr.find((c) => c.guilds?.cache?.has(card.guildId));
    if (!client) return { ok: false, error: 'no-bot' };
    const guild = client.guilds.cache.get(card.guildId);
    const channel = await client.channels.fetch(card.channelId).catch(() => null);
    if (!channel || typeof channel.send !== 'function') return { ok: false, error: 'no-channel' };
    const sent = await channel.send(buildCard(guild, card.creatorId, card.roleId, card.description || null, info.botId, cardOpts(card))).catch(() => null);
    if (!sent) return { ok: false, error: 'send-failed' };
    removeCard(messageId); // fresh record (no deletedAt) under the new message id
    const rec = addCard({
        ...card, messageId: sent.id, channelId: sent.channelId, guildId: card.guildId,
        botId: client.user.id, createdAt: card.createdAt || Date.now(), deletedAt: 0, deletedBy: null
    });
    return { ok: true, card: rec };
}

// ---- First-click tracking (funnel metric #1) ----
// A card is identified for stats by (guild, role, creator) — the same tuple a
// verified.json entry / joinlinks record carries, so all three funnel stages
// line up. First clicks aren't otherwise persisted, so we log them here. The
// first-click handler in index.js only fires once per ~5-minute session per
// user (pendingVerification gate), so this already counts "sessions started",
// not raw re-clicks. Events older than a week are pruned on write.
const CLICK_TTL = 7 * 86400000;
function clickKey(guildId, roleId, creatorId) { return `${guildId || ''}:${roleId || ''}:${creatorId || ''}`; }
function trackClick(guildId, roleId, creatorId, userId) {
    if (!guildId || !creatorId) return;
    const now = Date.now();
    const list = loadJSON('cardclicks.json', []);
    const arr = (Array.isArray(list) ? list : []).filter((e) => e.t > now - CLICK_TTL);
    arr.push({ k: clickKey(guildId, roleId, creatorId), u: String(userId || ''), t: now });
    saveJSON('cardclicks.json', arr);
}
// Raw first-click events [{ u, t }] for a card — used to measure the delay
// from the first click to a successful join-check verification.
function clicksForKey(guildId, roleId, creatorId) {
    const k = clickKey(guildId, roleId, creatorId);
    const list = loadJSON('cardclicks.json', []);
    return (Array.isArray(list) ? list : []).filter((e) => e.k === k).map((e) => ({ u: e.u, t: e.t }));
}

// Unique users who first-clicked this card in the last hour / day / week.
function clickWindows(guildId, roleId, creatorId, now = Date.now()) {
    const k = clickKey(guildId, roleId, creatorId);
    const list = loadJSON('cardclicks.json', []);
    const h = new Set(), d = new Set(), w = new Set();
    for (const e of Array.isArray(list) ? list : []) {
        if (e.k !== k) continue;
        if (e.t > now - 3600000) h.add(e.u);
        if (e.t > now - 86400000) d.add(e.u);
        if (e.t > now - 604800000) w.add(e.u);
    }
    return { hour: h.size, day: d.size, week: w.size };
}

// Same as the two above, but aggregating across SEVERAL role ids — so a card
// whose role was reset (new id) still counts clicks recorded under its old
// role(s). `roleIds` = cardRoleIds(card).
function clicksForKeyMulti(guildId, roleIds, creatorId) {
    const keys = new Set((Array.isArray(roleIds) ? roleIds : [roleIds]).map((r) => clickKey(guildId, r, creatorId)));
    const list = loadJSON('cardclicks.json', []);
    return (Array.isArray(list) ? list : []).filter((e) => keys.has(e.k)).map((e) => ({ u: e.u, t: e.t }));
}
function clickWindowsMulti(guildId, roleIds, creatorId, now = Date.now()) {
    const keys = new Set((Array.isArray(roleIds) ? roleIds : [roleIds]).map((r) => clickKey(guildId, r, creatorId)));
    const list = loadJSON('cardclicks.json', []);
    const h = new Set(), d = new Set(), w = new Set();
    for (const e of Array.isArray(list) ? list : []) {
        if (!keys.has(e.k)) continue;
        if (e.t > now - 3600000) h.add(e.u);
        if (e.t > now - 86400000) d.add(e.u);
        if (e.t > now - 604800000) w.add(e.u);
    }
    return { hour: h.size, day: d.size, week: w.size };
}

// ---- Scan existing cards ----
// Walk every readable text channel across the fleet, find our own
// verification-card messages (our button + a "Created by" footer) and add any
// that aren't tracked yet. Runs in the background (Discord rate limits make it
// slow) with a live progress state the panel can poll.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let scanState = { running: false, found: 0, scannedChannels: 0, startedAt: 0, finishedAt: 0 };
const MAX_SCAN_CHANNELS = 5000; // runaway guard

function isCardMessage(msg, botId) {
    if (msg.author?.id !== botId) return false;
    for (const row of msg.components || []) {
        for (const comp of row.components || []) {
            if (String(comp.customId || comp.custom_id || '').startsWith('start_verif_guild')) return true;
        }
    }
    return false;
}

function scanAll(clients) {
    if (scanState.running) return scanState;
    scanState = { running: true, found: 0, scannedChannels: 0, startedAt: Date.now(), finishedAt: 0 };
    (async () => {
        try {
            const existing = new Set(loadCards().map((c) => c.messageId));
            for (const c of Array.isArray(clients) ? clients : []) {
                const botId = c.user?.id;
                if (!botId) continue;
                for (const guild of c.guilds.cache.values()) {
                    for (const ch of guild.channels.cache.values()) {
                        if (scanState.scannedChannels >= MAX_SCAN_CHANNELS) return;
                        if (!ch || typeof ch.isTextBased !== 'function' || !ch.isTextBased() || !ch.viewable) continue;
                        const msgs = await ch.messages.fetch({ limit: 50 }).catch(() => null);
                        scanState.scannedChannels++;
                        if (msgs) {
                            for (const msg of msgs.values()) {
                                if (!isCardMessage(msg, botId) || existing.has(msg.id)) continue;
                                const { creatorId, roleId } = extractCard(msg);
                                if (!creatorId) continue;
                                addCard({ messageId: msg.id, channelId: ch.id, guildId: guild.id, creatorId, roleId, botId });
                                existing.add(msg.id);
                                scanState.found++;
                            }
                        }
                        await sleep(250); // gentle on rate limits
                    }
                }
            }
        } catch (e) { console.error('[CARDS] scan error:', e.message); }
        finally { scanState.running = false; scanState.finishedAt = Date.now(); }
    })();
    return scanState;
}
function getScanState() { return scanState; }

// ---- Deletion detection ----
// Definitively decide whether a card's message still exists. Only a real
// "Unknown Message/Channel" (10008/10003) counts as gone — transient errors
// stay 'unknown' so we never false-mark a card as deleted.
async function checkExists(clients, card) {
    for (const c of Array.isArray(clients) ? clients : []) {
        let channel;
        try { channel = await c.channels.fetch(card.channelId); }
        catch (e) { if (e?.code === 10003) return 'gone'; channel = null; }
        if (!channel || typeof channel.messages?.fetch !== 'function') continue;
        try { const msg = await channel.messages.fetch(card.messageId); if (msg) return 'exists'; }
        catch (e) { if (e?.code === 10008) return 'gone'; }
    }
    return 'unknown';
}

// Periodic sweep: mark any active card whose message is gone as deleted.
let sweepRunning = false;
async function sweepDeleted(clients) {
    if (sweepRunning) return 0;
    sweepRunning = true;
    let marked = 0;
    try {
        for (const card of loadCards()) {
            if (card.deletedAt) continue;
            const state = await checkExists(clients, card).catch(() => 'unknown');
            if (state === 'gone') { markDeleted(card.messageId, null); marked++; }
            await sleep(300);
        }
    } catch (e) { console.error('[CARDS] sweep error:', e.message); }
    finally { sweepRunning = false; }
    return marked;
}
function startCardSweep(clients) {
    const every = Number(process.env.CARD_SWEEP_MS) || 10 * 60 * 1000;
    const tick = () => sweepDeleted(clients).catch(() => null);
    setInterval(tick, every);
    setTimeout(tick, 90 * 1000); // first pass shortly after startup
    console.log(`[CARDS] deletion sweep every ${Math.round(every / 60000)}m`);
}

// Realtime: fired from Events.MessageDelete on any bot with the GuildMessages
// intent. If the deleted message is a tracked active card, mark it deleted and
// try to learn who removed it from the audit log (needs View Audit Log).
async function handleMessageDelete(clients, message) {
    const id = message?.id;
    if (!id) return;
    const card = getCard(id);
    if (!card || card.deletedAt) return;
    let deletedBy = null;
    try {
        const guild = message.guild;
        if (guild?.fetchAuditLogs) {
            const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 6 }).catch(() => null);
            const now = Date.now();
            const entry = logs?.entries?.find((e) =>
                e?.target?.id === card.botId &&
                (!e.extra?.channel || e.extra.channel.id === card.channelId) &&
                (now - (e.createdTimestamp || 0)) < 20000);
            if (entry?.executor?.id) deletedBy = entry.executor.id;
        }
    } catch { /* no audit access → deleter stays unknown */ }
    markDeleted(id, deletedBy);
}

// ---- Auto-reset: periodically reset a card's verification role on a cooldown.
// The cooldown counts from the moment the setting was last changed (autoResetNext
// is stamped then) and again after every auto-reset. 0/empty disables it.
function setAutoReset(messageId, ms) {
    const card = getCard(messageId);
    if (!card) return null;
    const on = Number(ms) > 0;
    return addCard({ ...card, autoResetMs: on ? Math.floor(Number(ms)) : 0, autoResetNext: on ? Date.now() + Math.floor(Number(ms)) : 0 });
}
async function tickAutoReset(clients) {
    const now = Date.now();
    for (const c of loadCards()) {
        if (c.deletedAt || !c.autoResetMs || c.autoResetMs <= 0) continue;
        if (!c.autoResetNext || c.autoResetNext > now) continue;
        try { await resetRole(clients, c.messageId); }
        catch (e) { console.warn('[CARDS] auto-reset failed', c.messageId, e && e.message); }
        // Reschedule regardless of outcome so a broken card can't hot-loop.
        const cur = getCard(c.messageId);
        if (cur && cur.autoResetMs > 0) addCard({ ...cur, autoResetNext: Date.now() + cur.autoResetMs });
    }
}
function startAutoReset(clients) {
    const every = Number(process.env.AUTO_RESET_TICK_MS) || 60 * 1000;
    setInterval(() => tickAutoReset(clients).catch(() => null), every);
    console.log(`[CARDS] auto-reset tick every ${Math.round(every / 1000)}s`);
}

// ---- "Always at bottom": keep the card the last message in its channel. Rather
// than subscribe to the gateway (which would fire on every message in every guild
// a bot is in — the intent can't be scoped to one channel), we poll ONLY the
// channels that host a sticky card: fetch the channel's newest message and, if
// it isn't the card, delete the card and re-send it. No message intent needed —
// any bot that owns the card can do it over REST.
function setAlwaysBottom(messageId, on) {
    const card = getCard(messageId);
    if (!card) return null;
    return addCard({ ...card, alwaysBottom: !!on });
}
let stickyTickBusy = false;
async function tickAlwaysBottom(clients) {
    if (stickyTickBusy) return;      // don't overlap a slow sweep with the next tick
    stickyTickBusy = true;
    try {
        for (const card of loadCards()) {
            if (card.deletedAt || !card.alwaysBottom) continue;
            const loc = await locate(clients, card.channelId, card.messageId);
            if (!loc || !loc.client) continue;   // gone/unreachable — the sweep handles deletion
            // Only repost when the card is no longer the newest message.
            const latest = await loc.channel.messages.fetch({ limit: 1 }).catch(() => null);
            const newestId = latest && latest.first() ? latest.first().id : null;
            if (!newestId || newestId === card.messageId) continue;
            await stickyRepost(clients, card.messageId).catch(() => null);
        }
    } finally { stickyTickBusy = false; }
}
function startAlwaysBottom(clients) {
    const every = Number(process.env.STICKY_BOTTOM_MS) || 4000;
    setInterval(() => tickAlwaysBottom(clients).catch(() => null), every);
    console.log(`[CARDS] always-at-bottom poll every ${Math.round(every / 1000)}s`);
}
// Re-send the card as a fresh message and delete the old one, preserving every
// tracked field (owner, role, description, alwaysBottom, auto-reset, createdAt…).
async function stickyRepost(clients, messageId) {
    const card = getCard(messageId);
    if (!card || !card.alwaysBottom) return { ok: false, error: 'not-tracked' };
    const loc = await locate(clients, card.channelId, messageId);
    if (!loc || !loc.client) return { ok: false, error: 'not-found' };
    const ex = extractCard(loc.msg);
    const creatorId = card.creatorId || ex.creatorId;
    const roleId = card.roleId ?? ex.roleId;
    const description = card.description ?? ((ex.description && ex.description !== DEFAULT_DESCRIPTION) ? ex.description : null);
    if (!creatorId) return { ok: false, error: 'no-owner' };
    const sent = await loc.channel.send(buildCard(loc.channel.guild, creatorId, roleId, description, loc.client.user.id, cardOpts(card))).catch(() => null);
    if (!sent) return { ok: false, error: 'send-failed' };
    await loc.msg.delete().catch(() => null);
    removeCard(messageId);
    const rec = addCard({ ...card, messageId: sent.id, channelId: sent.channelId, guildId: loc.channel.guild?.id || null, creatorId, roleId, description, botId: loc.client.user.id });
    return { ok: true, card: rec };
}

module.exports = {
    setAutoReset, tickAutoReset, startAutoReset,
    setAlwaysBottom, tickAlwaysBottom, startAlwaysBottom,
    setTemplate, templateForGuild,
    loadCards, saveCards, addCard, removeCard, getCard,
    buildCard, parseMsgRef, extractCard, locate, DEFAULT_DESCRIPTION,
    PERSONALIZED_BOT_ID, FAQ_TEXT, buildFaqView,
    register, fix, edit, remove, republish, restore, restoreInfo, resetRole,
    trackClick, clickWindows, clicksForKey, clickWindowsMulti, clicksForKeyMulti, cardRoleIds, scanAll, getScanState,
    markDeleted, sweepDeleted, startCardSweep, handleMessageDelete
};
