// ═══ SAMPLER-BASED AUDIO ENGINE ═══
// Each corner has genuinely different musical behavior

(function() {
  'use strict';

  let world = null;
  let S = {};
  let sGain, sReverb, sDelay, sFilter;
  let sLoop, sStarted = false;
  let step = 0, chordIdx = 0;

  const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  function midiToName(m) { return NOTES[m % 12] + Math.floor(m / 12 - 1); }

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

    const resp = await fetch('/play/worlds/' + worldName + '.json');
    if (!resp.ok) throw new Error('World JSON not found: ' + resp.status);
    world = await resp.json();
    console.log('[sampler] world loaded:', world.meta.name);

    // FX chain
    sReverb = new Tone.Reverb({ decay: world.fx.decayMin, wet: 0.3 }).toDestination();
    sDelay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: world.fx.fbMin, wet: 0.05 }).connect(sReverb);
    sFilter = new Tone.Filter({ frequency: world.fx.filtMax, type: 'lowpass', rolloff: -12 }).connect(sDelay);
    sGain = new Tone.Gain(world.mix.master).connect(sFilter);

    // Load samples
    const ws = world.samples;
    const base = '/play/worlds/';

    const melUrls = {};
    ['C4','D4','E4','G4','A4','C5','D5','E5'].forEach(n => {
      melUrls[n] = base + ws.melody.replace('{note}', n);
    });
    S.melody = new Tone.Sampler({ urls: melUrls }).connect(sGain);

    const bassUrls = {};
    ['C2','F2'].forEach(n => {
      bassUrls[n] = base + ws.bass.replace('{note}', n);
    });
    S.bass = new Tone.Sampler({ urls: bassUrls }).connect(sGain);

    S.kick = new Tone.Player(base + ws.kick).connect(sGain);
    S.hat  = new Tone.Player(base + ws.hat).connect(sGain);
    S.rim  = new Tone.Player(base + ws.rim).connect(sGain);
    S.bell = new Tone.Player(base + ws.bell).connect(sGain);

    const padFiles = Array.isArray(ws.pad) ? ws.pad : [ws.pad];
    S.pads = padFiles.map(u => {
      const p = new Tone.Player(base + u).connect(sGain);
      p.loop = true;
      return p;
    });

    S.atmo = new Tone.Player(base + ws.atmosphere).connect(sGain);
    S.atmo.loop = true;

    await Tone.loaded();
    console.log('[sampler] all buffers loaded');

    // Start loopers (volume controlled by update)
    S.pads.forEach(p => { p.volume.value = -30; p.start(); });
    S.atmo.volume.value = -40;
    S.atmo.start();

    // ═══ SEQUENCER ═══
    // Each corner has fundamentally different behavior:
    //
    // HUM+PLAY (sp):  Rhythmic + melodic. Kick, hat, melody, bass. Bright, energetic.
    // HUM+SLEEP (ss): Sparse melody only. No drums. Slow, dark, breathing.
    // GLOW+PLAY (fp): Bells + shimmer. Light rhythm (rim only). Sparkly, airy.
    // GLOW+SLEEP (fs): Pure atmosphere. Pads + noise. Almost no notes. Deep drone.

    const BPC = world.barsPerChord || 2;
    const STEPS = 8;

    sLoop = new Tone.Loop(time => {
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;

      // Weights for each corner (bilinear interpolation)
      const wSP = (1 - x) * y;       // hum + play
      const wSS = (1 - x) * (1 - y); // hum + sleep
      const wFP = x * y;              // glow + play
      const wFS = x * (1 - y);        // glow + sleep

      const c = corner(x, y);
      const cfg = world.corners[c];
      const chords = CHORDS[c];
      const beat = step % STEPS;

      if (step % (STEPS * BPC) === 0) {
        chordIdx = (chordIdx + 1) % chords.length;
      }
      const ch = chords[chordIdx];

      // ─── KICK: only hum+play corner ───
      // Fades out as you move toward sleep or glow
      if ((beat === 0 || beat === 4) && wSP > 0.15) {
        if (Math.random() < wSP * 0.9) {
          S.kick.volume.value = lerp(-30, -6, wSP);
          S.kick.start(time);
        }
      }

      // ─── HAT: hum+play, slightly into glow+play ───
      if (beat % 2 === 0 && (wSP + wFP * 0.3) > 0.15) {
        const hatChance = wSP * 0.7 + wFP * 0.2;
        if (Math.random() < hatChance) {
          S.hat.volume.value = lerp(-28, -10, hatChance);
          S.hat.start(time);
        }
      }

      // ─── RIM: glow+play corner only ───
      if ((beat === 2 || beat === 6) && wFP > 0.15) {
        if (Math.random() < wFP * 0.6) {
          S.rim.volume.value = lerp(-24, -8, wFP);
          S.rim.start(time);
        }
      }

      // ─── MELODY: hum side (both play and sleep) ───
      // In hum+play: frequent, wide register, bright
      // In hum+sleep: rare, narrow register, quiet
      const melWeight = wSP + wSS * 0.4; // melody lives on the hum side
      if (melWeight > 0.1) {
        const density = wSP > wSS
          ? lerp(0.2, 0.7, wSP)   // play: frequent
          : lerp(0.05, 0.2, wSS); // sleep: sparse

        if (Math.random() < density) {
          const scale = cfg.scale || [0,2,4,7,9];
          // Register shifts: play=wide, sleep=narrow+low
          const lo = wSP > wSS ? (cfg.melLow || 60) : (cfg.melLow || 60) + 7;
          const hi = wSP > wSS ? (cfg.melHigh || 84) : Math.min((cfg.melLow || 60) + 12, cfg.melHigh || 72);
          const pool = [];
          for (let m = lo; m <= hi; m++) {
            if (scale.includes(m % 12)) pool.push(m);
          }
          if (pool.length) {
            const midi = pool[Math.floor(Math.random() * pool.length)];
            S.melody.volume.value = lerp(-22, -6, melWeight);
            const dur = wSP > wSS ? '8n' : '2n'; // short in play, long in sleep
            S.melody.triggerAttackRelease(midiToName(midi), dur, time);
          }
        }
      }

      // ─── BELL: glow side (both play and sleep) ───
      // In glow+play: frequent sparkles
      // In glow+sleep: rare, distant
      const bellWeight = wFP + wFS * 0.2;
      if (bellWeight > 0.1 && (beat === 0 || beat === 2 || beat === 4 || beat === 6)) {
        const bellDensity = wFP > wFS
          ? lerp(0.15, 0.5, wFP)  // play: sparkly
          : lerp(0.02, 0.1, wFS); // sleep: occasional

        if (Math.random() < bellDensity) {
          S.bell.volume.value = lerp(-26, -8, bellWeight);
          S.bell.start(time);
        }
      }

      // ─── BASS: play side (both hum and glow) ───
      // Disappears in sleep
      if (beat === 0 && y > 0.25) {
        const bassWeight = y * 0.8;
        S.bass.volume.value = lerp(-24, -8, bassWeight);
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

      // Corner weights
      const wSP = (1 - x) * y;
      const wSS = (1 - x) * (1 - y);
      const wFP = x * y;
      const wFS = x * (1 - y);

      // Tempo: fast in play, slow in sleep, slightly slower in glow
      Tone.getTransport().bpm.value = lerp(world.tempo.sleep, world.tempo.play, y) * lerp(1.0, world.tempo.glowMult, x);

      // Reverb: dry in hum+play, wet in glow+sleep
      const revWet = wSP * 0.1 + wSS * 0.35 + wFP * 0.3 + wFS * 0.65;
      sReverb.wet.value = revWet;

      // Delay: off in hum, present in glow
      sDelay.wet.value = lerp(0.0, 0.25, x);
      sDelay.feedback.value = lerp(world.fx.fbMin, world.fx.fbMax, x);

      // Filter: open in play, dark in sleep
      const filt = wSP * 8000 + wSS * 1200 + wFP * 6000 + wFS * 800;
      sFilter.frequency.value = filt;

      // Pad volume: quiet in hum+play, LOUD in glow+sleep
      const padVol = wSP * 0.05 + wSS * 0.4 + wFP * 0.3 + wFS * 0.9;
      S.pads.forEach(p => { p.volume.value = lerp(-40, -6, padVol); });

      // Atmosphere: silent in hum+play, dominant in glow+sleep
      const atmoVol = wSP * 0.0 + wSS * 0.15 + wFP * 0.1 + wFS * 0.8;
      S.atmo.volume.value = lerp(-50, -8, atmoVol);

      sGain.gain.value = world.mix.master;
    },

    isActive: function() { return sStarted; }
  };
})();
