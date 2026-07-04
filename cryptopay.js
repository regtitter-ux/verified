// Crypto Pay API (@CryptoBot) client — zero external deps (Node's built-in https).
// Used for fully-automatic USDT payouts via redeemable checks (createCheck): the
// user gets a t.me/CryptoBot claim link, funded from this app's Crypto Pay balance.
//
// Enable by setting CRYPTO_PAY_TOKEN (create an app in @CryptoBot -> Crypto Pay).
// Set CRYPTO_PAY_TESTNET=1 to use the testnet (@CryptoTestnetBot / testnet-pay.crypt.bot).
// Docs: https://help.send.tg/en/articles/10279948-crypto-pay-api
const https = require('https');

const TOKEN = (process.env.CRYPTO_PAY_TOKEN || '').trim(); // trim stray whitespace/newlines from the env var
// Only explicit truthy values enable testnet — note "0"/"false" are non-empty
// strings and would otherwise read as truthy.
const TESTNET = /^(1|true|yes|on)$/i.test((process.env.CRYPTO_PAY_TESTNET || '').trim());
const HOST = TESTNET ? 'testnet-pay.crypt.bot' : 'pay.crypt.bot';

// Auto-payout is only active when a token is configured; otherwise the bot keeps
// the manual staff-completed payout flow.
const enabled = () => Boolean(TOKEN);

function call(method, params = {}) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(params);
        const req = https.request({
            host: HOST,
            path: `/api/${method}`,
            method: 'POST',
            headers: {
                'Crypto-Pay-API-Token': TOKEN,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try {
                    const j = JSON.parse(data);
                    if (j.ok) resolve(j.result);
                    else reject(new Error(j.error?.name || j.error?.code || 'crypto-pay error'));
                } catch (e) { reject(new Error('bad response')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('timeout')));
        req.write(body);
        req.end();
    });
}

// Available USDT on the app balance (float), or null if the API is unreachable.
async function usdtAvailable() {
    const bal = await call('getBalance').catch(() => null);
    if (!Array.isArray(bal)) return null;
    const u = bal.find((x) => x.currency_code === 'USDT');
    return u ? Number(u.available) || 0 : 0;
}

// Create a redeemable USDT check. Returns the Check object (has check_id, bot_check_url).
async function createUsdtCheck(amount, opts = {}) {
    return call('createCheck', { asset: 'USDT', amount: String(amount), ...opts });
}

module.exports = { enabled, call, usdtAvailable, createUsdtCheck, HOST };
