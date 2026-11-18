const E = require('./engine.js');
const fs = require('fs');
function synth(melody, bpm, opts = {}) {
  const sr = 44100, beat = 60 / bpm;
  const total = melody.reduce((s, m) => s + m[1], 0) * beat + 1;
  const x = new Float32Array(Math.ceil(total * sr));
  let t = 0.4, phase = 0, seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (const [midi, beats, legato] of melody) {
    const dur = beats * beat, n0 = Math.round(t * sr), len = Math.round(dur * (legato ? 0.98 : 0.85) * sr);
    if (midi !== null) {
      const f = 440 * Math.pow(2, (midi - 69 + (opts.detune || 0)) / 12);
      for (let i = 0; i < len; i++) {
        const tt = i / sr;
        const scoop = tt < 0.05 ? -0.7 * (1 - tt / 0.05) : 0; // slide up into the note
        const vib = 0.15 * Math.sin(2 * Math.PI * 5.5 * tt) * Math.min(1, tt / 0.3);
        const ff = f * Math.pow(2, (scoop + vib) / 12);
        phase += 2 * Math.PI * ff / sr;
        const env = Math.min(1, tt / 0.03) * Math.min(1, (len / sr - tt) / 0.05);
        x[n0 + i] += 0.3 * env * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase));
      }
    }
    t += dur;
  }
  for (let i = 0; i < x.length; i++) x[i] += 0.01 * rnd();
  return { x, sr };
}
// Twinkle twinkle in D major-ish, plus repeated notes, sung low (male range)
const D = 50; // D3
const mel = [[D,1],[D,1],[D+7,1],[D+7,1],[D+9,1],[D+9,1],[D+7,2],[D+5,1],[D+5,1],[D+4,1],[D+4,1],[D+2,0.5,1],[D+4,0.5,1],[D+2,1],[D,2]];
for (const [bpm, detune] of [[96, -0.3], [120, 0.2], [72, 0]]) {
  const { x, sr } = synth(mel, bpm, { detune });
  const t0 = Date.now();
  const r = E.analyze([x], sr);
  const est = E.estimateTempo(r.notes);
  const key = E.estimateKey(r.notes);
  const ev = E.quantize(r.notes, { bpm, grid: 2 });
  console.log(`bpm ${bpm} est ${est} tuning ${r.tuningCents}c key ${E.keyName(key.fifths, key.mode)} time ${Date.now() - t0}ms`);
  console.log(' notes', r.notes.map(n => n.midi - D).join(' '));
  console.log(' quant', ev.map(e => (e.midi === null ? 'r' : e.midi - D) + ':' + e.dur).join(' '));
  const xml = E.toMusicXML(ev, { bpm, fifths: key.fifths, mode: key.mode, clef: E.chooseClef(r.notes) });
  fs.writeFileSync(`/tmp/out_${bpm}.musicxml`, xml);
  fs.writeFileSync(`/tmp/out_${bpm}.mid`, E.toMIDI(ev, { bpm }));
  fs.writeFileSync(`/tmp/out_${bpm}.zip`, E.zip([{ name: 'melody.musicxml', data: new TextEncoder().encode(xml) }, { name: 'melody.mid', data: E.toMIDI(ev, { bpm }) }]));
}
