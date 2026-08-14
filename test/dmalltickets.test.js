const { reset } = require('./setup');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const tk = require('../dmalltickets.js');

const U = '111111111111111111', STAFF = '222222222222222222';
beforeEach(() => reset());

test('create → open; user reply keeps open; staff reply → answered; reopen on new reply', () => {
    const t = tk.create({ userId: U, userName: 'Alice', subject: 'Help', body: 'It broke' });
    assert.equal(t.status, 'open');
    assert.equal(t.messages.length, 1);
    assert.equal(t.messages[0].staff, false);

    // staff answers → answered
    let u = tk.reply(t.id, { authorId: STAFF, authorName: 'Mod', staff: true, body: 'Looking into it' });
    assert.equal(u.status, 'answered');
    assert.equal(u.messages.length, 2);
    assert.equal(u.messages[1].staff, true);

    // user answers → back to open
    u = tk.reply(t.id, { authorId: U, authorName: 'Alice', staff: false, body: 'Still broken' });
    assert.equal(u.status, 'open');

    // close, then a reply reopens
    assert.equal(tk.setStatus(t.id, 'closed', { byStaff: true }).status, 'closed');
    assert.equal(tk.reply(t.id, { authorId: STAFF, staff: true, body: 'reopened' }).status, 'answered');
});

test('empty reply is rejected; unknown ticket returns null; attachment-only reply is allowed', () => {
    const t = tk.create({ userId: U, subject: 'x', body: 'y' });
    assert.equal(tk.reply(t.id, { authorId: U, staff: false, body: '   ' }), null);
    assert.equal(tk.reply('nope', { authorId: U, staff: false, body: 'hi' }), null);
    // a message with no text but an attachment is accepted
    const u = tk.reply(t.id, { authorId: U, staff: false, body: '', attachments: [{ url: '/uploads/abcdef0123456789.png', kind: 'image', name: 'p.png' }] });
    assert.ok(u, 'attachment-only reply accepted');
    assert.equal(u.messages[u.messages.length - 1].attachments.length, 1);
});

test('users may only close their own ticket; staff may set any status', () => {
    const t = tk.create({ userId: U, subject: 'x', body: 'y' });
    assert.equal(tk.setStatus(t.id, 'closed', { byStaff: false, byUserId: 'someone-else' }), null, 'stranger cannot close');
    assert.equal(tk.setStatus(t.id, 'open', { byStaff: false, byUserId: U }), null, 'user cannot force-open');
    assert.equal(tk.setStatus(t.id, 'closed', { byStaff: false, byUserId: U }).status, 'closed', 'owner can close');
    assert.equal(tk.setStatus(t.id, 'open', { byStaff: true }).status, 'open', 'staff can reopen');
});

test('unread flags: new user message is unread for staff until they read it', () => {
    const t = tk.create({ userId: U, subject: 'x', body: 'y' });
    let raw = tk.get(t.id);
    assert.equal(tk.unreadForStaff(raw), true, 'new open ticket unread for staff');
    tk.markRead(t.id, { staff: true });
    raw = tk.get(t.id);
    assert.equal(tk.unreadForStaff(raw), false, 'read → not unread');
    // staff replies → unread for the user now
    tk.reply(t.id, { authorId: STAFF, staff: true, body: 'answer' });
    raw = tk.get(t.id);
    assert.equal(tk.unreadForUser(raw), true);
    tk.markRead(t.id, { staff: false });
    assert.equal(tk.unreadForUser(tk.get(t.id)), false);
});

test('deleteMessage: only the author may delete their own message', () => {
    const t = tk.create({ userId: U, subject: 'x', body: 'first' });
    const u = tk.reply(t.id, { authorId: STAFF, staff: true, body: 'staff msg' });
    const mid = u.messages[1].id;
    assert.equal(tk.deleteMessage(t.id, mid, U), null, 'user cannot delete staff message');
    const ok = tk.deleteMessage(t.id, mid, STAFF);
    assert.ok(ok, 'author (staff) deletes own message');
    assert.equal(ok.messages.length, 1);
    assert.equal(tk.deleteMessage('nope', 'x', U), null);
});

test('remove deletes a ticket; openCountForUser counts non-closed', () => {
    const a = tk.create({ userId: U, subject: 'a', body: '1' });
    tk.create({ userId: U, subject: 'b', body: '2' });
    const c = tk.create({ userId: U, subject: 'c', body: '3' });
    assert.equal(tk.openCountForUser(U), 3);
    tk.setStatus(c.id, 'closed', { byStaff: true });
    assert.equal(tk.openCountForUser(U), 2, 'closed no longer counts');
    assert.equal(tk.remove(a.id), true);
    assert.equal(tk.remove(a.id), false, 'already gone');
    assert.equal(tk.openCountForUser(U), 1);
    assert.equal(tk.MAX_OPEN_PER_USER, 3);
});

test('list is newest-activity first; forUser filters to the owner', () => {
    const a = tk.create({ userId: U, subject: 'a', body: '1' });
    const b = tk.create({ userId: STAFF, subject: 'b', body: '2' });
    tk.reply(a.id, { authorId: U, staff: false, body: 'bump' });   // a now most recent
    assert.equal(tk.list()[0].id, a.id);
    assert.deepEqual(tk.forUser(U).map((t) => t.id), [a.id]);
    assert.equal(tk.forUser(STAFF).length, 1);
});
