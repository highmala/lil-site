// ═══ SAMPLER-BASED AUDIO ENGINE ═══
// Loads world JSON + wav samples, plays through XY pad

(function() {
  let world = null;
  let samplers = {};
  let sGain, sReverb, sDelay, sFilter;
  let sLoop;
  let sStarted = false;
  let step = 0;
  let currentChordIdx = 0;

  // ─── CHORD PROGRESSIONS (same as synth engine, reused) ───
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

  function midiToNote(m) {
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return names[m % 12] + Math.floor(m / 12 - 1);
  }
  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  function getCorner(x, y) {
    if (x < 0.5 && y >= 0.5) return 'sp';
    if (x < 0.5 && y < 0.5)  return 'ss';
    if (x >= 0.5 && y >= 0.5) return 'fp';
    return 'fs';
  }

  async function loadWorld(name) {
    const resp = await fetch('worlds/' + name + '.json');
    world = await resp.json();
    console.log('[sampler] loaded world:', world.meta.name);
  }

  async function loadSamples() {
    const s = world.samples;

    // Melody sampler (pitched)
    const melUrls = {};
    ['C4','D4','E4','G4','A4','C5','D5','E5'].forEach(n => {
      melUrls[n] = 'worlds/' + s.melody.replace('{note}', n);
    });
    samplers.melody = new Tone.Sampler({ urls: melUrls });

    // Bass sampler (pitched)
    const bassUrls = {};
    ['C2','F2'].forEach(n => {
      bassUrls[n] = 'worlds/' + s.bass.replace('{note}', n);
    });
    samplers.bass = new Tone.Sampler({ urls: bassUrls });

    // One-shot players
    samplers.kick = new Tone.Player('worlds/' + s.kick);
    samplers.hat  = new Tone.Player('worlds/' + s.hat);
    samplers.rim  = new Tone.Player('worlds/' + s.rim);
    samplers.bell = new Tone.Player('worlds/' + s.bell);

    // Pad players
    const padUrls = Array.isArray(s.pad) ? s.pad : [s.pad];
    samplers.pads = padUrls.map(u => {
      const p = new Tone.Player('worlds/' + u);
      p.loop = true;
      return p;
    });

    // Atmosphere loop
    samplers.atmo = new Tone.Player('worlds/' + s.atmosphere);
    samplers.atmo.loop = true;

    // Wait for all buffers to load
    await Tone.loaded();
    console.log('[sampler] all samples loaded');
  }

  function buildFX() {
    sReverb = new Tone.Reverb({ decay: world.fx.decayMin, wet: 0.3 }).toDestination();
    sDelay  = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: world.fx.fbMin, wet: 0.05 }).connect(sReverb);
    sFilter = new Tone.Filter({ frequency: world.fx.filtMax, type: 'lowpass', rolloff: -12 }).connect(sDelay);
    sGain   = new Tone.Gain(world.mix.master).connect(sFilter);
  }

  function connectAll() {
    samplers.melody.connect(sGain);
    samplers.bass.connect(sGain);
    samplers.kick.connect(sGain);
    samplers.hat.connect(sGain);
    samplers.rim.connect(sGain);
    samplers.bell.connect(sGain);
    samplers.pads.forEach(p => p.connect(sGain));
    samplers.atmo.connect(sGain);
  }

  function startSequencer() {
    const W = world;
    const STEPS = 8; // 8th notes per bar
    const BPC = W.barsPerChord || 2;

    sLoop = new Tone.Loop(time => {
      const x = typeof xVal !== 'undefined' ? xVal : 0.5;
      const y = typeof yVal !== 'undefined' ? yVal : 0.5;
      const corner = getCorner(x, y);
      const cfg = W.corners[corner];
      const chords = CHORDS[corner];
      const beatInBar = step % STEPS;

      // Chord change
      if (step % (STEPS * BPC) === 0) {
        currentChordIdx = (currentChordIdx + 1) % chords.length;
      }
      const ch = chords[currentChordIdx];

      // ─── KICK (beats 0, 4) ───
      if (beatInBar === 0 || beatInBar === 4) {
        const kickProb = (cfg.kick || 0.5) * lerp(0.2, 1.0, y);
        if (Math.random() < kickProb && samplers.kick.loaded) {
          samplers.kick.volume.value = lerp(-20, -6, y);
          samplers.kick.start(time);
        }
      }

      // ─── HAT (even 8ths) ───
      if (beatInBar % 2 === 0) {
        const hatProb = (cfg.hat || 0.4) * lerp(0.1, 1.0, y);
        if (Math.random() < hatProb && samplers.hat.loaded) {
          samplers.hat.volume.value = lerp(-24, -10, y);
          samplers.hat.start(time);
        }
      }

      // ─── RIM (offbeat) ───
      if (beatInBar === 3 || beatInBar === 7) {
        if (Math.random() < 0.3 * y && samplers.rim.loaded) {
          samplers.rim.volume.value = lerp(-20, -8, y);
          samplers.rim.start(time);
        }
      }

      // ─── MELODY ───
      const melDensity = cfg.melDensity || 0.5;
      if (Math.random() < melDensity * lerp(0.3, 1.0, y) && samplers.melody.loaded) {
        const scale = cfg.scale || [0, 2, 4, 7, 9];
        const lo = cfg.melLow || 60;
        const hi = cfg.melHigh || 84;
        // Pick a note from the scale in range
        const candidates = [];
        for (let m = lo; m <= hi; m++) {
          if (scale.includes(m % 12)) candidates.push(m);
        }
        if (candidates.length > 0) {
          const note = candidates[Math.floor(Math.random() * candidates.length)];
          samplers.melody.volume.value = lerp(-16, -4, y * (1 - x * 0.3));
          samplers.melody.triggerAttackRelease(midiToFreq(note), '4n', time);
        }
      }

      // ─── BELL (glow side) ───
      if (x > 0.4) {
        const bellDensity = cfg.bellDensity || 0.3;
        if (Math.random() < bellDensity * x && samplers.bell.loaded) {
          samplers.bell.volume.value = lerp(-20, -8, x);
          samplers.bell.start(time);
        }
      }

      // ─── BASS (on beat 0) ───
      if (beatInBar === 0 && samplers.bass.loaded) {
        samplers.bass.volume.value = lerp(-18, -6, lerp(0.5, 1, 1 - x));
        samplers.bass.triggerAttackRelease(midiToFreq(ch.bass), '2n', time);
      }

      step++;
    }, '8n');

    sLoop.start(0);
  }

  // ─── PUBLIC API ───
  window._samplerEngine = {
    start: async function() {
      const params = new URLSearchParams(window.location.search);
      const worldName = params.get('world');
      if (!worldName) return false;

      try {
        await loadWorld(worldName);
        await loadSamples();
        buildFX();
        connectAll();

        // Start pads and atmosphere
        samplers.pads.forEach(p => {
          if (p.loaded) { p.volume.value = -14; p.start(); }
        });
        if (samplers.atmo.loaded) {
          samplers.atmo.volume.value = -22;
          samplers.atmo.start();
        }

        startSequencer();
        sStarted = true;

        Tone.getTransport().bpm.value = world.tempo.sleep;
        Tone.getTransport().start();

        // Start the visual/audio update loop from the main engine
        if (typeof startAudioControlLoop === 'function') {
          window.audioStarted = true;
          startAudioControlLoop();
        }

        console.log('[sampler] engine running:', world.meta.name);
        return true;
      } catch(e) {
        console.error('[sampler] failed:', e);
        return false;
      }
    },

    update: function() {
      if (!sStarted || !world) return;
      const x = typeof xVal !== 'undefined' ? xVal : 0.5;
      const y = typeof yVal !== 'undefined' ? yVal : 0.5;

      Tone.getTransport().bpm.value = lerp(world.tempo.sleep, world.tempo.play, y) * lerp(1.0, world.tempo.glowMult, x);
      sReverb.wet.value = Math.min(lerp(0.1, 0.6, x) + lerp(0.2, 0, y), 0.8);
      sDelay.wet.value = lerp(0.03, 0.3, x);
      sDelay.feedback.value = lerp(world.fx.fbMin, world.fx.fbMax, x);
      sFilter.frequency.value = lerp(world.fx.filtMin, world.fx.filtMax, y) * lerp(1.0, 0.75, x);
      sGain.gain.value = world.mix.master;

      // Pad volume based on corner
      const corner = getCorner(x, y);
      const padLevel = (world.corners[corner].pad || 0.5);
      samplers.pads.forEach(p => { p.volume.value = lerp(-30, -8, padLevel * (1 - y * 0.3)); });

      // Atmosphere volume
      const noiseLevel = (world.corners[corner].noise || 0.3);
      samplers.atmo.volume.value = lerp(-40, -14, noiseLevel * x);
    },

    isActive: function() { return sStarted; }
  };
})();
