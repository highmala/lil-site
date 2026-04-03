// ═══ SAMPLER-BASED AUDIO ENGINE ═══
// Activates when ?world= URL param is present

(function() {
  'use strict';

  let world = null;
  let S = {}; // samplers
  let sGain, sReverb, sDelay, sFilter;
  let sLoop, sStarted = false;
  let step = 0, chordIdx = 0;

  const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  function midiToName(m) { return NOTES[m % 12] + Math.floor(m / 12 - 1); }
  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // Chord progressions per corner
  const CHORDS = {
    sp: [
      { pad: [60,64,67], bass: 48 },
      { pad: [65,69,72], bass: 53 },
      { pad: [67,71,74], bass: 55 },
      { pad: [57,60,64], bass: 45 },
    ],
    ss: [
      { pad: [57,60,64,67], bass: 45 },
      { pad: [60,64,67,71], bass: 48 },
      { pad: [65,69,72,76], bass: 53 },
      { pad: [62,66,69,73], bass: 50 },
    ],
    fp: [
      { pad: [60,64,67,71], bass: 48 },
      { pad: [62,66,69,73], bass: 50 },
      { pad: [64,68,71,76], bass: 52 },
      { pad: [67,71,74,78], bass: 55 },
    ],
    fs: [
      { pad: [48,55,60,67], bass: 36 },
      { pad: [50,57,62,69], bass: 38 },
      { pad: [53,60,65,72], bass: 41 },
      { pad: [45,52,57,64], bass: 33 },
    ]
  };

  function corner(x, y) {
    if (x < 0.5 && y >= 0.5) return 'sp';
    if (x < 0.5 && y < 0.5)  return 'ss';
    if (x >= 0.5 && y >= 0.5) return 'fp';
    return 'fs';
  }

  async function init(worldName) {
    console.log('[sampler] init:', worldName);

    // 1. Load world config
    const resp = await fetch('/play/worlds/' + worldName + '.json');
    if (!resp.ok) throw new Error('World JSON not found: ' + resp.status);
    world = await resp.json();
    console.log('[sampler] world loaded:', world.meta.name);

    // 2. Build FX chain
    sReverb = new Tone.Reverb({ decay: world.fx.decayMin, wet: 0.3 }).toDestination();
    sDelay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: world.fx.fbMin, wet: 0.05 }).connect(sReverb);
    sFilter = new Tone.Filter({ frequency: world.fx.filtMax, type: 'lowpass', rolloff: -12 }).connect(sDelay);
    sGain = new Tone.Gain(world.mix.master).connect(sFilter);

    // 3. Create samplers (all connect to sGain)
    const ws = world.samples;
    const base = '/play/worlds/';

    // Melody: Tone.Sampler with note URLs
    const melUrls = {};
    ['C4','D4','E4','G4','A4','C5','D5','E5'].forEach(n => {
      melUrls[n] = base + ws.melody.replace('{note}', n);
    });
    S.melody = new Tone.Sampler({ urls: melUrls }).connect(sGain);

    // Bass: Tone.Sampler
    const bassUrls = {};
    ['C2','F2'].forEach(n => {
      bassUrls[n] = base + ws.bass.replace('{note}', n);
    });
    S.bass = new Tone.Sampler({ urls: bassUrls }).connect(sGain);

    // One-shot Players
    S.kick = new Tone.Player(base + ws.kick).connect(sGain);
    S.hat  = new Tone.Player(base + ws.hat).connect(sGain);
    S.rim  = new Tone.Player(base + ws.rim).connect(sGain);
    S.bell = new Tone.Player(base + ws.bell).connect(sGain);

    // Pad Players (looping)
    const padFiles = Array.isArray(ws.pad) ? ws.pad : [ws.pad];
    S.pads = padFiles.map(u => {
      const p = new Tone.Player(base + u).connect(sGain);
      p.loop = true;
      return p;
    });

    // Atmosphere (looping)
    S.atmo = new Tone.Player(base + ws.atmosphere).connect(sGain);
    S.atmo.loop = true;

    // 4. Wait for ALL buffers
    await Tone.loaded();
    console.log('[sampler] all buffers loaded');

    // 5. Start loopers
    S.pads.forEach(p => { p.volume.value = -14; p.start(); });
    S.atmo.volume.value = -22;
    S.atmo.start();

    // 6. Start sequencer
    const BPC = world.barsPerChord || 2;
    const STEPS = 8;

    sLoop = new Tone.Loop(time => {
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;
      const c = corner(x, y);
      const cfg = world.corners[c];
      const chords = CHORDS[c];
      const beat = step % STEPS;

      // Chord change
      if (step % (STEPS * BPC) === 0) {
        chordIdx = (chordIdx + 1) % chords.length;
      }
      const ch = chords[chordIdx];

      // KICK (beats 0, 4)
      if (beat === 0 || beat === 4) {
        if (Math.random() < (cfg.kick || 0.5) * lerp(0.2, 1.0, y)) {
          S.kick.volume.value = lerp(-20, -6, y);
          S.kick.start(time);
        }
      }

      // HAT (even 8ths)
      if (beat % 2 === 0 && Math.random() < (cfg.hat || 0.4) * lerp(0.1, 1.0, y)) {
        S.hat.volume.value = lerp(-24, -10, y);
        S.hat.start(time);
      }

      // RIM (offbeats)
      if ((beat === 3 || beat === 7) && Math.random() < 0.3 * y) {
        S.rim.volume.value = lerp(-20, -8, y);
        S.rim.start(time);
      }

      // MELODY
      const melD = cfg.melDensity || 0.5;
      if (Math.random() < melD * lerp(0.3, 1.0, y)) {
        const scale = cfg.scale || [0,2,4,7,9];
        const lo = cfg.melLow || 60, hi = cfg.melHigh || 84;
        const pool = [];
        for (let m = lo; m <= hi; m++) {
          if (scale.includes(m % 12)) pool.push(m);
        }
        if (pool.length) {
          const midi = pool[Math.floor(Math.random() * pool.length)];
          S.melody.volume.value = lerp(-16, -4, y * (1 - x * 0.3));
          // Sampler.triggerAttackRelease takes note name
          S.melody.triggerAttackRelease(midiToName(midi), '4n', time);
        }
      }

      // BELL (glow side)
      if (x > 0.4 && Math.random() < (cfg.bellDensity || 0.3) * x) {
        S.bell.volume.value = lerp(-20, -8, x);
        S.bell.start(time);
      }

      // BASS (beat 0)
      if (beat === 0) {
        S.bass.volume.value = lerp(-18, -6, lerp(0.5, 1, 1 - x));
        S.bass.triggerAttackRelease(midiToName(ch.bass), '2n', time);
      }

      step++;
    }, '8n');

    sLoop.start(0);
    Tone.getTransport().bpm.value = world.tempo.sleep;
    Tone.getTransport().start();

    sStarted = true;
    console.log('[sampler] sequencer running');
    return true;
  }

  // ─── PUBLIC API ───
  window._samplerEngine = {
    start: async function() {
      const p = new URLSearchParams(window.location.search).get('world');
      if (!p) return false;
      return await init(p);
    },

    update: function() {
      if (!sStarted || !world) return;
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;

      Tone.getTransport().bpm.value = lerp(world.tempo.sleep, world.tempo.play, y) * lerp(1.0, world.tempo.glowMult, x);
      sReverb.wet.value = Math.min(lerp(0.1, 0.6, x) + lerp(0.2, 0, y), 0.8);
      sDelay.wet.value = lerp(0.03, 0.3, x);
      sDelay.feedback.value = lerp(world.fx.fbMin, world.fx.fbMax, x);
      sFilter.frequency.value = lerp(world.fx.filtMin, world.fx.filtMax, y) * lerp(1.0, 0.75, x);
      sGain.gain.value = world.mix.master;

      const c = corner(x, y);
      const padLvl = world.corners[c].pad || 0.5;
      S.pads.forEach(p => { p.volume.value = lerp(-30, -8, padLvl * (1 - y * 0.3)); });
      S.atmo.volume.value = lerp(-40, -14, (world.corners[c].noise || 0.3) * x);
    },

    isActive: function() { return sStarted; }
  };
})();
