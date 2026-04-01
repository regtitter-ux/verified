const fs = require('fs');
const path = require('path');

const resolve = (file) => path.resolve(__dirname, file);

const loadJSON = (file, fallback = {}) => {
    try {
        const filePath = resolve(file);
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            return data ? JSON.parse(data) : fallback;
        }
    } catch (e) {
        console.error(`[ERROR] Failed to load ${file}:`, e);
    }
    return fallback;
};

const saveJSON = (file, data) => {
    try {
        fs.writeFileSync(resolve(file), JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`[ERROR] Failed to save ${file}:`, e);
    }
};

module.exports = { loadJSON, saveJSON };
