(() => {
    const b64 = (u8) => {
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) {
            s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
        }
        return btoa(s);
    };

    // Extract "Biketerra - [Activity Name]" from the page
    function getFormattedActivityName() {
        const inputVal = document.querySelector('.editable-title')?.value?.trim();
        if (inputVal) {
            return inputVal.startsWith('Biketerra - ') ? inputVal : `Biketerra - ${inputVal}`;
        }

        const rawTitle = document.title || '';
        const cleaned = rawTitle
        .replace(/^Activity\s*-\s*/i, '')
        .replace(/\s*-\s*Biketerra$/i, '')
        .trim();

        if (cleaned && cleaned.toLowerCase() !== 'biketerra') {
            return `Biketerra - ${cleaned}`;
        }

        return 'Biketerra - Virtual Ride';
    }

    // --- 1. SUUNTO FIT ENCODER ---
    function encodeBiketerraJsonToFIT(activityJson, pageSummary = {}, activityName = 'Biketerra - Virtual Ride', useIndoorTag = true) {
        const FIT_EPOCH = 631065600;
        const toFT = ms => Math.round(ms / 1000) - FIT_EPOCH;

        const keys = activityJson.keys || [];
        const rows = activityJson.rows || [];
        const events = activityJson.events || [];
        if (rows.length === 0) throw new Error('Activity has no data rows');

        const idx = {
            ts: keys.indexOf('timestamp'),
 lat: keys.indexOf('lat'),
 lng: keys.indexOf('lng'),
 alt: keys.indexOf('altitude'),
 hr: keys.indexOf('heart_rate'),
 cad: keys.indexOf('cadence'),
 dist: keys.indexOf('distance'),
 spd: keys.indexOf('speed'),
 pwr: keys.indexOf('power')
        };

        const toSC = val => {
            if (val == null) return 0x7FFFFFFF;
            if (Math.abs(val) > 180) return Math.round(val);
            return Math.round(val * 11930464.71);
        };

        const msgs = [];
        function defMsg(l, g, f) {
            const b = new Uint8Array(6 + f.length * 3);
            b[0] = 0x40 | l; b[3] = g & 0xFF; b[4] = (g >> 8) & 0xFF; b[5] = f.length;
            for (let i = 0; i < f.length; i++) {
                b[6 + i * 3] = f[i][0]; b[7 + i * 3] = f[i][1]; b[8 + i * 3] = f[i][2];
            }
            return b;
        }
        function dataMsg(l, vals) {
            const ab = new ArrayBuffer(1 + vals.reduce((s, v) => s + v.size, 0));
            const dv = new DataView(ab);
            dv.setUint8(0, l & 0x0F);
            let o = 1;
            for (const v of vals) {
                if (v.arr) {
                    for (const item of v.arr) {
                        if (v.elemSize === 1) dv.setUint8(o, item);
                        else if (v.elemSize === 2) dv.setUint16(o, item, true);
                        else if (v.elemSize === 4) dv.setUint32(o, item, true);
                        o += v.elemSize;
                    }
                } else {
                    if (v.size === 1) dv.setUint8(o, v.val);
                    else if (v.size === 2) dv.setUint16(o, v.val, true);
                    else if (v.size === 4) dv.setUint32(o, v.val, true);
                    o += v.size;
                }
            }
            return new Uint8Array(ab);
        }

        const u8 = val => ({ size: 1, val: Math.min(255, Math.max(0, Math.round(val ?? 0))) });
        const u16 = val => ({ size: 2, val: Math.min(65535, Math.max(0, Math.round(val ?? 0))) });
        const u32 = val => ({ size: 4, val: Math.max(0, Math.round(val ?? 0)) });
        const s32 = val => ({ size: 4, val: val < 0 ? Math.round(val) + 0x100000000 : Math.round(val) });
        const u8Arr = arr => ({ size: arr.length, elemSize: 1, arr: arr.map(v => Math.min(255, Math.max(0, Math.round(v ?? 0)))) });
        const u16Arr = arr => ({ size: arr.length * 2, elemSize: 2, arr: arr.map(v => Math.min(65535, Math.max(0, Math.round(v ?? 0)))) });
        const u32Arr = arr => ({ size: arr.length * 4, elemSize: 4, arr: arr.map(v => Math.max(0, Math.round(v ?? 0))) });

        const startTimeMs = rows[0][idx.ts];
        const endTimeMs = rows[rows.length - 1][idx.ts];
        const userFtp = Number(activityJson.ftp) || 311;
        const subSportId = useIndoorTag ? 6 : 0; // 6 = indoor_cycling

        // 1. File ID (Global Msg 0)
        msgs.push(defMsg(0, 0, [
            [3, 4, 0x8C], // serial_number (4B)
        [4, 4, 0x86], // time_created (4B)
        [1, 2, 0x84], // manufacturer (2B - 23 = Suunto)
        [2, 2, 0x84], // product (2B - 40 = Suunto Race)
        [0, 1, 0x00]  // type (1B - 4 = activity)
        ]));
        msgs.push(dataMsg(0, [u32(98765432), u32(toFT(startTimeMs)), u16(23), u16(40), u8(4)]));

        // 2. Sport Message (Global Msg 12) - Embeds activity title in Field 3 (name)
        const nameBytes = new TextEncoder().encode(activityName + '\0');
        msgs.push(defMsg(8, 12, [
            [0, 1, 0x00],                 // sport (2 = cycling)
        [1, 1, 0x00],                 // sub_sport (6 = indoor_cycling)
        [3, nameBytes.length, 0x07]   // name (string)
        ]));
        msgs.push(dataMsg(8, [
            u8(2),
                          u8(subSportId),
                          u8Arr(Array.from(nameBytes))
        ]));

        // 3. Workout Name (Global Msg 26) - Embeds activity title in Field 8 (wkt_name)
        msgs.push(defMsg(7, 26, [
            [254, 2, 0x84],               // message_index (2B)
        [4, 1, 0x00],                 // sport (1B - 2 = cycling)
        [8, nameBytes.length, 0x07]   // wkt_name (string)
        ]));
        msgs.push(dataMsg(7, [
            u16(0),
                          u8(2),
                          u8Arr(Array.from(nameBytes))
        ]));

        // 4. Device Info (Global Msg 23)
        msgs.push(defMsg(6, 23, [
            [253, 4, 0x86], [3, 4, 0x8C], [2, 2, 0x84], [4, 2, 0x84],
            [6, 2, 0x84], [0, 1, 0x02], [1, 1, 0x02], [25, 1, 0x00]
        ]));
        msgs.push(dataMsg(6, [u32(toFT(startTimeMs)), u32(98765432), u16(23), u16(40), u16(256), u8(0), u8(1), u8(5)]));
        msgs.push(dataMsg(6, [u32(toFT(startTimeMs)), u32(83150001), u16(89), u16(1), u16(100), u8(1), u8(11), u8(3)]));

        // 5. Record Definition (Global Msg 20)
        msgs.push(defMsg(1, 20, [
            [253, 4, 0x86], [0, 4, 0x85], [1, 4, 0x85], [5, 4, 0x86],
            [29, 4, 0x86], [73, 4, 0x86], [78, 4, 0x86], [2, 2, 0x84],
            [6, 2, 0x84], [7, 2, 0x84], [3, 1, 0x02], [4, 1, 0x02]
        ]));

        let simulatedCycles = 0;
        let accumPower = 0;
        let lastFitTs = -1;
        const ticks = [];

        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            let fitTs = toFT(r[idx.ts]);
            if (fitTs <= lastFitTs) fitTs = lastFitTs + 1;
            lastFitTs = fitTs;

            const lat = r[idx.lat];
            const lng = r[idx.lng];
            const alt = r[idx.alt] != null ? Number(r[idx.alt]) : 0;
            const hr = Number(r[idx.hr] || 0);
            const cad = Number(r[idx.cad] || 0);
            const dist = Number(r[idx.dist] || 0);
            const spd = Number(r[idx.spd] || 0);
            const pwr = Math.max(0, Math.round(Number(r[idx.pwr] || 0)));

            simulatedCycles += (cad / 60);
            const cycles = Math.floor(simulatedCycles);
            accumPower += pwr;
            const encodedAlt = Math.round((alt + 500) * 5);
            const encodedSpd = Math.round(spd * 1000);

            msgs.push(dataMsg(1, [
                u32(fitTs),
                              s32(toSC(lat)),
                              s32(toSC(lng)),
                              u32(dist * 100),
                              u32(accumPower),
                              u32(encodedSpd),
                              u32(encodedAlt),
                              u16(encodedAlt),
                              u16(encodedSpd),
                              u16(pwr),
                              u8(hr),
                              u8(cad)
            ]));

            ticks.push({ ts: r[idx.ts], fitTs, alt, hr, cad, dist, spd, pwr, cycles });
        }

        const pwrBounds = [
            Math.round(userFtp * 0.55),
 Math.round(userFtp * 0.75),
 Math.round(userFtp * 0.90),
 Math.round(userFtp * 1.05),
 Math.round(userFtp * 1.20)
        ];
        const hrBounds = [138, 154, 162, 173, 190];

        function calcSliceStats(slice) {
            let sumP = 0, maxP = 0, sumS = 0, maxS = 0, sumH = 0, cntH = 0, maxH = 0, sumC = 0, cntC = 0, maxC = 0;
            let ascent = 0, descent = 0;
            const pwrZones5 = [0, 0, 0, 0, 0];
            const hrZones5 = [0, 0, 0, 0, 0];

            for (let i = 0; i < slice.length; i++) {
                const t = slice[i];
                sumP += t.pwr;
                if (t.pwr > maxP) maxP = t.pwr;
                sumS += t.spd;
                if (t.spd > maxS) maxS = t.spd;
                if (t.hr > 0) { sumH += t.hr; cntH++; if (t.hr > maxH) maxH = t.hr; }
                if (t.cad > 0) { sumC += t.cad; cntC++; if (t.cad > maxC) maxC = t.cad; }
                if (i > 0) {
                    const diff = t.alt - slice[i - 1].alt;
                    if (diff > 0) ascent += diff;
                    else if (diff < 0) descent += Math.abs(diff);
                }
                if (t.pwr <= pwrBounds[0]) pwrZones5[0] += 1000;
                else if (t.pwr <= pwrBounds[1]) pwrZones5[1] += 1000;
                else if (t.pwr <= pwrBounds[2]) pwrZones5[2] += 1000;
                else if (t.pwr <= pwrBounds[3]) pwrZones5[3] += 1000;
                else pwrZones5[4] += 1000;

                if (t.hr <= hrBounds[0]) hrZones5[0] += 1000;
                else if (t.hr <= hrBounds[1]) hrZones5[1] += 1000;
                else if (t.hr <= hrBounds[2]) hrZones5[2] += 1000;
                else if (t.hr <= hrBounds[3]) hrZones5[3] += 1000;
                else hrZones5[4] += 1000;
            }
            const n = slice.length || 1;
            const durS = Math.max(1, Math.round((slice[slice.length - 1].ts - slice[0].ts) / 1000));
            const distM = Math.max(0, slice[slice.length - 1].dist - slice[0].dist);
            const workJ = Math.round((sumP / n) * durS);
            const kcal = Math.round(workJ / 1000);

            return {
                durS,
                distCm: Math.round(distM * 100),
 cycles: Math.max(0, slice[slice.length - 1].cycles - slice[0].cycles),
 avgSpdMm: Math.round((distM / durS) * 1000),
 maxSpdMm: Math.round(maxS * 1000),
 avgHr: cntH ? Math.round(sumH / cntH) : 0,
 maxHr: maxH,
 avgCad: cntC ? Math.round(sumC / cntC) : 0,
 maxCad: maxC,
 avgPwr: Math.round(sumP / n),
 maxPwr: maxP,
 ascentM: Math.round(ascent),
 descentM: Math.round(descent),
 workJ,
 kcal,
 pwrZones5,
 hrZones5
            };
        }

        // 6. Laps (Global Msg 19)
        msgs.push(defMsg(2, 19, [
            [253, 4, 0x86], [2, 4, 0x86], [7, 4, 0x86], [8, 4, 0x86],
            [9, 4, 0x86], [10, 4, 0x86], [42, 4, 0x86], [11, 2, 0x84],
            [13, 2, 0x84], [14, 2, 0x84], [19, 2, 0x84], [20, 2, 0x84],
            [21, 2, 0x84], [22, 2, 0x84], [0, 1, 0x00], [1, 1, 0x00],
            [15, 1, 0x02], [16, 1, 0x02], [17, 1, 0x02], [18, 1, 0x02],
            [25, 1, 0x00], [26, 1, 0x00]
        ]));

        const lapTimestamps = events.filter(e => e.type === 'lap').map(e => e.timestamp);
        lapTimestamps.push(endTimeMs + 1);

        let lapStartIdx = 0;
        let validLapCount = 0;
        for (const lapTs of lapTimestamps) {
            let lapEndIdx = ticks.findIndex((t, i) => i >= lapStartIdx && t.ts >= lapTs);
            if (lapEndIdx === -1) lapEndIdx = ticks.length;
            const slice = ticks.slice(lapStartIdx, lapEndIdx);
            if (slice.length > 0) {
                validLapCount++;
                const st = calcSliceStats(slice);
                msgs.push(dataMsg(2, [
                    u32(slice[slice.length - 1].fitTs),
                                  u32(slice[0].fitTs),
                                  u32(st.durS * 1000),
                                  u32(st.durS * 1000),
                                  u32(st.distCm),
                                  u32(st.cycles),
                                  u32(st.workJ),
                                  u16(st.kcal),
                                  u16(st.avgSpdMm),
                                  u16(st.maxSpdMm),
                                  u16(st.avgPwr),
                                  u16(st.maxPwr),
                                  u16(st.ascentM),
                                  u16(st.descentM),
                                  u8(9),
                                  u8(1),
                                  u8(st.avgHr),
                                  u8(st.maxHr),
                                  u8(st.avgCad),
                                  u8(st.maxCad),
                                  u8(2),
                                  u8(subSportId)
                ]));
            }
            lapStartIdx = lapEndIdx;
        }

        // 7. Session (Global Msg 18)
        const tot = calcSliceStats(ticks);
        const finalAscent = pageSummary.climbM ?? tot.ascentM;
        const finalCalories = pageSummary.calories ?? tot.kcal;
        const finalNP = pageSummary.weightedPwr ?? tot.avgPwr;
        const intensityFactor = finalNP / userFtp;
        const calcTss = ((tot.durS * finalNP * intensityFactor) / (userFtp * 3600)) * 100;
        const finalTssScaled = Math.round((pageSummary.effortTss ?? calcTss) * 10);
        const finalIfScaled = Math.round(intensityFactor * 1000);

        msgs.push(defMsg(3, 18, [
            [253, 4, 0x86], [2, 4, 0x86], [7, 4, 0x86], [8, 4, 0x86],
            [9, 4, 0x86], [10, 4, 0x86], [48, 4, 0x86], [65, 20, 0x86],
            [11, 2, 0x84], [14, 2, 0x84], [15, 2, 0x84], [20, 2, 0x84],
            [21, 2, 0x84], [22, 2, 0x84], [23, 2, 0x84], [25, 2, 0x84],
            [26, 2, 0x84], [34, 2, 0x84], [35, 2, 0x84], [36, 2, 0x84],
            [38, 2, 0x84], [0, 1, 0x00], [1, 1, 0x00], [5, 1, 0x00],
            [6, 1, 0x00], [16, 1, 0x02], [17, 1, 0x02], [18, 1, 0x02],
            [19, 1, 0x02]
        ]));

        msgs.push(dataMsg(3, [
            u32(ticks[ticks.length - 1].fitTs),
                          u32(ticks[0].fitTs),
                          u32(tot.durS * 1000),
                          u32(tot.durS * 1000),
                          u32(ticks[ticks.length - 1].dist * 100),
                          u32(ticks[ticks.length - 1].cycles),
                          u32(tot.workJ),
                          u32Arr(tot.pwrZones5),
                          u16(finalCalories),
                          u16(tot.avgSpdMm),
                          u16(tot.maxSpdMm),
                          u16(tot.avgPwr),
                          u16(tot.maxPwr),
                          u16(finalAscent),
                          u16(tot.descentM),
                          u16(0),
                          u16(validLapCount),
                          u16(finalNP),
                          u16(finalTssScaled),
                          u16(finalIfScaled),
                          u16(userFtp),
                          u8(9),
                          u8(1),
                          u8(2),
                          u8(subSportId),
                          u8(tot.avgHr),
                          u8(tot.maxHr),
                          u8(tot.avgCad),
                          u8(tot.maxCad)
        ]));

        // 8. Suunto TimeInZone (Global Msg 216)
        msgs.push(defMsg(5, 216, [
            [253, 4, 0x86], [2, 20, 0x86], [5, 20, 0x86], [0, 2, 0x84],
            [1, 2, 0x84], [9, 10, 0x84], [11, 2, 0x84], [6, 5, 0x02],
            [8, 1, 0x02], [10, 1, 0x02]
        ]));
        msgs.push(dataMsg(5, [
            u32(ticks[ticks.length - 1].fitTs),
                          u32Arr(tot.hrZones5),
                          u32Arr(tot.pwrZones5),
                          u16(18),
                          u16(0),
                          u16Arr(pwrBounds),
                          u16(userFtp),
                          u8Arr(hrBounds),
                          u8(190),
                          u8(173)
        ]));

        // 9. Activity (Global Msg 34)
        msgs.push(defMsg(4, 34, [
            [253, 4, 0x86], [0, 4, 0x86], [1, 2, 0x84],
            [2, 1, 0x00], [3, 1, 0x00], [4, 1, 0x00]
        ]));
        msgs.push(dataMsg(4, [
            u32(ticks[ticks.length - 1].fitTs),
                          u32(tot.durS * 1000),
                          u16(1),
                          u8(0), u8(26), u8(1)
        ]));

        const totalDataLen = msgs.reduce((s, m) => s + m.length, 0);
        const buf = new Uint8Array(12 + totalDataLen + 2);
        const dv = new DataView(buf.buffer);
        buf[0] = 12; buf[1] = 0x10; dv.setUint16(2, 2132, true); dv.setUint32(4, totalDataLen, true);
        buf[8] = 0x2E; buf[9] = 0x46; buf[10] = 0x49; buf[11] = 0x54;
        let pos = 12;
        for (const m of msgs) { buf.set(m, pos); pos += m.length; }
        dv.setUint16(pos, fitCRC(buf, 0, pos), true);
        return buf;
    }

    function fitCRC(data, start, end) {
        const T = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
        let crc = 0;
        for (let i = start; i < end; i++) {
            const byte = data[i];
            let tmp = T[crc & 0x0F]; crc = (crc >> 4) & 0x0FFF; crc ^= tmp ^ T[byte & 0x0F];
            tmp = T[crc & 0x0F]; crc = (crc >> 4) & 0x0FFF; crc ^= tmp ^ T[(byte >> 4) & 0x0F];
        }
        return crc;
    }

    function scrapePageSummary() {
        const summary = {};
        const labels = document.querySelectorAll('.row-label');
        labels.forEach(lbl => {
            const text = lbl.textContent.trim().toLowerCase();
            const valText = lbl.nextElementSibling?.textContent || '';
            if (text === 'climb') summary.climbM = parseInt(valText, 10) || undefined;
            if (text === 'calories') summary.calories = parseInt(valText, 10) || undefined;
            if (text === 'weighted power') summary.weightedPwr = parseInt(valText, 10) || undefined;
            if (text === 'effort') summary.effortTss = parseFloat(valText) || undefined;
        });
            return summary;
    }

    // --- 2. UPLOAD VIA RUNALYZE ---
    async function handleSuuntoUpload(btn) {
        const labelSpan = btn.querySelector('.suunto-btn-label');
        const errBox = document.querySelector('.export-error');
        if (errBox) errBox.textContent = '';

        if (!(await terra.settings.has('runalyze_cookie'))) {
            if (errBox) errBox.textContent = 'Add your Runalyze Cookie in Terra settings first.';
            terra.settings.open();
            return;
        }

        const match = window.location.pathname.match(/\/activities\/(\d+)/);
        if (!match) return;
        const activityId = match[1];

        const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0';

        try {
            btn.disabled = true;
            btn.dataset.state = 'loading';
            labelSpan.textContent = 'Fetching ride...';

            const res = await fetch(`https://biketerra.com/files/activity/${activityId}`, { credentials: 'include' });
            if (!res.ok) throw new Error(`Failed to fetch activity JSON (HTTP ${res.status})`);
            const activityJson = await res.json();

            labelSpan.textContent = 'Encoding FIT...';
            const pageSummary = scrapePageSummary();
            const activityName = getFormattedActivityName();
            const safeFilename = activityName.replace(/[\\/:*?"<>|]/g, '-') + '.fit';
            const fitBytes = encodeBiketerraJsonToFIT(activityJson, pageSummary, activityName, true);

            terra.log(`[Suunto Export] Encoding "${activityName}" (${fitBytes.byteLength} bytes)`);

            labelSpan.textContent = 'Connecting to Runalyze...';
            const pageRes = await terra.http.request({
                method: 'GET',
                url: 'https://runalyze.com/my/suunto/fit-upload',
                headers: {
                    'Cookie': '{{setting:runalyze_cookie}}',
                    'User-Agent': UA,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': 'https://runalyze.com/my/suunto/fit-upload'
                }
            });

            const doc = new DOMParser().parseFromString(pageRes.body || '', 'text/html');
            const fileInput = doc.querySelector('input[type="file"]');

            if (pageRes.status < 200 || pageRes.status >= 300 || !fileInput) {
                throw new Error(`Runalyze rejected GET (HTTP ${pageRes.status})`);
            }

            const fileFieldName = fileInput.getAttribute('name') || 'file';
            const extraFields = {};
            const formEl = fileInput.closest('form') || doc;
            formEl.querySelectorAll('input[type="hidden"]').forEach(inp => {
                const name = inp.getAttribute('name');
                const val = inp.getAttribute('value');
                if (name && val !== null) extraFields[name] = val;
            });

                labelSpan.textContent = 'Uploading to Suunto...';
                const uploadRes = await terra.http.request({
                    method: 'POST',
                    url: 'https://runalyze.com/my/suunto/fit-upload',
                    headers: {
                        'Cookie': '{{setting:runalyze_cookie}}',
                        'User-Agent': UA,
                        'Referer': 'https://runalyze.com/my/suunto/fit-upload',
                        'Origin': 'https://runalyze.com'
                    },
                    form: {
                        fields: extraFields,
                        file: {
                            field: fileFieldName,
                            filename: safeFilename,
                            contentType: 'application/octet-stream',
                            base64: b64(fitBytes)
                        }
                    }
                });

                const upDoc = new DOMParser().parseFromString(uploadRes.body || '', 'text/html');
                const alerts = Array.from(upDoc.querySelectorAll('.alert, .flash-message, .error, .c-alert'))
                .map(el => el.textContent.replace(/✕/g, '').trim())
                .filter(Boolean);

                terra.log(`[Suunto Export] POST status=${uploadRes.status}, alerts=${JSON.stringify(alerts)}`);

                const isSuccess = alerts.some(a => a.toLowerCase().includes('successfully uploaded'));

                if (uploadRes.status >= 200 && uploadRes.status < 400 && isSuccess) {
                    btn.dataset.state = 'done';
                    labelSpan.textContent = 'Uploaded to Suunto';
                    const svgSlot = btn.querySelector('.slot');
                    if (svgSlot) {
                        svgSlot.innerHTML = `<svg viewBox="0 0 24 24"><use href="#export-check"></use></svg>`;
                    }
                } else {
                    const errMsg = alerts.length > 0 ? alerts.join(' | ') : `Upload failed (HTTP ${uploadRes.status})`;
                    throw new Error(errMsg);
                }
        } catch (e) {
            btn.disabled = false;
            btn.dataset.state = 'idle';
            labelSpan.textContent = 'Upload to Suunto';
            if (errBox) errBox.textContent = e.message || String(e);
            terra.log('[Suunto Export] Error: ' + (e.message || e));
        }
    }

    // --- 3. UI INJECTION ---
    function injectSuuntoButton() {
        const container = document.querySelector('.export-buttons');
        if (!container || document.getElementById('terra-suunto-upload-btn')) return;

        const existingBtn = container.querySelector('button.xbtn');
        const svelteClass = existingBtn
        ? [...existingBtn.classList].find(c => c.startsWith('svelte-')) || ''
        : '';

        const btn = document.createElement('button');
        btn.id = 'terra-suunto-upload-btn';
        btn.type = 'button';
        btn.className = `xbtn brand-suunto ${svelteClass}`;
        btn.dataset.state = 'idle';

        btn.innerHTML = `
        <span class="slot ${svelteClass}">
        <svg viewBox="0 0 24 24" class="${svelteClass}" fill="none" stroke="#E11D48" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="12 2 19 21 12 17 5 21 12 2"></polygon>
        </svg>
        </span>
        <span class="suunto-btn-label ${svelteClass}">Upload to Suunto</span>
        `;

        btn.addEventListener('click', () => handleSuuntoUpload(btn));

        const downloadBtn = container.children[2];
        if (downloadBtn) {
            container.insertBefore(btn, downloadBtn);
        } else {
            container.appendChild(btn);
        }
    }

    const observer = new MutationObserver(() => injectSuuntoButton());
    observer.observe(document.body, { childList: true, subtree: true });
    injectSuuntoButton();

    if (typeof terra !== 'undefined' && terra.onCleanup) {
        terra.onCleanup(() => {
            observer.disconnect();
            document.getElementById('terra-suunto-upload-btn')?.remove();
        });
    }
})();
