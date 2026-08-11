// Chat attachments (image / video / file) — ported from vibecheckbot, minus the
// boost/VIP gate (uploads here are open to any logged-in user). Files are written
// to DATA_DIR/uploads with a CONTENT-HASH name (sha1 → dedupe + immutable URL) and
// served back with long-cache + Range support (needed for iOS video/audio).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./database.js');

const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

// ext → mime for serving. Only media renders inline; anything else downloads.
const SERVE_TYPES = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
};
const IMAGE_EXT = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1 };
const VIDEO_EXT = { mp4: 1, mov: 1, m4v: 1, webm: 1 };

function ensureDir() { try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) {} }

// Save a base64 data URL. Returns { url, kind, name } or { error, status }.
function save(dataUrl, origName) {
    const match = /^data:([\w.+-]+\/[\w.+-]+)?;base64,(.+)$/is.exec(String(dataUrl || ''));
    if (!match) return { error: 'need-file', status: 400 };
    const mime = (match[1] || 'application/octet-stream').toLowerCase();
    let buf; try { buf = Buffer.from(match[2], 'base64'); } catch (_) { return { error: 'bad-data', status: 400 }; }
    if (!buf.length) return { error: 'empty', status: 400 };
    const nameExt = (String(origName || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/) || [])[1] || '';

    let kind, ext, limit;
    if (mime.startsWith('image/')) {
        kind = 'image';
        const sub = mime.split('/')[1].replace(/[^a-z0-9]/g, '');
        ext = sub === 'jpeg' ? 'jpg' : sub;
        if (!IMAGE_EXT[ext]) return { error: 'image-type', status: 415 };
        limit = 8 * 1024 * 1024;
    } else if (mime.startsWith('video/')) {
        kind = 'video';
        ext = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v', 'video/webm': 'webm' }[mime] || nameExt;
        if (!VIDEO_EXT[ext]) return { error: 'video-type', status: 415 };
        limit = 25 * 1024 * 1024;
    } else {
        kind = 'file';
        ext = (nameExt.match(/^[a-z0-9]{1,8}$/) ? nameExt : 'bin');
        limit = 20 * 1024 * 1024;
    }
    if (buf.length > limit) return { error: 'too-big', status: 413, limitMb: Math.round(limit / 1024 / 1024) };

    ensureDir();
    const name = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)}.${ext}`;
    const file = path.join(UPLOAD_DIR, name);
    try { if (!fs.existsSync(file)) fs.writeFileSync(file, buf); } catch (e) { return { error: 'write-failed', status: 500 }; }
    return { url: `/uploads/${name}`, kind, name: String(origName || '').slice(0, 80) };
}

// Serve /uploads/<hash>.<ext>. Validates the hashed name, supports Range.
function serve(req, res, pathname) {
    const name = path.basename(pathname);
    if (!/^[0-9a-f]{16}\.[a-z0-9]{1,8}$/.test(name)) { res.writeHead(404); return res.end('404'); }
    const file = path.join(UPLOAD_DIR, name);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('404'); }
    const type = SERVE_TYPES[path.extname(name).slice(1)] || 'application/octet-stream';
    const total = fs.statSync(file).size;
    const head = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
    };
    // Non-media → force download (never render html/svg on our origin).
    if (!/^(image|video|audio)\//.test(type)) head['Content-Disposition'] = 'attachment';
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range) {
        const start = range[1] ? parseInt(range[1], 10) : 0;
        const end = range[2] ? parseInt(range[2], 10) : total - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= total) {
            res.writeHead(416, { 'Content-Range': `bytes */${total}` }); return res.end();
        }
        head['Content-Range'] = `bytes ${start}-${end}/${total}`;
        head['Content-Length'] = end - start + 1;
        res.writeHead(206, head);
        return fs.createReadStream(file, { start, end }).pipe(res);
    }
    head['Content-Length'] = total;
    res.writeHead(200, head);
    return fs.createReadStream(file).pipe(res);
}

module.exports = { UPLOAD_DIR, save, serve };
