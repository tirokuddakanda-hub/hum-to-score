// Hum-to-score engine: pitch tracking, note segmentation, tempo/key estimation,
// quantization, and MusicXML / MIDI / ZIP writers. Runs in the browser and in Node.
(function (root) {
  'use strict';

  // ---------- audio prep ----------
  // Downmix + crude low-pass decimation to ~16 kHz (plenty for a hummed melody).
  function prepare(channels, sampleRate) {
    const n = channels[0].length;
    const mono = new Float32Array(n);
    for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length;
    const factor = Math.max(1, Math.round(sampleRate / 16000));
    const out = new Float32Array(Math.floor(n / factor));
    for (let i = 0; i < out.length; i++) {
      let s = 0;
      for (let k = 0; k < factor; k++) s += mono[i * factor + k];
      out[i] = s / factor;
    }
    return { samples: out, sr: sampleRate / factor };
  }

  // ---------- pitch tracking (YIN) ----------
  function trackPitch(x, sr, opts) {
    opts = opts || {};
    const hop = Math.round(sr * 0.01);           // 10 ms
    const fmin = opts.fmin || 65, fmax = opts.fmax || 1100;
    const tauMax = Math.ceil(sr / fmin), tauMin = Math.floor(sr / fmax);
    const W = Math.round(sr * 0.025);             // 25 ms integration window
    const thresh = opts.threshold || 0.15;
    const frames = [];
    const d = new Float32Array(tauMax + 1);
    for (let start = 0; start + W + tauMax < x.length; start += hop) {
      // energy
      let e = 0;
      for (let i = 0; i < W; i++) e += x[start + i] * x[start + i];
      const rms = Math.sqrt(e / W);
      // difference function
      for (let tau = 1; tau <= tauMax; tau++) {
        let s = 0;
        for (let i = 0; i < W; i++) { const v = x[start + i] - x[start + i + tau]; s += v * v; }
        d[tau] = s;
      }
      // cumulative mean normalized difference
      let run = 0; d[0] = 1;
      for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; d[tau] = run > 0 ? d[tau] * tau / run : 1; }
      let tau = -1;
      for (let t = Math.max(2, tauMin); t < tauMax; t++) {
        if (d[t] < thresh) { while (t + 1 < tauMax && d[t + 1] < d[t]) t++; tau = t; break; }
      }
      let aper = 1;
      if (tau < 0) { // fall back to global min, mark low confidence
        let best = 1e9;
        for (let t = Math.max(2, tauMin); t < tauMax; t++) if (d[t] < best) { best = d[t]; tau = t; }
      }
      // Octave check: a hummed "mmm" has a weak fundamental, so YIN sometimes locks onto
      // twice the true period (an octave too low). If half (or a third) of the period also
      // matches well, the higher pitch is the real one.
      for (const k of [2, 3]) {
        const c = Math.round(tau / k);
        if (c < Math.max(2, tauMin)) continue;
        let bt = c;
        for (let j = Math.max(2, c - 2); j <= Math.min(tauMax - 1, c + 2); j++) if (d[j] < d[bt]) bt = j;
        if (d[bt] < 0.3 && d[bt] < d[tau] + 0.12) { tau = bt; break; }
      }
      aper = d[tau];
      // parabolic interpolation
      let ft = tau;
      if (tau > 1 && tau < tauMax) {
        const a = d[tau - 1], b = d[tau], c = d[tau + 1];
        const den = a + c - 2 * b;
        if (den > 0) ft = tau + 0.5 * (a - c) / den;
      }
      const f0 = sr / ft;
      frames.push({ t: start / sr, rms, f0, aper, midi: 69 + 12 * Math.log2(f0 / 440) });
    }
    // voicing decision
    let maxRms = 0;
    for (const f of frames) if (f.rms > maxRms) maxRms = f.rms;
    const gate = Math.max(maxRms * (opts.gate || 0.08), 1e-4);
    for (const f of frames) f.voiced = f.rms > gate && f.aper < 0.35;
    // median-smooth the pitch of voiced frames (5 frames)
    const sm = frames.map(f => f.midi);
    for (let i = 0; i < frames.length; i++) {
      if (!frames[i].voiced) continue;
      const w = [];
      for (let k = -2; k <= 2; k++) { const f = frames[i + k]; if (f && f.voiced) w.push(f.midi); }
      w.sort((a, b) => a - b);
      sm[i] = w[w.length >> 1];
    }
    frames.forEach((f, i) => { f.midiS = sm[i]; });
    fixOctaves(frames);
    return { frames, hopSec: hop / sr };
  }

  // Any reading that sits an octave (or two) away from what you were humming around it
  // gets moved by whole octaves to the nearest fit. Two passes, half a second each way.
  function fixOctaves(frames) {
    const R = 50;
    for (let pass = 0; pass < 2; pass++) {
      const ref = new Array(frames.length);
      for (let i = 0; i < frames.length; i++) {
        if (!frames[i].voiced) continue;
        const w = [];
        for (let k = -R; k <= R; k++) {
          const f = frames[i + k];
          if (f && f.voiced) for (let r = 0; r < (f.aper < 0.1 ? 2 : 1); r++) w.push(f.midiS); // trust clear frames more
        }
        w.sort((a, b) => a - b);
        ref[i] = w[w.length >> 1];
      }
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        if (!f.voiced) continue;
        const k = Math.round((ref[i] - f.midiS) / 12);
        if (k !== 0 && Math.abs(f.midiS + 12 * k - ref[i]) < Math.abs(f.midiS - ref[i])) {
          f.midiS += 12 * k; f.midi += 12 * k;
        }
      }
    }
  }

  // ---------- note segmentation ----------
  function segment(track, opts) {
    opts = opts || {};
    const { frames, hopSec } = track;
    const minDur = opts.minNoteSec || 0.07;
    // tuning offset: people rarely hum at A440; find the cents offset that best fits
    let sx = 0, sy = 0;
    for (const f of frames) if (f.voiced) {
      const frac = f.midiS - Math.round(f.midiS);
      sx += Math.cos(2 * Math.PI * frac); sy += Math.sin(2 * Math.PI * frac);
    }
    const tuning = Math.atan2(sy, sx) / (2 * Math.PI); // semitones, -0.5..0.5
    // per-frame pitch label
    // Hysteresis: stay on the current note until the pitch is clearly (0.75 semitone) away,
    // so a voice wobbling on the edge between two notes doesn't flicker between them.
    const lab = [];
    let cur = null;
    for (const f of frames) {
      if (!f.voiced) { lab.push(null); cur = null; continue; }
      const p = f.midiS - tuning;
      if (cur === null || Math.abs(p - cur) > 0.75) cur = Math.round(p);
      lab.push(cur);
    }
    // run-length encode
    let segs = [];
    for (let i = 0; i < lab.length; i++) {
      const last = segs[segs.length - 1];
      if (last && last.p === lab[i] && last.end === i) last.end = i + 1;
      else segs.push({ p: lab[i], start: i, end: i + 1 });
    }
    // absorb short voiced blips (glides, scoops) into a neighbour; drop short unvoiced gaps
    const minFrames = Math.max(1, Math.round(minDur / hopSec));
    const gapFrames = Math.max(1, Math.round(0.04 / hopSec));
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i], len = s.end - s.start;
        const prevS = segs[i - 1], nextS = segs[i + 1];
        // a short note whose pitch lies between its neighbours is a slide, not a note
        const isGlide = s.p !== null && len < Math.max(minFrames, Math.round(0.15 / hopSec)) &&
          prevS && nextS && prevS.p !== null && nextS.p !== null && prevS.end === s.start && nextS.start === s.end &&
          (s.p - prevS.p) * (nextS.p - s.p) > 0;
        // a short sound with silence on both sides is a breath or a click
        const isBlip = s.p !== null && len < Math.round(0.12 / hopSec) &&
          (!prevS || prevS.p === null) && (!nextS || nextS.p === null);
        if (isBlip) { s.p = null; changed = true; break; }
        // a short wobble away and back to the same note belongs to that note
        const isDetour = s.p !== null && len < Math.round(0.12 / hopSec) && prevS && nextS &&
          prevS.p !== null && prevS.p === nextS.p && prevS.end === s.start && nextS.start === s.end;
        if (isDetour) {
          prevS.end = nextS.end; segs.splice(i, 2); changed = true; break;
        }
        if (isGlide) {
          nextS.start = s.start; segs.splice(i, 1); changed = true; break;
        }
        const isShortVoiced = s.p !== null && len < minFrames;
        const isShortGap = s.p === null && len < gapFrames && i > 0 && i < segs.length - 1;
        if (!isShortVoiced && !isShortGap) continue;
        const prev = segs[i - 1], next = segs[i + 1];
        let target = null;
        if (s.p === null) target = prev && next && prev.p === next.p ? prev : null;
        else {
          const cands = [prev, next].filter(c => c && c.p !== null);
          if (cands.length) target = cands.reduce((a, b) => Math.abs(a.p - s.p) <= Math.abs(b.p - s.p) ? a : b);
        }
        if (target) {
          target.start = Math.min(target.start, s.start); target.end = Math.max(target.end, s.end);
        } else if (s.p !== null) { s.p = null; }
        else continue;
        if (target) segs.splice(i, 1);
        // merge equal neighbours
        const merged = [];
        for (const g of segs) {
          const l = merged[merged.length - 1];
          if (l && l.p === g.p && l.end >= g.start) l.end = Math.max(l.end, g.end); else merged.push(g);
        }
        segs = merged; changed = true; break;
      }
    }
    // split same-pitch notes at clear energy dips (re-articulated "da-da" on one pitch)
    const out = [];
    for (const s of segs) {
      if (s.p === null) continue;
      let cuts = [s.start];
      const win = Math.round(0.06 / hopSec);
      for (let i = s.start + minFrames; i < s.end - minFrames; i++) {
        let lmax = 0, rmax = 0;
        for (let k = 1; k <= win; k++) {
          if (frames[i - k] && i - k >= s.start) lmax = Math.max(lmax, frames[i - k].rms);
          if (frames[i + k] && i + k < s.end) rmax = Math.max(rmax, frames[i + k].rms);
        }
        const r = frames[i].rms;
        let isMin = true;
        for (let k = -2; k <= 2; k++) if (frames[i + k] && frames[i + k].rms < r) isMin = false;
        if (isMin && r < 0.45 * Math.min(lmax, rmax) && i - cuts[cuts.length - 1] >= minFrames) cuts.push(i);
      }
      cuts.push(s.end);
      for (let c = 0; c < cuts.length - 1; c++) {
        const a = cuts[c], b = cuts[c + 1];
        let peak = 0;
        for (let i = a; i < b; i++) peak = Math.max(peak, frames[i].rms);
        out.push({ midi: s.p, start: frames[a].t, end: frames[b - 1].t + hopSec, peak });
      }
    }
    return { notes: out, tuningCents: Math.round(tuning * 100) };
  }

  // ---------- tempo ----------
  // Find the BPM (60–180) whose eighth-note grid best fits the onsets.
  function estimateTempo(notes) {
    if (notes.length < 3) return 90;
    const on = notes.map(n => n.start - notes[0].start);
    let best = null;
    for (let bpm = 60; bpm <= 180; bpm += 1) {
      const g = 60 / bpm / 2; // eighth
      let err = 0;
      for (const t of on) { const q = t / g; err += Math.pow(q - Math.round(q), 2); }
      err /= on.length;
      // mild preference toward ~100 bpm to avoid half/double-time picks
      const score = err + 0.02 * Math.pow(Math.log2(bpm / 100), 2);
      if (!best || score < best.score) best = { bpm, score };
    }
    return best.bpm;
  }

  // ---------- key ----------
  const KS_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KS_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function corr(a, b) {
    const ma = a.reduce((s, v) => s + v, 0) / 12, mb = b.reduce((s, v) => s + v, 0) / 12;
    let n = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return n / Math.sqrt(da * db || 1);
  }
  // fifths for major tonic pitch class (prefer common spellings)
  const MAJ_FIFTHS = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: -6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };
  function estimateKey(notes) {
    const h = new Array(12).fill(0);
    for (const n of notes) h[((n.midi % 12) + 12) % 12] += n.end - n.start;
    let best = { r: -2 };
    for (let t = 0; t < 12; t++) {
      const rot = i => h[(i + t) % 12];
      const v = Array.from({ length: 12 }, (_, i) => rot(i));
      const rM = corr(v, KS_MAJ), rm = corr(v, KS_MIN);
      if (rM > best.r) best = { r: rM, tonic: t, mode: 'major' };
      if (rm > best.r) best = { r: rm, tonic: t, mode: 'minor' };
    }
    const relMaj = best.mode === 'major' ? best.tonic : (best.tonic + 3) % 12;
    return { tonic: best.tonic, mode: best.mode, fifths: MAJ_FIFTHS[relMaj] };
  }
  const NAMES_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const NAMES_FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
  function keyName(fifths, mode) {
    const majTonic = ((fifths * 7) % 12 + 12) % 12;
    const tonic = mode === 'minor' ? (majTonic + 9) % 12 : majTonic;
    const names = fifths < 0 ? NAMES_FLAT : NAMES_SHARP;
    return names[tonic] + (mode === 'minor' ? ' minor' : ' major');
  }

  // ---------- quantize ----------
  // Returns events on a 16th-note grid: {midi|null, pos, dur} in 16ths.
  function quantize(notes, opts) {
    const bpm = opts.bpm, grid = opts.grid || 2; // grid in 16ths (2 = eighth notes)
    const sixteenth = 60 / bpm / 4;
    const t0 = notes.length ? notes[0].start : 0;
    const q = t => Math.round((t - t0) / sixteenth / grid) * grid;
    const ev = [];
    let cursor = 0;
    notes.forEach((n, i) => {
      let s = Math.max(q(n.start), cursor);
      let e = q(n.end);
      const nextS = i + 1 < notes.length ? q(notes[i + 1].start) : null;
      // humming is mostly legato: close small gaps
      if (nextS !== null && nextS - e <= Math.max(grid, 2)) e = nextS;
      if (e <= s) e = s + grid;
      if (nextS !== null && e > nextS && nextS > s) e = nextS;
      if (s > cursor) ev.push({ midi: null, pos: cursor, dur: s - cursor });
      ev.push({ midi: n.midi, pos: s, dur: e - s });
      cursor = e;
    });
    return ev;
  }

  // ---------- MusicXML ----------
  const STEP_SHARP = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
  const STEP_FLAT = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];
  function spell(midi, fifths) {
    const pc = ((midi % 12) + 12) % 12;
    const [step, alter] = (fifths < 0 ? STEP_FLAT : STEP_SHARP)[pc];
    let octave = Math.floor(midi / 12) - 1;
    return { step, alter, octave };
  }
  // durations in 16ths that are a single written note
  const SIMPLE = { 16: ['whole', 0], 12: ['half', 1], 8: ['half', 0], 6: ['quarter', 1], 4: ['quarter', 0], 3: ['eighth', 1], 2: ['eighth', 0], 1: ['16th', 0] };
  function splitDur(len, posInBar, beatLen) {
    // break a span into writable pieces, preferring to split on beats
    const parts = [];
    let p = posInBar;
    while (len > 0) {
      let take = null;
      for (const d of [16, 12, 8, 6, 4, 3, 2, 1]) {
        if (d > len) continue;
        // avoid notes that straddle a beat unless they start on a beat
        const startsOnBeat = p % beatLen === 0;
        if (!startsOnBeat && (p % beatLen) + d > beatLen && d !== 1) {
          const toBeat = beatLen - (p % beatLen);
          if (d !== toBeat) continue;
        }
        if (SIMPLE[d][1] === 1 && !startsOnBeat && d > 3) continue;
        take = d; break;
      }
      if (!take) take = 1;
      parts.push(take); p += take; len -= take;
    }
    return parts;
  }
  function toMusicXML(events, opts) {
    const beats = opts.beats || 4, beatType = opts.beatType || 4;
    const barLen = beats * 16 / beatType;                 // in 16ths
    const beatLen = beatType === 8 && beats % 3 === 0 ? 6 : 16 / beatType;
    const fifths = opts.fifths || 0, mode = opts.mode || 'major';
    const clef = opts.clef || 'treble';
    const title = esc(opts.title || 'Hummed melody');
    // lay events into measures, splitting across barlines
    const total = events.length ? events[events.length - 1].pos + events[events.length - 1].dur : 0;
    const nBars = Math.max(1, Math.ceil(total / barLen));
    const bars = Array.from({ length: nBars }, () => []);
    for (const e of events) {
      let pos = e.pos, left = e.dur;
      while (left > 0) {
        const b = Math.floor(pos / barLen), inBar = pos - b * barLen;
        const take = Math.min(left, barLen - inBar);
        bars[b].push({ midi: e.midi, pos: inBar, dur: take, tieStart: left > take, tieStop: pos > e.pos });
        pos += take; left -= take;
      }
    }
    // pad final bar
    const last = bars[nBars - 1];
    const lastEnd = last.length ? last[last.length - 1].pos + last[last.length - 1].dur : 0;
    if (lastEnd < barLen) last.push({ midi: null, pos: lastEnd, dur: barLen - lastEnd });
    let x = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n' +
      '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n' +
      '<score-partwise version="4.0">\n' +
      `  <work><work-title>${title}</work-title></work>\n` +
      '  <identification><encoding><software>Hum to Score</software></encoding></identification>\n' +
      '  <part-list><score-part id="P1"><part-name>Melody</part-name></score-part></part-list>\n' +
      '  <part id="P1">\n';
    bars.forEach((bar, bi) => {
      x += `    <measure number="${bi + 1}">\n`;
      if (bi === 0) {
        x += '      <attributes><divisions>4</divisions>' +
          `<key><fifths>${fifths}</fifths><mode>${mode}</mode></key>` +
          `<time><beats>${beats}</beats><beat-type>${beatType}</beat-type></time>` +
          (clef === 'bass' ? '<clef><sign>F</sign><line>4</line></clef>'
            : clef === 'treble8vb' ? '<clef><sign>G</sign><line>2</line><clef-octave-change>-1</clef-octave-change></clef>'
              : '<clef><sign>G</sign><line>2</line></clef>') +
          '</attributes>\n';
        if (opts.bpm) x += `      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${opts.bpm}</per-minute></metronome></direction-type><sound tempo="${opts.bpm}"/></direction>\n`;
      }
      // whole-bar rest
      if (bar.length === 1 && bar[0].midi === null && bar[0].dur === barLen) {
        x += `      <note><rest measure="yes"/><duration>${barLen}</duration></note>\n`;
      } else {
        for (const e of bar) {
          const parts = splitDur(e.dur, e.pos, beatLen);
          parts.forEach((d, pi) => {
            const [type, dot] = SIMPLE[d];
            const tStart = e.midi !== null && (pi < parts.length - 1 || e.tieStart);
            const tStop = e.midi !== null && (pi > 0 || e.tieStop);
            x += '      <note>';
            if (e.midi === null) x += '<rest/>';
            else {
              const s = spell(e.midi, fifths);
              x += `<pitch><step>${s.step}</step>${s.alter ? `<alter>${s.alter}</alter>` : ''}<octave>${s.octave}</octave></pitch>`;
            }
            x += `<duration>${d}</duration>`;
            if (tStop) x += '<tie type="stop"/>';
            if (tStart) x += '<tie type="start"/>';
            x += `<voice>1</voice><type>${type}</type>${dot ? '<dot/>' : ''}`;
            if (tStop || tStart) x += `<notations>${tStop ? '<tied type="stop"/>' : ''}${tStart ? '<tied type="start"/>' : ''}</notations>`;
            x += '</note>\n';
          });
        }
      }
      if (bi === nBars - 1) x += '      <barline location="right"><bar-style>light-heavy</bar-style></barline>\n';
      x += '    </measure>\n';
    });
    x += '  </part>\n</score-partwise>\n';
    return x;
  }
  function esc(s) { return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

  // ---------- MIDI ----------
  function toMIDI(events, opts) {
    const ppq = 480, tick = ppq / 4; // per 16th
    const bytes = [];
    const vlq = v => { const b = [v & 0x7f]; while ((v >>= 7)) b.unshift((v & 0x7f) | 0x80); return b; };
    const trk = [];
    const us = Math.round(60000000 / opts.bpm);
    trk.push(0, 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255);
    const beatType = opts.beatType || 4;
    trk.push(0, 0xff, 0x58, 4, opts.beats || 4, Math.log2(beatType), 24, 8);
    trk.push(0, 0xc0, 0x00); // piano
    let now = 0;
    for (const e of events) {
      if (e.midi === null) continue;
      const on = e.pos * tick, off = (e.pos + e.dur) * tick;
      trk.push(...vlq(on - now), 0x90, e.midi, 90); now = on;
      trk.push(...vlq(off - now), 0x80, e.midi, 0); now = off;
    }
    trk.push(0, 0xff, 0x2f, 0);
    const u32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    bytes.push(0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, (ppq >> 8) & 255, ppq & 255);
    bytes.push(0x4d, 0x54, 0x72, 0x6b, ...u32(trk.length), ...trk);
    return new Uint8Array(bytes);
  }

  // ---------- ZIP (stored, no compression) ----------
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function zip(files) { // [{name, data:Uint8Array}]
    const enc = new TextEncoder();
    const chunks = [], central = [];
    let offset = 0;
    const u16 = v => [v & 255, (v >> 8) & 255], u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      const head = [0x50, 0x4b, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0)];
      chunks.push(new Uint8Array(head), name, f.data);
      central.push(new Uint8Array([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
      offset += head.length + name.length + size;
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array([0x50, 0x4b, 5, 6, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), 0, 0]);
    const all = [...chunks, ...central, end];
    const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
    let p = 0; for (const c of all) { out.set(c, p); p += c.length; }
    return out;
  }

  function chooseClef(notes) {
    if (!notes.length) return 'treble';
    const m = notes.map(n => n.midi).sort((a, b) => a - b)[notes.length >> 1];
    return m < 57 ? 'treble8vb' : 'treble'; // low hums read best an octave down
  }

  function analyze(channels, sampleRate, opts) {
    const { samples, sr } = prepare(channels, sampleRate);
    const track = trackPitch(samples, sr, opts);
    const seg = segment(track, opts);
    return { notes: seg.notes, tuningCents: seg.tuningCents, track };
  }

  const api = { prepare, trackPitch, segment, estimateTempo, estimateKey, keyName, quantize, toMusicXML, toMIDI, zip, chooseClef, analyze };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HumEngine = api;
})(typeof self !== 'undefined' ? self : this);
