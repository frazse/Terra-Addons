// FIT file encoder, unchanged from the userscript. Uses sportMode, routeName, lapList, lapStartIdx from logger.js.
function encodeFIT(ticks, startTime) {
  const FIT_EPOCH = 631065600; const toFT = d => Math.round(d.getTime() / 1000) - FIT_EPOCH; const toSC = deg => deg !== null ? Math.round(deg * 11930465) : 0x7FFFFFFF;
  const msgs = [];
  function defMsg(l, g, f) { const b = new Uint8Array(6 + f.length * 3); b[0] = 0x40 | l; b[3] = g & 0xFF; b[4] = (g >> 8) & 0xFF; b[5] = f.length; for (let i=0; i<f.length; i++) { b[6+i*3] = f[i][0]; b[7+i*3] = f[i][1]; b[8+i*3] = f[i][2]; } return b; }
  function dataMsg(l, vals) { const ab = new ArrayBuffer(1 + vals.reduce((s, v) => s + v.size, 0)); const dv = new DataView(ab); dv.setUint8(0, l & 0x0F); let o = 1; for (const v of vals) { if (v.size === 1) dv.setUint8(o, v.val); else if (v.size === 2) dv.setUint16(o, v.val, true); else if (v.size === 4) dv.setUint32(o, v.val, true); o += v.size; } return new Uint8Array(ab); }
  const u8 = val => ({ size: 1, val }), u16 = val => ({ size: 2, val: Math.min(65535, Math.max(0, Math.round(val))) }), u32 = val => ({ size: 4, val: Math.max(0, Math.round(val)) }), s32 = val => ({ size: 4, val: val < 0 ? val + 0x100000000 : val });
  msgs.push(defMsg(0, 0, [[0,2,0x84],[1,2,0x84],[2,2,0x84],[4,4,0x86]])); msgs.push(dataMsg(0, [u16(4), u16(255), u16(1), u32(toFT(startTime))]));
  msgs.push(defMsg(1, 20, [[253,4,0x86],[0,4,0x85],[1,4,0x85],[2,2,0x84],[3,1,0x02],[4,1,0x02],[5,4,0x86],[6,2,0x84],[7,2,0x84],[19,4,0x86],[73,4,0x86]]));
  for (const t of ticks) msgs.push(dataMsg(1, [u32(toFT(t.timestamp)), s32(toSC(t.lat)), s32(toSC(t.lng)), u16(t.alt !== null ? t.alt * 5 + 500 : 0xFFFF), u8(t.hr), u8(t.cadence), u32(t.dist * 100), u16(t.speed * 1000), u16(t.power), u32(t.count), u32(t.speed * 1000)]));
  const lastT = ticks[ticks.length - 1], maxP = Math.max(...ticks.map(t => t.power), 0), avgP = Math.round(ticks.reduce((s,t)=>s+t.power,0)/ticks.length);
  const hrT = ticks.filter(t=>t.hr>0); const avgH = hrT.length ? Math.round(hrT.reduce((s,t)=>s+t.hr,0)/hrT.length) : 0, maxH = Math.max(...ticks.map(t=>t.hr), 0);
  const fitSportId = sportMode === 'ROW' ? 15 : 2;
  msgs.push(defMsg(2, 19, [[253,4,0x86],[2,4,0x86],[7,4,0x86],[8,4,0x86],[9,4,0x86],[10,4,0x86],[15,1,0x02],[16,1,0x02],[19,2,0x84],[25,1,0x02],[26,1,0x02]]));
  const allLaps = [...lapList, { startIdx: lapStartIdx, endIdx: ticks.length, startTime: lapStartIdx === 0 ? startTime : ticks[lapStartIdx]?.timestamp || startTime, endTime: lastT.timestamp }];
  for (const lap of allLaps) {
    const slice = ticks.slice(lap.startIdx, lap.endIdx); if (slice.length < 1) continue;
    const lapDurS = Math.max(1, Math.round((lap.endTime - lap.startTime)/1000)); const lSliceHr = slice.filter(t => t.hr > 0); const lAvgH = lSliceHr.length ? Math.round(lSliceHr.reduce((s,t)=>s+t.hr,0)/lSliceHr.length) : 0;
    const lMaxH = Math.max(...slice.map(t=>t.hr), 0); const lAvgP = Math.round(slice.reduce((s,t)=>s+t.power,0)/slice.length); const lapDist = Math.round((slice[slice.length-1].dist - slice[0].dist) * 100); const lapCount = slice[slice.length-1].count - slice[0].count;
    msgs.push(dataMsg(2, [u32(toFT(lap.endTime)), u32(toFT(lap.startTime)), u32(lapDurS*1000), u32(lapDurS*1000), u32(lapDist), u32(lapCount > 0 ? lapCount : 0), u8(lAvgH), u8(lMaxH), u16(lAvgP), u8(fitSportId), u8(58)]));
  }
  const durS = Math.round((lastT.timestamp - startTime)/1000);
  msgs.push(defMsg(3, 18, [[253,4,0x86],[0,2,0x84],[1,1,0x02],[2,4,0x86],[5,1,0x02],[6,1,0x02],[7,4,0x86],[8,4,0x86],[9,4,0x86],[11,4,0x86],[14,1,0x02],[15,1,0x02],[20,2,0x84],[21,2,0x84],[25,2,0x84]]));
  msgs.push(dataMsg(3, [u32(toFT(lastT.timestamp)), u16(8), u8(1), u32(toFT(startTime)), u8(fitSportId), u8(58), u32(durS*1000), u32(durS*1000), u32(lastT.dist*100), u32(lastT.count), u8(avgH), u8(maxH), u16(avgP), u16(maxP), u16(allLaps.length)]));
  msgs.push(defMsg(4, 34, [[253,4,0x86],[0,4,0x86],[1,2,0x84],[2,1,0x02],[3,1,0x02],[4,1,0x02]])); msgs.push(dataMsg(4, [u32(toFT(lastT.timestamp)), u32(durS*1000), u16(1), u8(0), u8(26), u8(1)]));
  const activityNameStr = (routeName ? (sportMode === 'ROW' ? 'Rowterra' : 'Biketerra') + ' - ' + routeName : 'Virtual Workout').slice(0, 15); const nameEnc = new TextEncoder().encode(activityNameStr + '\0');
  msgs.push(defMsg(5, 26, [[254, 2, 0x84], [8, nameEnc.length, 0x07]])); const wDat = new ArrayBuffer(1 + 2 + nameEnc.length); const wDv = new DataView(wDat); wDv.setUint8(0, 5); wDv.setUint16(1, 0, true); for(let i=0; i<nameEnc.length; i++) wDv.setUint8(3+i, nameEnc[i]); msgs.push(new Uint8Array(wDat));
  const totalDataLen = msgs.reduce((s, m) => s + m.length, 0); const buf = new Uint8Array(12 + totalDataLen + 2); const dv = new DataView(buf.buffer); buf[0] = 12; buf[1] = 0x10; dv.setUint16(2, 2132, true); dv.setUint32(4, totalDataLen, true); buf[8] = 0x2E; buf[9] = 0x46; buf[10] = 0x49; buf[11] = 0x54; let pos = 12; for (const m of msgs) { buf.set(m, pos); pos += m.length; } dv.setUint16(pos, fitCRC(buf, 0, pos), true); return buf;
}
function fitCRC(data, start, end) { const T = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400]; let crc = 0; for (let i = start; i < end; i++) { const byte = data[i]; let tmp = T[crc & 0x0F]; crc = (crc >> 4) & 0x0FFF; crc ^= tmp ^ T[byte & 0x0F]; tmp = T[crc & 0x0F]; crc = (crc >> 4) & 0x0FFF; crc ^= tmp ^ T[(byte >> 4) & 0x0F]; } return crc; }
