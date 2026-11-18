/* Voice Chat (Whisper) — Push-to-Talk (Zwift Ride / hotkey) and Hands-Free
 * voice-command dictation for Biketerra chat using a local faster-whisper
 * Wyoming TCP server (e.g. linuxserver/faster-whisper on Unraid).
 */
'use strict';

(async () => {
  const log = (...a) => {
    try { terra.log(...a); } catch { try { console.log('[voice-chat]', ...a); } catch {} }
  };

  if (window.__terraVoiceChatCleanup) {
    try { window.__terraVoiceChatCleanup(); } catch {}
  }

  const STORAGE_MODE_KEY = 'voiceChatModeV1';
  const STORAGE_ARMED_KEY = 'voiceChatArmedV1';
  const STORAGE_POS_KEY = 'voiceChatHudPosV1';

  const DEFAULTS = {
    host: '',
    port: 10300,
    language: 'en',
    mode: 'ptt',
    wakePhrases: 'hey chat, chat, send message',
    pttKey: 'KeyV',
    chatToggleKey: 'KeyT',
    sendBehavior: 'countdown',
    handsFreeSendBehavior: 'voice',
    browserAudioProcessing: false,
    autoGainBoost: true,
    silenceMs: 1200,
    vadSensitivity: 5,
    maxClipSec: 20,
    hudOpacity: 88,
  };

  let S = { ...DEFAULTS };
  let cleaned = false;

  const clamp = (v, lo, hi, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  const clampInt = (v, lo, hi, fallback) => Math.round(clamp(v, lo, hi, fallback));

  try { S = { ...DEFAULTS, ...(await terra.settings.all()) }; } catch {}

  /* ── 1. Pure Helpers (Resampling, Pre-Roll, Wyoming Wire, Wake Words) ─────── */
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder('utf-8');

  class Resampler16k {
    constructor(inRate, outRate = 16000) {
      this.inRate = Math.max(1000, Number(inRate) || 48000);
      this.outRate = outRate;
      this.step = this.inRate / this.outRate;
      this.tail = new Float32Array(0);
      this.pos = 0;
    }

    push(chunk) {
      if (!chunk || !chunk.length) return new Uint8Array(0);
      const buf = new Float32Array(this.tail.length + chunk.length);
      buf.set(this.tail, 0);
      buf.set(chunk, this.tail.length);

      const n = buf.length;
      if (n < 2) {
        this.tail = buf;
        return new Uint8Array(0);
      }

      const maxOut = Math.floor((n - 1 - this.pos) / this.step) + 1;
      if (maxOut <= 0) {
        this.tail = buf;
        return new Uint8Array(0);
      }

      const out = new Uint8Array(maxOut * 2);
      const dv = new DataView(out.buffer);
      let outCount = 0;
      let pos = this.pos;

      while (this.step >= 1.5 ? (pos + this.step <= n) : (pos <= n - 1.000001)) {
        let sample = 0;
        if (this.step >= 1.5) {
          const lo = Math.max(0, Math.floor(pos));
          const hi = Math.min(n - 1, Math.floor(pos + this.step - 1e-6));
          let sum = 0;
          let cnt = 0;
          for (let i = lo; i <= hi; i++) {
            sum += buf[i];
            cnt++;
          }
          sample = cnt > 0 ? sum / cnt : buf[lo];
        } else {
          const idx = Math.floor(pos);
          const frac = pos - idx;
          const s0 = buf[idx];
          const s1 = idx + 1 < n ? buf[idx + 1] : s0;
          sample = s0 + (s1 - s0) * frac;
        }
        const clamped = Math.max(-1, Math.min(1, sample));
        const pcm = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
        dv.setInt16(outCount * 2, Math.max(-32768, Math.min(32767, pcm)), true);
        outCount++;
        pos += this.step;
      }

      const drop = Math.min(n - 1, Math.floor(pos));
      this.tail = buf.slice(drop);
      this.pos = pos - drop;
      return outCount === maxOut ? out : out.subarray(0, outCount * 2);
    }

    reset() {
      this.tail = new Float32Array(0);
      this.pos = 0;
    }
  }

  class ByteRingBuffer {
    constructor(capacityBytes) {
      this.cap = Math.max(2, capacityBytes | 0);
      this.buf = new Uint8Array(this.cap);
      this.writePos = 0;
      this.len = 0;
    }

    push(bytes) {
      if (!bytes || !bytes.length) return;
      if (bytes.length >= this.cap) {
        const tail = bytes.subarray(bytes.length - this.cap);
        this.buf.set(tail, 0);
        this.writePos = 0;
        this.len = this.cap;
        return;
      }
      const first = Math.min(bytes.length, this.cap - this.writePos);
      this.buf.set(bytes.subarray(0, first), this.writePos);
      if (first < bytes.length) {
        this.buf.set(bytes.subarray(first), 0);
      }
      this.writePos = (this.writePos + bytes.length) % this.cap;
      this.len = Math.min(this.cap, this.len + bytes.length);
    }

    drain(maxBytes = this.len) {
      const take = Math.min(this.len, Math.max(0, maxBytes | 0));
      const evenTake = take - (take & 1);
      if (evenTake <= 0) return new Uint8Array(0);
      const out = new Uint8Array(evenTake);
      const start = (this.writePos - evenTake + this.cap) % this.cap;
      const first = Math.min(evenTake, this.cap - start);
      out.set(this.buf.subarray(start, start + first), 0);
      if (first < evenTake) {
        out.set(this.buf.subarray(0, evenTake - first), first);
      }
      this.len = 0;
      this.writePos = 0;
      return out;
    }

    clear() {
      this.len = 0;
      this.writePos = 0;
    }
  }

  function concatBytes(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  function encodeWyomingEvent(type, data = null, payload = null) {
    const header = { type };
    if (data && Object.keys(data).length > 0) header.data = data;
    if (payload && payload.length > 0) header.payload_length = payload.length;
    const headBytes = textEncoder.encode(JSON.stringify(header) + '\n');
    if (!payload || !payload.length) return headBytes;
    const out = new Uint8Array(headBytes.length + payload.length);
    out.set(headBytes, 0);
    out.set(payload, headBytes.length);
    return out;
  }

  class WyomingDecoder {
    constructor() {
      this.buf = new Uint8Array(0);
      this.stage = 'header'; // 'header' | 'data' | 'payload'
      this.curHeader = null;
      this.curData = null;
      this.dataLen = 0;
      this.payloadLen = 0;
    }

    push(chunk) {
      if (chunk && chunk.length) {
        const next = new Uint8Array(this.buf.length + chunk.length);
        next.set(this.buf, 0);
        next.set(chunk, this.buf.length);
        this.buf = next;
      }
      const events = [];
      while (true) {
        if (this.stage === 'header') {
          const nl = this.buf.indexOf(0x0a);
          if (nl < 0) break;
          const lineBytes = this.buf.subarray(0, nl);
          this.buf = this.buf.slice(nl + 1);
          const line = textDecoder.decode(lineBytes).trim();
          if (!line) continue;
          const header = JSON.parse(line);
          this.curHeader = header;
          this.curData = { ...(header.data || {}) };
          this.dataLen = Math.max(0, Number(header.data_length) || 0);
          this.payloadLen = Math.max(0, Number(header.payload_length) || 0);
          this.stage = this.dataLen > 0 ? 'data' : (this.payloadLen > 0 ? 'payload' : 'emit');
        }
        if (this.stage === 'data') {
          if (this.buf.length < this.dataLen) break;
          const dataBytes = this.buf.subarray(0, this.dataLen);
          this.buf = this.buf.slice(this.dataLen);
          const extraText = textDecoder.decode(dataBytes).trim();
          if (extraText) Object.assign(this.curData, JSON.parse(extraText));
          this.stage = this.payloadLen > 0 ? 'payload' : 'emit';
        }
        if (this.stage === 'payload') {
          if (this.buf.length < this.payloadLen) break;
          const payload = this.buf.slice(0, this.payloadLen);
          this.buf = this.buf.slice(this.payloadLen);
          events.push({ type: this.curHeader.type, data: this.curData, payload });
          this.stage = 'header';
          continue;
        }
        if (this.stage === 'emit') {
          events.push({ type: this.curHeader.type, data: this.curData, payload: new Uint8Array(0) });
          this.stage = 'header';
        }
      }
      return events;
    }
  }

  function parseWakePhrases(str) {
    return String(str || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function extractWakeMessage(rawText, phrases) {
    const trimmed = String(rawText || '').trim();
    if (!trimmed) return { matched: false, message: '' };
    const cleanLead = trimmed.replace(/^[\s"'`.,:;!?-]+/, '');
    for (const phrase of phrases) {
      const words = phrase.split(/\s+/).filter(Boolean).map(escapeRegex);
      if (!words.length) continue;
      const re = new RegExp('^' + words.join('[\\s,.:;-]+') + '(?=$|[\\s,.:;!?-]+)(.*)$', 'i');
      const m = cleanLead.match(re);
      if (m) {
        let rest = (m[1] || '').replace(/^[\s,.:;!?-]+/, '').trim();
        if (rest) {
          rest = rest.charAt(0).toUpperCase() + rest.slice(1);
        }
        return { matched: true, phrase, message: rest };
      }
    }
    return { matched: false, message: '' };
  }

  function isWhisperNoiseArtifact(rawText, handsFree) {
    const t = String(rawText || '').trim();
    if (!t) return true;
    if (/^(\[.*\]|\(.*\)|\*.*\*)$/.test(t)) return true;
    const norm = t.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    if (!norm) return true;
    if (handsFree) {
      if (norm.length < 2) return true;
      if ([
        'thank you',
        'thanks for watching',
        'thank you for watching',
        'bye',
        'you',
        'mbc',
        'subtitles by the amara org community',
      ].includes(norm)) {
        return true;
      }
    }
    return false;
  }

  function normalizeVoiceCmd(rawText) {
    return String(rawText || '')
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isSendVoiceCommand(rawText) {
    const norm = normalizeVoiceCmd(rawText);
    return [
      'send',
      'sent',
      'send it',
      'send that',
      'send message',
      'yes',
      'yes send',
      'yes please',
      'confirm',
      'post',
      'post it',
      'go ahead',
      'submit',
      'ok',
      'okay',
      'ok send',
      'okay send',
      'do it',
      'ship it',
    ].includes(norm);
  }

  function isCancelVoiceCommand(rawText) {
    const norm = normalizeVoiceCmd(rawText);
    return [
      'cancel',
      'canceled',
      'cancelled',
      'never mind',
      'nevermind',
      'scratch that',
      'clear',
      'delete',
      'abort',
      'discard',
      'nope',
      'no',
      'no cancel',
      'no thanks',
      'stop',
      'reject',
      'trash',
    ].includes(norm);
  }

  function normalizeQuietPcm16(pcmBytes, targetPeak = 18000, maxGain = 4) {
    if (!pcmBytes || pcmBytes.length < 2) return pcmBytes;
    const sampleCount = pcmBytes.length >> 1;
    const dvIn = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, sampleCount * 2);
    let maxAbs = 0;
    for (let i = 0; i < sampleCount; i++) {
      const a = Math.abs(dvIn.getInt16(i * 2, true));
      if (a > maxAbs) maxAbs = a;
    }
    if (maxAbs <= 0 || maxAbs >= 10000) return pcmBytes;
    const gain = Math.min(maxGain, targetPeak / maxAbs);
    if (gain <= 1.08) return pcmBytes;

    const out = new Uint8Array(sampleCount * 2);
    const dvOut = new DataView(out.buffer);
    for (let i = 0; i < sampleCount; i++) {
      const scaled = Math.round(dvIn.getInt16(i * 2, true) * gain);
      dvOut.setInt16(i * 2, Math.max(-32768, Math.min(32767, scaled)), true);
    }
    return out;
  }

  function exportHelpersForTests() {
    return {
      Resampler16k,
      ByteRingBuffer,
      encodeWyomingEvent,
      WyomingDecoder,
      parseWakePhrases,
      extractWakeMessage,
      isWhisperNoiseArtifact,
      isSendVoiceCommand,
      isCancelVoiceCommand,
      normalizeQuietPcm16,
      ensureChatInput: () => ensureChatInput(),
      postToBiketerraChat: (text, auto) => postToBiketerraChat(text, auto),
      handleTranscribedText: (rawText, fromHandsFree) => handleTranscribedText(rawText, fromHandsFree),
      getPendingDraft: () => (pendingToast ? { text: pendingToast.text, kind: pendingToast.kind } : null),
    };
  }
  window.__terraVoiceChatHelpers = exportHelpersForTests;

  /* ── 2. Wyoming TCP Client ────────────────────────────────────────────────── */
  const activeConns = new Map();
  let unsubTcpFrame = null;
  let unsubTcpState = null;

  function ensureTcpListeners() {
    if (!unsubTcpFrame && terra.tcp && terra.tcp.onFrame) {
      unsubTcpFrame = terra.tcp.onFrame(({ conn, bytes }) => {
        const entry = activeConns.get(conn);
        if (!entry) return;
        const u8 = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        entry.onBytes(u8);
      });
    }
    if (!unsubTcpState && terra.tcp && terra.tcp.onState) {
      unsubTcpState = terra.tcp.onState((ev) => {
        const entry = activeConns.get(ev.conn);
        if (!entry) return;
        entry.onState(ev);
      });
    }
  }

  async function transcribePcmWithWyoming(pcmBytes) {
    const hostVal = String(S.host || '').trim();
    if (!hostVal) {
      const err = new Error('Set Whisper server IP in Settings');
      err.needsConfig = true;
      throw err;
    }
    const port = clampInt(S.port, 1, 65535, 10300);
    const lang = String(S.language || '').trim().toLowerCase();

    ensureTcpListeners();

    const conn = await terra.tcp.connect('{{setting:host}}', port, 4500);
    const decoder = new WyomingDecoder();
    let settled = false;
    let timeoutId = 0;

    return await new Promise((resolve, reject) => {
      const finish = (ok, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        activeConns.delete(conn);
        try { terra.tcp.close(conn).catch(() => {}); } catch {}
        if (ok) resolve(val);
        else reject(val);
      };

      timeoutId = setTimeout(() => {
        finish(false, new Error('Whisper transcription timed out'));
      }, 25000);

      activeConns.set(conn, {
        onBytes: (u8) => {
          try {
            const events = decoder.push(u8);
            for (const ev of events) {
              if (ev.type === 'transcript') {
                finish(true, String((ev.data && ev.data.text) || '').trim());
                return;
              }
              if (ev.type === 'error') {
                const msg = (ev.data && (ev.data.text || ev.data.message)) || 'Whisper server error';
                finish(false, new Error(msg));
                return;
              }
            }
          } catch (e) {
            finish(false, e);
          }
        },
        onState: (ev) => {
          if (ev.state === 'error') {
            finish(false, new Error(ev.reason || 'Whisper TCP error'));
          } else if (ev.state === 'closed') {
            finish(false, new Error('Whisper server closed connection before transcript'));
          }
        },
      });

      (async () => {
        try {
          const transcribeData = lang && lang !== 'auto' ? { language: lang } : null;
          await terra.tcp.send(conn, encodeWyomingEvent('transcribe', transcribeData));
          await terra.tcp.send(conn, encodeWyomingEvent('audio-start', { rate: 16000, width: 2, channels: 1 }));

          const CHUNK_BYTES = 8192; // 256 ms @ 16kHz 16-bit mono
          for (let off = 0; off < pcmBytes.length; off += CHUNK_BYTES) {
            if (settled || cleaned) return;
            const slice = pcmBytes.subarray(off, Math.min(pcmBytes.length, off + CHUNK_BYTES));
            const pkt = encodeWyomingEvent('audio-chunk', { rate: 16000, width: 2, channels: 1 }, slice);
            await terra.tcp.send(conn, pkt);
          }

          await terra.tcp.send(conn, encodeWyomingEvent('audio-stop'));
        } catch (e) {
          finish(false, e);
        }
      })();
    });
  }

  /* ── 3. Biketerra Chat DOM Injection ──────────────────────────────────────── */
  function isAddonElement(el) {
    return !!(
      el &&
      el.closest &&
      el.closest('#tvc-hud, #terra-overlay, #terra-btn, #btz-panel, #btz-console-hud, .tr-gr-card')
    );
  }

  function queryAllDeep(selector, root = document) {
    const out = [];
    if (!root || typeof root.querySelectorAll !== 'function') return out;
    for (const el of root.querySelectorAll(selector)) out.push(el);
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) {
        for (const sub of queryAllDeep(selector, host.shadowRoot)) out.push(sub);
      }
    }
    return out;
  }

  function isElementVisible(el, minW = 16, minH = 12) {
    if (!el || el.disabled || el.getAttribute?.('aria-hidden') === 'true') return false;
    const r = el.getBoundingClientRect();
    if (r.width < minW || r.height < minH) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return false;
    return true;
  }

  function isTextEntryElement(el) {
    if (!el || isAddonElement(el)) return false;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName === 'INPUT') {
      return /^(text|search|)$/i.test(el.type || 'text');
    }
    return !!(el.isContentEditable || el.getAttribute?.('contenteditable') === 'true' || el.getAttribute?.('contenteditable') === '');
  }

  function attrString(el) {
    return [
      el.placeholder,
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('title'),
      el.name,
      el.id,
      typeof el.className === 'string' ? el.className : '',
    ].filter(Boolean).join(' ').toLowerCase();
  }

  function scoreChatInput(el) {
    if (!isTextEntryElement(el) || !isElementVisible(el, 16, 12)) return -1;

    const attrs = attrString(el);
    let parentCtx = '';
    let p = el.parentElement;
    for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
      parentCtx += ' ' + (p.id || '') + ' ' + (typeof p.className === 'string' ? p.className : '') + ' ' + (p.getAttribute?.('aria-label') || '');
    }
    parentCtx = parentCtx.toLowerCase();

    let score = 1;
    if (/chat|message|say|reply|whisper|msg/.test(attrs)) score += 10;
    if (/chat|message|msg/.test(parentCtx)) score += 6;
    if (document.activeElement === el) score += 4;
    if (/search|filter|route|title|email|password/.test(attrs)) score -= 8;
    return score;
  }

  function findChatInput() {
    const active = document.activeElement;
    if (scoreChatInput(active) >= 4) return active;

    let best = null;
    let bestScore = 0;
    for (const el of queryAllDeep('input, textarea, [contenteditable]')) {
      const sc = scoreChatInput(el);
      if (sc > bestScore) {
        bestScore = sc;
        best = el;
      }
    }
    return best;
  }

  function findChatContainer() {
    let best = null;
    let bestScore = 0;
    for (const el of queryAllDeep('[id*="chat" i], [class*="chat" i], [aria-label*="chat" i]')) {
      if (isAddonElement(el) || !isElementVisible(el, 60, 20)) continue;
      if (el.tagName === 'BUTTON' || el.tagName === 'A') continue;
      const r = el.getBoundingClientRect();
      let sc = 2;
      if (el.querySelector?.('input, textarea, [contenteditable]')) sc += 8;
      if (r.height >= 40 && r.height <= window.innerHeight * 0.7) sc += 3;
      if (sc > bestScore) {
        bestScore = sc;
        best = el;
      }
    }
    return best;
  }

  function findChatToggleButton() {
    for (const btn of queryAllDeep('button, [role="button"]')) {
      if (isAddonElement(btn) || !isElementVisible(btn, 16, 16)) continue;
      const meta = (attrString(btn) + ' ' + (btn.textContent || '')).toLowerCase();
      if (/\bchat\b/.test(meta)) return btn;
    }
    return null;
  }

  function simulateRealClick(el) {
    if (!el) return;
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const mouseOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window };
    try {
      if (typeof PointerEvent === 'function') {
        el.dispatchEvent(new PointerEvent('pointerdown', { ...mouseOpts, pointerId: 1, isPrimary: true }));
      }
      el.dispatchEvent(new MouseEvent('mousedown', mouseOpts));
      if (typeof PointerEvent === 'function') {
        el.dispatchEvent(new PointerEvent('pointerup', { ...mouseOpts, pointerId: 1, isPrimary: true }));
      }
      el.dispatchEvent(new MouseEvent('mouseup', mouseOpts));
      el.dispatchEvent(new MouseEvent('click', mouseOpts));
    } catch {
      try { el.click && el.click(); } catch {}
    }
    try { el.focus({ preventScroll: true }); } catch { try { el.focus && el.focus(); } catch {} }
  }

  function keyCodeForCode(code) {
    if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
    if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
    if (code === 'Enter') return 13;
    if (code === 'Space') return 32;
    return 0;
  }

  function dispatchToggleChatKey() {
    const code = String(S.chatToggleKey || 'KeyT').trim() || 'KeyT';
    let key = code;
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3).toLowerCase();
    else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
    const kc = keyCodeForCode(code);

    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) {
      try { active.blur(); } catch {}
    }
    const opts = { key, code, keyCode: kc, which: kc, bubbles: true, cancelable: true };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function logChatDomDiagnostics() {
    try {
      const inputs = queryAllDeep('input, textarea, [contenteditable]')
        .filter((e) => !isAddonElement(e))
        .slice(0, 8)
        .map((e) => `${e.tagName.toLowerCase()}#${e.id || ''}.${String(e.className || '').trim()}(${e.placeholder || e.getAttribute?.('aria-label') || ''})`);
      const chats = queryAllDeep('[id*="chat" i], [class*="chat" i]')
        .filter((e) => !isAddonElement(e))
        .slice(0, 8)
        .map((e) => `${e.tagName.toLowerCase()}#${e.id || ''}.${String(e.className || '').trim()}`);
      log('chat DOM diag:', { inputs, chats, active: document.activeElement?.tagName });
    } catch {}
  }

  async function tryActivateChatContainer(box) {
    if (!box) return null;
    const clickable =
      box.querySelector?.('input, textarea, [contenteditable], [role="textbox"]') ||
      box.querySelector?.('[class*="input" i], [class*="compose" i], [class*="entry" i], button') ||
      box;
    simulateRealClick(clickable);
    await new Promise((r) => setTimeout(r, 60));
    const active = document.activeElement;
    if (isTextEntryElement(active) && isElementVisible(active, 16, 12)) return active;
    return findChatInput();
  }

  async function ensureChatInput() {
    let el = findChatInput();
    if (el) {
      simulateRealClick(el);
      return { el, openedByUs: false };
    }

    // If the chat box is already displayed (so pressing T would hide it), click into it first
    const existingBox = findChatContainer();
    if (existingBox) {
      el = await tryActivateChatContainer(existingBox);
      if (el) return { el, openedByUs: false };
    }

    // Toggle chat open via Biketerra hotkey (default: T)
    dispatchToggleChatKey();
    const deadline = performance.now() + 500;
    let clickedContainer = false;
    while (performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 35));
      if (cleaned) return null;
      const active = document.activeElement;
      if (isTextEntryElement(active) && isElementVisible(active, 16, 12)) {
        return { el: active, openedByUs: true };
      }
      el = findChatInput();
      if (el) {
        simulateRealClick(el);
        return { el, openedByUs: true };
      }
      if (!clickedContainer) {
        const box = findChatContainer();
        if (box) {
          clickedContainer = true;
          el = await tryActivateChatContainer(box);
          if (el) return { el, openedByUs: true };
        }
      }
    }

    // Fallback: click a visible chat button if hotkey didn't open it
    const btn = findChatToggleButton();
    if (btn) {
      simulateRealClick(btn);
      await new Promise((r) => setTimeout(r, 180));
      if (cleaned) return null;
      el = findChatInput();
      if (el) {
        simulateRealClick(el);
        return { el, openedByUs: true };
      }
    }

    logChatDomDiagnostics();
    return null;
  }

  function setNativeInputValue(el, value) {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
      el.textContent = value;
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
      } catch {
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && typeof desc.set === 'function') {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function postToBiketerraChat(text, autoSubmit) {
    const found = await ensureChatInput();
    if (!found || !found.el) {
      throw new Error('Could not find Biketerra chat box (check Terra logs)');
    }
    const { el } = found;
    simulateRealClick(el);
    setNativeInputValue(el, text);

    if (!autoSubmit) return;

    await new Promise((r) => setTimeout(r, 40));
    if (cleaned) return;

    const enterOpts = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
    el.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
    el.dispatchEvent(new KeyboardEvent('keyup', enterOpts));

    await new Promise((r) => setTimeout(r, 90));
    if (cleaned) return;

    // Fallback if Biketerra didn't submit on Enter alone
    const currentText = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? el.value : el.textContent;
    if (el.isConnected && currentText === text) {
      const form = el.closest('form');
      const sendBtn = (form || el.parentElement)?.querySelector?.('button[type="submit"], button');
      if (sendBtn && !sendBtn.disabled && isElementVisible(sendBtn, 12, 12)) {
        simulateRealClick(sendBtn);
      } else if (form && typeof form.requestSubmit === 'function') {
        try { form.requestSubmit(); } catch {}
      }
    }

    // Release focus so ride hotkeys (W, S, Space) keep working
    await new Promise((r) => setTimeout(r, 80));
    if (document.activeElement === el) {
      try { el.blur(); } catch {}
    }
  }

  /* ── 4. Audio Capture, Adaptive VAD, & Recording State Machine ────────────── */
  let activeMode = S.mode === 'auto' || S.mode === 'wake' ? 'auto' : 'ptt';
  let handsFreeArmed = false;

  try {
    const savedMode = await terra.storage.get(STORAGE_MODE_KEY, null);
    if (savedMode === 'auto' || savedMode === 'wake') activeMode = 'auto';
    else if (savedMode === 'ptt') activeMode = 'ptt';
    handsFreeArmed = Boolean(await terra.storage.get(STORAGE_ARMED_KEY, false));
  } catch {}

  let mediaStream = null;
  let audioCtx = null;
  let sourceNode = null;
  let hpVoiceNode = null;
  let lpVoiceNode = null;
  let vadAnalyser = null;
  let vadTimeBuf = null;
  let hpClipNode = null;
  let procNode = null;
  let zeroGainNode = null;
  let resampler = null;
  let micStartingPromise = null;

  const preRoll = new ByteRingBuffer(16000); // 500 ms @ 16kHz 16-bit mono
  let isRecording = false;
  let recordReason = null; // 'ptt' | 'manual' | 'vad'
  let recordChunks = [];
  let recordBytes = 0;
  let recordStartedAt = 0;

  // Hands-free VAD tracking
  let noiseFloor = 0.012;
  let vadWarmupFrames = 0;
  let vadOnsetFrames = 0;
  let vadLastVoiceAt = 0;
  let vadLastVoiceBytes = 0;
  let currentLevelPct = 0;

  // Transcription queue + pending countdown toast
  const txQueue = [];
  let txBusy = false;
  let pendingToast = null; // { text, timerId, deadline }
  let toastHideTimer = 0;
  let pttPressedSources = new Set(); // 'zwift' | 'key' | 'mouse'
  let wantPttOnMicReady = false;

  function isHandsFreeMode() {
    return activeMode === 'auto';
  }

  function isMicLive() {
    return !!(mediaStream && audioCtx && audioCtx.state === 'running');
  }

  async function ensureMicStarted() {
    if (cleaned) return false;
    if (mediaStream && audioCtx) {
      if (audioCtx.state === 'suspended') {
        try { await audioCtx.resume(); } catch {}
      }
      updateHud();
      return audioCtx.state === 'running';
    }
    if (micStartingPromise) return micStartingPromise;

    micStartingPromise = (async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('Microphone API unavailable in this browser');
        }
        const useBrowserDsp = !!S.browserAudioProcessing;
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: useBrowserDsp,
            noiseSuppression: useBrowserDsp,
            autoGainControl: useBrowserDsp,
          },
          video: false,
        });
        if (cleaned) {
          stream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
          return false;
        }

        const AC = window.AudioContext || window.webkitAudioContext;
        const ctx = new AC();
        if (ctx.state === 'suspended') {
          try { await ctx.resume(); } catch {}
        }

        const src = ctx.createMediaStreamSource(stream);

        // Voice-band filter for VAD (strips deep rower thump & fan hiss)
        const hpVad = ctx.createBiquadFilter();
        hpVad.type = 'highpass';
        hpVad.frequency.value = 250;
        const lpVad = ctx.createBiquadFilter();
        lpVad.type = 'lowpass';
        lpVad.frequency.value = 3400;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        src.connect(hpVad);
        hpVad.connect(lpVad);
        lpVad.connect(analyser);

        // Light rumble filter for Whisper audio path
        const hpClip = ctx.createBiquadFilter();
        hpClip.type = 'highpass';
        hpClip.frequency.value = 85;
        const proc = ctx.createScriptProcessor(2048, 1, 1);
        const gain = ctx.createGain();
        gain.gain.value = 0;

        resampler = new Resampler16k(ctx.sampleRate, 16000);
        vadTimeBuf = new Float32Array(analyser.fftSize);
        vadWarmupFrames = 0;
        vadOnsetFrames = 0;
        noiseFloor = 0.012;

        proc.onaudioprocess = (ev) => {
          if (cleaned) return;
          const input = ev.inputBuffer.getChannelData(0);
          handleAudioFrame(input, analyser);
        };

        src.connect(hpClip);
        hpClip.connect(proc);
        proc.connect(gain);
        gain.connect(ctx.destination);

        mediaStream = stream;
        audioCtx = ctx;
        sourceNode = src;
        hpVoiceNode = hpVad;
        lpVoiceNode = lpVad;
        vadAnalyser = analyser;
        hpClipNode = hpClip;
        procNode = proc;
        zeroGainNode = gain;

        updateHud();
        return ctx.state === 'running';
      } catch (e) {
        log('mic error:', e && e.message ? e.message : e);
        showToast('Mic Error', (e && e.message) || 'Could not open microphone', 'err', 4500);
        return false;
      } finally {
        micStartingPromise = null;
      }
    })();

    return micStartingPromise;
  }

  function stopMicHardware() {
    isRecording = false;
    recordReason = null;
    recordChunks = [];
    recordBytes = 0;
    preRoll.clear();
    currentLevelPct = 0;

    if (procNode) { try { procNode.onaudioprocess = null; procNode.disconnect(); } catch {} procNode = null; }
    if (zeroGainNode) { try { zeroGainNode.disconnect(); } catch {} zeroGainNode = null; }
    if (hpClipNode) { try { hpClipNode.disconnect(); } catch {} hpClipNode = null; }
    if (vadAnalyser) { try { vadAnalyser.disconnect(); } catch {} vadAnalyser = null; }
    if (lpVoiceNode) { try { lpVoiceNode.disconnect(); } catch {} lpVoiceNode = null; }
    if (hpVoiceNode) { try { hpVoiceNode.disconnect(); } catch {} hpVoiceNode = null; }
    if (sourceNode) { try { sourceNode.disconnect(); } catch {} sourceNode = null; }
    if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
    if (mediaStream) {
      for (const t of mediaStream.getTracks()) {
        try { t.stop(); } catch {}
      }
      mediaStream = null;
    }
    resampler = null;
    updateHud();
  }

  function computeRms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      sum += v * v;
    }
    return Math.sqrt(sum / Math.max(1, buf.length));
  }

  function getVadThreshold() {
    const sens = clamp(S.vadSensitivity, 1, 10, 5);
    const snrMult = 4.2 - (sens - 1) * (2.6 / 9);
    const minAbs = 0.032 - (sens - 1) * (0.025 / 9);
    return Math.max(minAbs, noiseFloor * snrMult);
  }

  function startRecording(reason) {
    if (isRecording || cleaned) return;
    isRecording = true;
    recordReason = reason;
    recordStartedAt = performance.now();
    const pre = preRoll.drain(reason === 'ptt' ? 11200 : 16000); // 350ms PTT / 500ms VAD
    recordChunks = pre.length ? [pre] : [];
    recordBytes = pre.length;
    vadLastVoiceAt = performance.now();
    vadLastVoiceBytes = recordBytes;
    updateHud();
  }

  function finishRecording(minActiveMs = 150) {
    if (!isRecording) return;
    const elapsedMs = performance.now() - recordStartedAt;
    const reason = recordReason;
    const chunks = recordChunks;
    const trimEndBytes = reason === 'vad' ? Math.max(3200, vadLastVoiceBytes + 8960) : Infinity; // keep +280ms tail
    isRecording = false;
    recordReason = null;
    recordChunks = [];
    recordBytes = 0;
    vadOnsetFrames = 0;
    vadLastVoiceBytes = 0;
    updateHud();

    if (elapsedMs < minActiveMs) {
      return;
    }
    let pcm = concatBytes(chunks);
    if (Number.isFinite(trimEndBytes) && trimEndBytes < pcm.length) {
      const evenTrim = trimEndBytes - (trimEndBytes & 1);
      pcm = pcm.subarray(0, evenTrim);
    }
    if (pcm.length < 3200) return; // < 100 ms total
    if (S.autoGainBoost !== false) {
      pcm = normalizeQuietPcm16(pcm);
    }
    enqueueTranscription(pcm, reason !== 'ptt' && reason !== 'manual');
  }

  function cancelRecording() {
    isRecording = false;
    recordReason = null;
    recordChunks = [];
    recordBytes = 0;
    vadOnsetFrames = 0;
    vadLastVoiceBytes = 0;
    updateHud();
  }

  function handleAudioFrame(floatChunk, analyser) {
    if (!resampler) return;
    const pcmBytes = resampler.push(floatChunk);
    analyser.getFloatTimeDomainData(vadTimeBuf);
    const rms = computeRms(vadTimeBuf);
    currentLevelPct = Math.min(100, Math.round((rms / 0.14) * 100));

    const maxBytes = clampInt(S.maxClipSec, 5, 45, 20) * 16000 * 2;
    const silenceMs = clampInt(S.silenceMs, 600, 3000, 1200);

    if (isRecording) {
      if (pcmBytes.length) {
        recordChunks.push(pcmBytes);
        recordBytes += pcmBytes.length;
      }
      if (recordReason === 'vad') {
        const thresh = getVadThreshold();
        if (rms >= thresh * 0.82) {
          vadLastVoiceAt = performance.now();
          vadLastVoiceBytes = recordBytes;
        }
        if (performance.now() - vadLastVoiceAt >= silenceMs) {
          finishRecording(260);
          return;
        }
      }
      if (recordBytes >= maxBytes) {
        finishRecording(200);
      }
      updateHudVuOnly();
      return;
    }

    // Idle: keep pre-roll warm
    if (pcmBytes.length) preRoll.push(pcmBytes);

    // Hands-free VAD detection when armed
    if (isHandsFreeMode() && handsFreeArmed && !txBusy) {
      if (vadWarmupFrames < 10) {
        noiseFloor = vadWarmupFrames === 0 ? Math.max(0.002, rms) : (noiseFloor * 0.7 + rms * 0.3);
        noiseFloor = Math.min(0.15, Math.max(0.002, noiseFloor));
        vadWarmupFrames++;
        updateHudVuOnly();
        return;
      }

      const thresh = getVadThreshold();
      if (rms >= thresh) {
        vadOnsetFrames++;
        if (vadOnsetFrames >= 4) {
          vadOnsetFrames = 0;
          startRecording('vad');
          if (pcmBytes.length) {
            recordChunks.push(pcmBytes);
            recordBytes += pcmBytes.length;
          }
        }
      } else {
        vadOnsetFrames = Math.max(0, vadOnsetFrames - 1);
        if (rms < noiseFloor * 2.2) {
          noiseFloor = Math.min(0.15, Math.max(0.002, noiseFloor * 0.96 + rms * 0.04));
        }
      }
    } else {
      vadOnsetFrames = 0;
    }

    updateHudVuOnly();
  }

  /* ── 5. Transcription Queue & Send / Countdown Flow ───────────────────────── */
  function enqueueTranscription(pcmBytes, fromHandsFree) {
    if (txQueue.length >= 2) txQueue.shift();
    txQueue.push({ pcmBytes, fromHandsFree });
    processTxQueue();
  }

  async function handleTranscribedText(rawText, fromHandsFree) {
    if (isWhisperNoiseArtifact(rawText, fromHandsFree)) {
      if (!fromHandsFree) {
        showToast('Voice Chat', 'Did not hear any speech', 'warn', 2200);
      }
      return;
    }

    // Voice confirm / cancel when a draft or countdown toast is active
    if (pendingToast) {
      if (isCancelVoiceCommand(rawText)) {
        cancelPendingToast();
        showToast('Voice Chat', 'Draft canceled', 'warn', 1600);
        return;
      }
      if (isSendVoiceCommand(rawText)) {
        const textToSend = pendingToast.text;
        cancelPendingToast();
        await sendMessageNow(textToSend, true);
        return;
      }
    }

    let message = rawText;
    if (fromHandsFree && activeMode === 'wake') {
      const phrases = parseWakePhrases(S.wakePhrases);
      const res = extractWakeMessage(rawText, phrases);
      if (!res.matched) {
        showToast('Ignored (say wake phrase)', `"${rawText}"`, 'warn', 2600);
        return;
      }
      if (!res.message) {
        showToast('Wake phrase heard', 'Say your message right after "' + res.phrase + '"', 'warn', 2200);
        return;
      }
      message = res.message;
    }

    await deliverMessage(message, fromHandsFree);
  }

  async function processTxQueue() {
    if (txBusy || cleaned) return;
    const job = txQueue.shift();
    if (!job) {
      updateHud();
      return;
    }
    txBusy = true;
    updateHud();

    try {
      const rawText = await transcribePcmWithWyoming(job.pcmBytes);
      if (cleaned) return;
      await handleTranscribedText(rawText, job.fromHandsFree);
    } catch (e) {
      if (cleaned) return;
      log('transcribe failed:', e && e.message ? e.message : e);
      showToast(
        'Whisper Error',
        (e && e.message) || 'Failed to transcribe',
        'err',
        5000,
        e && e.needsConfig ? [{ label: 'Open Settings', primary: true, onClick: () => { try { terra.settings.open(); } catch {} } }] : []
      );
    } finally {
      txBusy = false;
      updateHud();
      if (txQueue.length && !cleaned) processTxQueue();
    }
  }

  function cancelPendingToast() {
    if (!pendingToast) return;
    if (pendingToast.kind === 'countdown') clearInterval(pendingToast.timerId);
    else clearTimeout(pendingToast.timerId);
    pendingToast = null;
    hideToast();
  }

  async function sendMessageNow(message, autoSubmit) {
    try {
      await postToBiketerraChat(message, autoSubmit);
      showToast(autoSubmit ? 'Sent to Chat' : 'Filled Chat Input', message, 'ok', 2200);
    } catch (e) {
      showToast('Chat Error', (e && e.message) || 'Could not post to chat', 'err', 4000);
    }
  }

  async function deliverMessage(message, fromHandsFree = false) {
    const rawBehavior = fromHandsFree ? S.handsFreeSendBehavior : S.sendBehavior;
    const defaultBehavior = fromHandsFree ? 'voice' : 'countdown';
    const behavior = ['voice', 'countdown', 'immediate', 'fill'].includes(rawBehavior) ? rawBehavior : defaultBehavior;

    if (behavior === 'immediate') {
      cancelPendingToast();
      await sendMessageNow(message, true);
      return;
    }
    if (behavior === 'fill') {
      cancelPendingToast();
      await sendMessageNow(message, false);
      return;
    }

    if (behavior === 'voice') {
      cancelPendingToast();
      const timerId = setTimeout(() => {
        if (pendingToast && pendingToast.timerId === timerId) {
          cancelPendingToast();
          showToast('Voice Chat', 'Draft expired', 'warn', 1600);
        }
      }, 60000);
      pendingToast = { text: message, kind: 'voice', timerId, deadline: performance.now() + 60000 };
      showToast(
        'Draft · Say "send it" or "cancel"',
        message,
        'ok',
        0,
        [
          {
            label: 'Send',
            primary: true,
            onClick: () => {
              cancelPendingToast();
              sendMessageNow(message, true);
            },
          },
          {
            label: 'Cancel',
            danger: true,
            onClick: () => {
              cancelPendingToast();
              showToast('Voice Chat', 'Draft canceled', 'warn', 1600);
            },
          },
        ]
      );
      return;
    }

    // Cancelable 2s countdown
    cancelPendingToast();
    const deadline = performance.now() + 2000;
    const renderCountdown = () => {
      const remSec = Math.max(0.1, (deadline - performance.now()) / 1000).toFixed(1);
      showToast(
        `Sending in ${remSec}s…`,
        message,
        'ok',
        0,
        [
          {
            label: 'Send now',
            primary: true,
            onClick: () => {
              cancelPendingToast();
              sendMessageNow(message, true);
            },
          },
          {
            label: 'Cancel',
            danger: true,
            onClick: () => {
              cancelPendingToast();
              showToast('Voice Chat', 'Canceled', 'warn', 1500);
            },
          },
        ]
      );
    };

    const timerId = setInterval(() => {
      if (cleaned) { cancelPendingToast(); return; }
      if (performance.now() >= deadline) {
        cancelPendingToast();
        sendMessageNow(message, true);
      } else {
        renderCountdown();
      }
    }, 150);

    pendingToast = { text: message, kind: 'countdown', timerId, deadline };
    renderCountdown();
  }

  /* ── 6. PTT & Mode Controls ───────────────────────────────────────────────── */
  async function setPttState(source, down) {
    if (cleaned) return;
    if (down) {
      if (pttPressedSources.has(source)) return;
      pttPressedSources.add(source);
      if (pttPressedSources.size === 1) {
        wantPttOnMicReady = true;
        const ready = await ensureMicStarted();
        if (!ready || !wantPttOnMicReady || pttPressedSources.size === 0 || cleaned) return;
        if (!isRecording) startRecording('ptt');
      }
    } else {
      pttPressedSources.delete(source);
      if (pttPressedSources.size === 0) {
        wantPttOnMicReady = false;
        if (isRecording && recordReason === 'ptt') {
          finishRecording(140);
        }
      }
    }
  }

  async function toggleHandsFreeArmed(force) {
    const next = typeof force === 'boolean' ? force : !handsFreeArmed;
    handsFreeArmed = next;
    try { await terra.storage.set(STORAGE_ARMED_KEY, handsFreeArmed); } catch {}
    if (handsFreeArmed) {
      await ensureMicStarted();
    } else {
      if (isRecording) cancelRecording();
      stopMicHardware();
    }
    updateHud();
  }

  async function cycleMode() {
    const next = activeMode === 'ptt' ? 'auto' : 'ptt';
    activeMode = next;
    try { await terra.storage.set(STORAGE_MODE_KEY, activeMode); } catch {}
    if (isRecording) cancelRecording();

    if (isHandsFreeMode()) {
      handsFreeArmed = true;
      try { await terra.storage.set(STORAGE_ARMED_KEY, true); } catch {}
      await ensureMicStarted();
      showToast(
        'Rowing Mode: Draft + Voice Confirm',
        S.handsFreeSendBehavior === 'voice'
          ? 'Speak freely — then say "send it" or "cancel"'
          : 'All detected speech will be transcribed',
        'ok',
        3200
      );
    } else {
      handsFreeArmed = false;
      try { await terra.storage.set(STORAGE_ARMED_KEY, false); } catch {}
      showToast(
        'Bike Mode: Push-to-Talk',
        `Hold Zwift Ride RB${S.pttKey ? ' or ' + S.pttKey.replace(/^Key/, '') : ''} to talk`,
        'ok',
        2600
      );
    }
    updateHud();
  }

  /* ── 7. Ride HUD UI ───────────────────────────────────────────────────────── */
  const hud = document.createElement('div');
  hud.id = 'tvc-hud';
  hud.style.opacity = String(clamp(S.hudOpacity, 30, 100, 88) / 100);

  const pill = document.createElement('div');
  pill.className = 'tvc-pill';

  const micBtn = document.createElement('button');
  micBtn.className = 'tvc-mic-btn';
  micBtn.type = 'button';

  const dotEl = document.createElement('span');
  dotEl.className = 'tvc-dot';
  const micLabelEl = document.createElement('span');
  micBtn.append(dotEl, micLabelEl);

  const vuWrap = document.createElement('div');
  vuWrap.className = 'tvc-vu-wrap';
  const vuFill = document.createElement('div');
  vuFill.className = 'tvc-vu-fill';
  vuWrap.append(vuFill);

  const modeBtn = document.createElement('button');
  modeBtn.className = 'tvc-mode-btn';
  modeBtn.type = 'button';
  modeBtn.title = 'Switch mic mode: PTT (bike) <-> AUTO (rowing)';

  const cfgBtn = document.createElement('button');
  cfgBtn.className = 'tvc-cfg-btn';
  cfgBtn.type = 'button';
  cfgBtn.title = 'Voice Chat settings';
  cfgBtn.textContent = '\u2699';

  pill.append(micBtn, vuWrap, modeBtn, cfgBtn);

  const toast = document.createElement('div');
  toast.className = 'tvc-toast';
  const toastHead = document.createElement('div');
  toastHead.className = 'tvc-toast-head';
  const toastMsg = document.createElement('div');
  toastMsg.className = 'tvc-toast-msg';
  const toastActions = document.createElement('div');
  toastActions.className = 'tvc-toast-actions';
  toast.append(toastHead, toastMsg, toastActions);

  hud.append(toast, pill);
  document.body.appendChild(hud);

  function hideToast() {
    clearTimeout(toastHideTimer);
    toast.className = 'tvc-toast';
  }

  function showToast(head, msg, kind = 'ok', autoHideMs = 2500, actions = []) {
    clearTimeout(toastHideTimer);
    toast.className = `tvc-toast open kind-${kind}`;
    toastHead.textContent = head;
    toastMsg.textContent = msg;
    toastActions.replaceChildren();
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tvc-btn' + (a.primary ? ' primary' : a.danger ? ' danger' : '');
      b.textContent = a.label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        a.onClick();
      });
      toastActions.appendChild(b);
    }
    toastActions.style.display = actions.length ? 'flex' : 'none';
    if (autoHideMs > 0) {
      toastHideTimer = setTimeout(() => hideToast(), autoHideMs);
    }
  }

  function updateHudVuOnly() {
    vuFill.style.width = `${currentLevelPct}%`;
  }

  function updateHud() {
    pill.classList.toggle('is-recording', isRecording);
    pill.classList.toggle('is-transcribing', txBusy && !isRecording);

    const hasHost = !!String(S.host || '').trim();
    modeBtn.textContent = activeMode.toUpperCase();

    if (!hasHost) {
      dotEl.className = 'tvc-dot err';
      micLabelEl.textContent = 'Set IP';
      micBtn.title = 'Click to configure your Unraid Whisper IP in Terra settings';
    } else if (isRecording) {
      dotEl.className = 'tvc-dot recording';
      micLabelEl.textContent = recordReason === 'manual' ? 'Stop' : 'Talking…';
    } else if (txBusy) {
      dotEl.className = 'tvc-dot busy';
      micLabelEl.textContent = 'Whisper…';
    } else if (isHandsFreeMode()) {
      if (handsFreeArmed && isMicLive()) {
        dotEl.className = 'tvc-dot listening';
        micLabelEl.textContent = activeMode === 'wake' ? 'Listening' : 'Auto Mic';
      } else if (handsFreeArmed) {
        dotEl.className = 'tvc-dot err';
        micLabelEl.textContent = 'Tap Mic';
      } else {
        dotEl.className = 'tvc-dot';
        micLabelEl.textContent = 'Muted';
      }
    } else {
      dotEl.className = isMicLive() ? 'tvc-dot ready' : 'tvc-dot';
      micLabelEl.textContent = 'PTT';
      micBtn.title = `Hold to talk (or Zwift Ride RB / ${S.pttKey || 'hotkey'}), quick tap toggles recording`;
    }

    updateHudVuOnly();
  }

  // Restore saved HUD drag position (bottom-anchored so toasts grow upward)
  try {
    const pos = await terra.storage.get(STORAGE_POS_KEY, null);
    if (pos && Number.isFinite(pos.left)) {
      const clampedLeft = Math.max(8, Math.min(window.innerWidth - 180, pos.left));
      let bottomVal = Number.isFinite(pos.bottom) ? pos.bottom : null;
      if (bottomVal === null && Number.isFinite(pos.top)) {
        bottomVal = window.innerHeight - (pos.top + 48);
      }
      if (bottomVal !== null) {
        const clampedBottom = Math.max(8, Math.min(window.innerHeight - 64, bottomVal));
        hud.style.left = clampedLeft + 'px';
        hud.style.bottom = clampedBottom + 'px';
        hud.style.top = 'auto';
      }
    }
  } catch {}

  // Drag pill (ignore clicks on inner buttons; anchor to bottom so toasts always grow upward)
  let dragState = null;
  pill.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const rect = hud.getBoundingClientRect();
    dragState = { dx: e.clientX - rect.left, dyBottom: rect.bottom - e.clientY };
    pill.setPointerCapture(e.pointerId);
  });
  pill.addEventListener('pointermove', (e) => {
    if (!dragState) return;
    const left = Math.max(8, Math.min(window.innerWidth - hud.offsetWidth - 8, e.clientX - dragState.dx));
    const maxBottom = Math.max(8, window.innerHeight - pill.offsetHeight - 8);
    const bottom = Math.max(8, Math.min(maxBottom, window.innerHeight - (e.clientY + dragState.dyBottom)));
    hud.style.left = left + 'px';
    hud.style.bottom = bottom + 'px';
    hud.style.top = 'auto';
  });
  const endDrag = async () => {
    if (!dragState) return;
    dragState = null;
    const rect = hud.getBoundingClientRect();
    const bottom = Math.max(8, Math.round(window.innerHeight - rect.bottom));
    try { await terra.storage.set(STORAGE_POS_KEY, { left: Math.round(rect.left), bottom }); } catch {}
  };
  pill.addEventListener('pointerup', endDrag);
  pill.addEventListener('pointercancel', endDrag);

  // Mic button interactions:
  // - If no Unraid host configured: open settings
  // - In PTT mode: hold > 220ms = hold-to-talk; quick tap = toggle manual recording
  // - In Hands-Free mode: toggle listening on/off
  let mouseDownAt = 0;
  let mouseHoldTimer = 0;
  let mouseIsHolding = false;

  micBtn.addEventListener('pointerdown', async (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (!String(S.host || '').trim()) {
      try { terra.settings.open(); } catch {}
      return;
    }
    if (isHandsFreeMode()) return; // handled by click

    if (isRecording && recordReason === 'manual') {
      finishRecording(140);
      return;
    }

    mouseDownAt = performance.now();
    mouseIsHolding = false;
    micBtn.setPointerCapture(e.pointerId);
    mouseHoldTimer = setTimeout(() => {
      mouseIsHolding = true;
      setPttState('mouse', true);
    }, 180);
  });

  const endMouseMic = async () => {
    clearTimeout(mouseHoldTimer);
    if (isHandsFreeMode()) return;
    if (mouseDownAt === 0) return;
    const dt = performance.now() - mouseDownAt;
    mouseDownAt = 0;
    if (mouseIsHolding) {
      mouseIsHolding = false;
      await setPttState('mouse', false);
    } else if (dt < 180) {
      if (!isRecording) {
        const ready = await ensureMicStarted();
        if (ready && !cleaned) startRecording('manual');
      }
    }
  };
  micBtn.addEventListener('pointerup', endMouseMic);
  micBtn.addEventListener('pointercancel', endMouseMic);
  micBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!String(S.host || '').trim()) return;
    if (isHandsFreeMode()) {
      toggleHandsFreeArmed();
    }
  });

  modeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    cycleMode();
  });

  cfgBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    try { terra.settings.open(); } catch {}
  });

  /* ── 8. Global Listeners (Zwift Ride Bus, Keyboard Hotkey, Settings) ──────── */
  const unsubBusPtt = terra.bus.on('voice-chat:ptt', (ev) => {
    if (!ev) return;
    if (isHandsFreeMode() && ev.down) {
      // Pressing Zwift Ride PTT while in hands-free toggles/interrupts as PTT override
      setPttState('zwift', true);
      return;
    }
    setPttState('zwift', !!ev.down);
  });

  const onKeyDown = (e) => {
    if (cleaned || e.repeat) return;
    const keyCode = String(S.pttKey || '').trim();
    if (!keyCode || e.code !== keyCode) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
    e.preventDefault();
    setPttState('key', true);
  };

  const onKeyUp = (e) => {
    if (cleaned) return;
    const keyCode = String(S.pttKey || '').trim();
    if (!keyCode || e.code !== keyCode) return;
    if (pttPressedSources.has('key')) {
      e.preventDefault();
      setPttState('key', false);
    }
  };

  const onBlur = () => {
    if (pttPressedSources.size > 0) {
      pttPressedSources.clear();
      wantPttOnMicReady = false;
      if (isRecording && recordReason === 'ptt') finishRecording(140);
    }
  };

  const onUserGestureResume = () => {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().then(() => updateHud()).catch(() => {});
    }
  };

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pointerdown', onUserGestureResume, { passive: true });

  let unsubSettings = null;
  if (terra.settings && terra.settings.onChange) {
    unsubSettings = terra.settings.onChange(async (ev) => {
      try { S = { ...DEFAULTS, ...(await terra.settings.all()) }; } catch {}
      hud.style.opacity = String(clamp(S.hudOpacity, 30, 100, 88) / 100);
      if (ev && ev.key === 'mode' && ['ptt', 'wake', 'auto'].includes(S.mode)) {
        activeMode = S.mode === 'wake' ? 'auto' : S.mode;
        try { await terra.storage.set(STORAGE_MODE_KEY, activeMode); } catch {}
        if (isHandsFreeMode()) await toggleHandsFreeArmed(true);
        else await toggleHandsFreeArmed(false);
      }
      if (ev && ev.key === 'browserAudioProcessing' && isMicLive()) {
        stopMicHardware();
        if (isHandsFreeMode() ? handsFreeArmed : true) {
          ensureMicStarted().catch(() => {});
        }
      }
      updateHud();
    });
  }

  // Auto-arm hands-free if persisted in wake/auto mode
  if (isHandsFreeMode() && handsFreeArmed && String(S.host || '').trim()) {
    ensureMicStarted().catch(() => {});
  }
  updateHud();

  if (terra.settings && terra.settings.preview) {
    terra.settings.preview((slot) => {
      if (!slot) return;
      const box = document.createElement('div');
      box.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid rgba(56,189,248,0.28);background:rgba(15,23,42,0.85);color:#e2e8f0;font-size:12px;';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;';
      const status = document.createElement('div');
      status.style.cssText = 'font-size:11.5px;color:#94a3b8;';
      status.textContent = 'Run quick diagnostics while on a /ride page:';

      const btnTcp = document.createElement('button');
      btnTcp.type = 'button';
      btnTcp.className = 'tvc-btn primary';
      btnTcp.textContent = 'Test Whisper Server';
      btnTcp.addEventListener('click', async () => {
        const hostVal = String(S.host || '').trim();
        if (!hostVal) { status.textContent = 'Enter your Whisper server IP above first.'; return; }
        const port = clampInt(S.port, 1, 65535, 10300);
        status.textContent = `Connecting to ${hostVal}:${port}…`;
        const t0 = performance.now();
        try {
          const conn = await terra.tcp.connect('{{setting:host}}', port, 4000);
          await terra.tcp.close(conn).catch(() => {});
          status.textContent = `Connected to ${hostVal}:${port} in ${Math.round(performance.now() - t0)} ms.`;
        } catch (e) {
          status.textContent = `TCP error: ${(e && e.message) || e}`;
        }
      });

      const btnChat = document.createElement('button');
      btnChat.type = 'button';
      btnChat.className = 'tvc-btn';
      btnChat.textContent = 'Detect Chat Box';
      btnChat.addEventListener('click', async () => {
        status.textContent = 'Searching for Biketerra chat box…';
        const res = await ensureChatInput();
        if (res && res.el) {
          const el = res.el;
          status.textContent = `Found <${el.tagName.toLowerCase()}> (${el.placeholder || el.className || el.id || 'activeElement'})`;
        } else {
          status.textContent = 'Chat box not found (must be on a /ride page; check Terra logs).';
        }
      });

      row.append(btnTcp, btnChat);
      box.append(row, status);
      slot.appendChild(box);
    });
  }

  /* ── 9. Cleanup ───────────────────────────────────────────────────────────── */
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    cancelPendingToast();
    clearTimeout(toastHideTimer);
    clearTimeout(mouseHoldTimer);
    for (const conn of [...activeConns.keys()]) {
      try { terra.tcp.close(conn).catch(() => {}); } catch {}
    }
    activeConns.clear();
    stopMicHardware();
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('pointerdown', onUserGestureResume);
    try { unsubBusPtt && unsubBusPtt(); } catch {}
    try { unsubTcpFrame && unsubTcpFrame(); } catch {}
    try { unsubTcpState && unsubTcpState(); } catch {}
    try { unsubSettings && unsubSettings(); } catch {}
    try { hud.remove(); } catch {}
    if (window.__terraVoiceChatCleanup === cleanup) delete window.__terraVoiceChatCleanup;
    if (window.__terraVoiceChatHelpers === exportHelpersForTests) delete window.__terraVoiceChatHelpers;
  }

  window.__terraVoiceChatCleanup = cleanup;
  terra.onCleanup(cleanup);
  terra.onNavigate((url) => {
    if (!/^https:\/\/biketerra\.com\/(ride|spectate)/i.test(String(url || ''))) {
      cleanup();
    }
  });

  log('voice-chat ready (mode=' + activeMode + ')');
})();
