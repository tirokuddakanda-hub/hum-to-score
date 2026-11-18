# Hum to Score

Hum a melody and get sheet music back. You can play it, adjust it, and export it as MusicXML (for MuseScore, Dorico, Sibelius) and MIDI (for GarageBand, Logic or any DAW).

**Open the app:** https://tirokuddakanda-hub.github.io/hum-to-score/

On iPhone or iPad, open it in Safari and tap Share → **Add to Home Screen** to install it like an app. It works offline after the first visit.

Everything runs in your browser. Recordings never leave your device.

## How it works

1. **Listen.** Every 10 ms it measures the pitch you're humming (the YIN method).
2. **Clean up.** It works out how far your hum sits from standard tuning, then smooths over the scoops and slides between notes.
3. **Find notes.** A new note starts when the pitch changes, or when the volume dips between two hums on the same pitch.
4. **Rhythm and key.** It tries tempos until note starts line up with a beat grid, and guesses the key from the notes used most.
5. **Write it out.** It fits the notes to the grid and writes MusicXML. [OpenSheetMusicDisplay](https://opensheetmusicdisplay.org/) draws the score from that file.

## Files

| File | What it is |
| --- | --- |
| `src/engine.js` | The listening and writing logic: pitch tracking, notes, tempo, key, MusicXML, MIDI. No screen code. |
| `src/template.html` | The screen: layout, styles, buttons, playback, sharing. |
| `src/engine-test.js` | Runs the engine on made-up hums: `node src/engine-test.js` |
| `tools/build.py` | Combines the two `src` files into the published page: `python3 tools/build.py` |
| `index.html`, `sw.js` | **Built files. Don't edit by hand.** Edit `src/` and rebuild. |
| `opensheetmusicdisplay.min.js` | Score-drawing library, v2.3.1 (BSD-3, see `OSMD-LICENSE.txt`) |
| `manifest.webmanifest`, `*.png` | Home-screen name and icon |
