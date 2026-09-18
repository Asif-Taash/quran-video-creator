const https = require('https');
const fs = require('fs');
const path = require('path');

const URL = "https://api.quran.com/api/v4/quran/verses/code_v2";
const OUTPUT_FILE = path.join(__dirname, "data", "quran_pua_v2.json");

console.log(`Fetching PUA data from ${URL}...`);

https.get(URL, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
    let rawData = '';
    res.on('data', (chunk) => { rawData += chunk; });
    res.on('end', () => {
        try {
            const data = JSON.parse(rawData);
            const formatted_data = [];
            
            for (const verse of data.verses || []) {
                const verse_key = verse.verse_key || '';
                const parts = verse_key.split(':');
                if (parts.length === 2) {
                    formatted_data.push({
                        id: verse.id,
                        sura: parseInt(parts[0], 10),
                        aya: parseInt(parts[1], 10),
                        text: verse.code_v2,
                        page: verse.v2_page
                    });
                }
            }
            
            const dir = path.dirname(OUTPUT_FILE);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            fs.writeFileSync(OUTPUT_FILE, JSON.stringify(formatted_data, null, 2), 'utf8');
            console.log(`Successfully saved ${formatted_data.length} verses to ${OUTPUT_FILE}`);
        } catch (e) {
            console.error(e.message);
            process.exit(1);
        }
    });
}).on('error', (e) => {
    console.error(`Got error: ${e.message}`);
    process.exit(1);
});
