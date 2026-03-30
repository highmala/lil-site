# LIL World Template — Recording Guide

## What is a World?

A World is a complete sonic universe for the LIL generative engine. It defines everything:
- **Scales & chords** — the harmonic language
- **Timbres** — what the instruments sound like (synth params or audio samples)
- **Samples** — optional audio files that replace synthesis (one-shots, loops, textures)
- **Rhythm patterns** — how the beat feels
- **FX settings** — reverb, delay, filter ranges
- **Colors** — the visual palette for the 4 corners
- **Tempo range** — how fast/slow the world runs

## Four Corners

Every world defines 4 sonic characters:

| | **Sing** (left) | **Float** (right) |
|---|---|---|
| **Play** (top) | Rhythmic, melodic, bright, energetic | Shimmery, spacious, textural, bright |
| **Sleep** (bottom) | Warm, vocal, tender, slow | Deep, droney, vast, beatless |

## Recording a World

### 1. Melodic Samples (sing side)
Record one-shots at multiple pitches for the **music box** voice:
- `sing-play/` — bright, percussive (kalimba, xylophone, plucked, music box)
- `sing-sleep/` — warm, sustained (vocal, bowed, hummed, soft)
- Format: WAV or MP3, trimmed, ~1-4 seconds each
- Name: `C4.wav`, `D4.wav`, etc. (or just numbered for chromatic mapping)
- Record at least 5-8 pitches per voice; the engine can pitch-shift the rest

### 2. Pad / Texture Samples (float side)
- `float-play/` — bright textures, shimmer, granular sparkle
- `float-sleep/` — drones, deep textures, noise, rumble
- These can be longer loops (5-30 seconds) that the engine crossfades

### 3. Rhythm Samples (play side)
- `rhythm/kick.wav` — soft thump
- `rhythm/hat.wav` — tick/click
- `rhythm/rim.wav` — ghost note sound
- `rhythm/perc1.wav`, `perc2.wav` — additional texture

### 4. Bass
- `bass/` — one-shots or a single sample pitched across range
- Or define synth parameters in the config

### 5. Atmosphere / Noise
- `atmosphere/` — room tone, field recording, processed noise
- Loops continuously, fades with sleep/float amount

## Config File

Each world is a `world-name.json` in the `worlds/` folder plus an optional `worlds/world-name/` folder for samples.

See `default.json` for the full config structure.

### Key Fields:
```json
{
  "meta": { "id": "world-name", "name": "Display Name", "artist": "Artist" },
  "colors": { "singPlay": "#hex", "floatPlay": "#hex", "singSleep": "#hex", "floatSleep": "#hex" },
  "tempo": { "sleep": 55, "play": 115 },
  "chords": { "singPlay": [...], "singSleep": [...], "floatPlay": [...], "floatSleep": [...] },
  "samples": {
    "singPlay": ["url1.wav", "url2.wav"],
    "singSleep": ["url1.wav"],
    "floatPlay": ["url1.wav"],
    "bass": ["url.wav"],
    "rhythm": { "kick": "url", "hat": "url", "rim": "url" },
    "atmosphere": "url.wav"
  },
  "synths": { ... },
  "fx": { ... }
}
```

## World 001 — Recording Session Checklist

### Studio Setup
- [ ] Choose a sonic palette / source material
- [ ] Set up recording chain (interface → DAW → bounce stems)
- [ ] Decide on tuning / temperament (standard 440? detuned? microtonal?)

### Capture
- [ ] Record 8+ melodic one-shots for sing+play voice
- [ ] Record 8+ melodic one-shots for sing+sleep voice (different timbre)
- [ ] Record 2-4 pad/texture loops for float+play
- [ ] Record 2-4 pad/texture loops for float+sleep
- [ ] Record kick, hat, rim, 1-2 extra perc hits
- [ ] Record bass one-shots (3-5 pitches)
- [ ] Record atmosphere/noise bed

### Process
- [ ] Trim, normalize, export as WAV/MP3
- [ ] Name files according to pitch or number
- [ ] Write the world JSON config
- [ ] Test in browser

### Ship
- [ ] Add to `worlds/` folder
- [ ] Push to git
- [ ] Test on lil.audio/play
