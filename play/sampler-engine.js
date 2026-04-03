// ═══ SAMPLER-BASED AUDIO ENGINE ═══
// 4 distinct lead instruments per corner + unique musical behavior

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

    const ws = world.samples;
    const base = '/play/worlds/';
    const noteList = ['C4','D4','E4','G4','A4','C5','D5','E5'];

    // ─── 4 LEAD SAMPLERS (one per corner) ───
    S.leads = {};
    if (ws.leads) {
      for (const c of ['sp','ss','fp','fs']) {
        const urls = {};
        noteList.forEach(n => {
          urls[n] = base + ws.leads[c].replace('{note}', n);
        });
        S.leads[c] = new Tone.Sampler({ urls: urls }).connect(sGain);
      }
    } else {
      // Fallback: use single melody sampler for all corners
      const melUrls = {};
      noteList.forEach(n => {
        melUrls[n] = base + ws.melody.replace('{note}', n);
      });
      const mel = new Tone.Sampler({ urls: melUrls }).connect(sGain);
      S.leads = { sp: mel, ss: mel, fp: mel, fs: mel };
    }

    // Bass sampler
    const bassUrls = {};
    ['C2','F2'].forEach(n => {
      bassUrls[n] = base + ws.bass.replace('{note}', n);
    });
    S.bass = new Tone.Sampler({ urls: bassUrls }).connect(sGain);

    // One-shots
    S.kick = new Tone.Player(base + ws.kick).connect(sGain);
    S.hat  = new Tone.Player(base + ws.hat).connect(sGain);
    S.rim  = new Tone.Player(base + ws.rim).connect(sGain);
    S.bell = new Tone.Player(base + ws.bell).connect(sGain);

    // Pads (looping)
    const padFiles = Array.isArray(ws.pad) ? ws.pad : [ws.pad];
    S.pads = padFiles.map(u => {
      const p = new Tone.Player(base + u).connect(sGain);
      p.loop = true;
      return p;
    });

    // Atmosphere (looping)
    S.atmo = new Tone.Player(base + ws.atmosphere).connect(sGain);
    S.atmo.loop = true;

    await Tone.loaded();
    console.log('[sampler] all buffers loaded');

    // Start loopers quietly
    S.pads.forEach(p => { p.volume.value = -40; p.start(); });
    S.atmo.volume.value = -50;
    S.atmo.start();

    // ═══ SEQUENCER ═══
    // Corner behaviors:
    //
    // HUM+PLAY (sp):  Bird chirps / "Da" — fast, rhythmic, drums + frequent short leads
    // HUM+SLEEP (ss): Owl hoots / "Ooh" — sparse, slow, long sustained leads, no drums
    // GLOW+PLAY (fp): Water drops / "Ee" — sparkly bells, light rhythm, plucky leads
    // GLOW+SLEEP (fs): Wind / "Ahh" — deep drone, pads+atmo dominate, rare ghostly leads

    const BPC = world.barsPerChord || 2;
    const STEPS = 8;

    sLoop = new Tone.Loop(time => {
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;

      // Bilinear corner weights
      const wSP = (1 - x) * y;
      const wSS = (1 - x) * (1 - y);
      const wFP = x * y;
      const wFS = x * (1 - y);

      const c = corner(x, y);
      const cfg = world.corners[c];
      const chords = CHORDS[c];
      const beat = step % STEPS;

      if (step % (STEPS * BPC) === 0) {
        chordIdx = (chordIdx + 1) % chords.length;
      }
      const ch = chords[chordIdx];
      const scale = cfg.scale || [0,2,4,7,9];

      // Helper: pick note from scale in MIDI range
      function pickNote(lo, hi) {
        const pool = [];
        for (let m = lo; m <= hi; m++) {
          if (scale.includes(m % 12)) pool.push(m);
        }
        return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
      }

      // ═══ HUM+PLAY CORNER: Rhythmic energy ═══
      if (wSP > 0.15) {
        // Kick on 1 and 3
        if ((beat === 0 || beat === 4) && Math.random() < wSP * 0.85) {
          S.kick.volume.value = lerp(-30, -6, wSP);
          S.kick.start(time);
        }
        // Hat on even 8ths
        if (beat % 2 === 0 && Math.random() < wSP * 0.7) {
          S.hat.volume.value = lerp(-28, -10, wSP);
          S.hat.start(time);
        }
        // SP lead: frequent, short, bright (bird chirps / "da")
        if (Math.random() < wSP * 0.6) {
          const n = pickNote(cfg.melLow || 60, cfg.melHigh || 84);
          if (n) {
            S.leads.sp.volume.value = lerp(-20, -4, wSP);
            S.leads.sp.triggerAttackRelease(midiToName(n), '8n', time);
          }
        }
        // Bass on beat 1
        if (beat === 0) {
          S.bass.volume.value = lerp(-20, -6, wSP);
          S.bass.triggerAttackRelease(midiToName(ch.bass), '2n', time);
        }
      }

      // ═══ HUM+SLEEP CORNER: Sparse, meditative ═══
      if (wSS > 0.15) {
        // SS lead: rare, long, low (owl hoots / "ooh")
        if (beat === 0 && Math.random() < wSS * 0.25) {
          const n = pickNote((cfg.melLow || 60), Math.min((cfg.melLow || 60) + 8, cfg.melHigh || 72));
          if (n) {
            S.leads.ss.volume.value = lerp(-24, -8, wSS);
            S.leads.ss.triggerAttackRelease(midiToName(n), '1n', time);
          }
        }
        // Very occasional deep bass
        if (beat === 0 && step % (STEPS * 2) === 0 && Math.random() < wSS * 0.3) {
          S.bass.volume.value = lerp(-24, -12, wSS);
          S.bass.triggerAttackRelease(midiToName(ch.bass), '1n', time);
        }
      }

      // ═══ GLOW+PLAY CORNER: Sparkly, airy ═══
      if (wFP > 0.15) {
        // Bell sparkles
        if ((beat === 0 || beat === 2 || beat === 4 || beat === 6) && Math.random() < wFP * 0.5) {
          S.bell.volume.value = lerp(-24, -6, wFP);
          S.bell.start(time);
        }
        // Rim on offbeats
        if ((beat === 3 || beat === 7) && Math.random() < wFP * 0.5) {
          S.rim.volume.value = lerp(-22, -8, wFP);
          S.rim.start(time);
        }
        // FP lead: plucky, mid-density (water drops / "ee")
        if (Math.random() < wFP * 0.4) {
          const n = pickNote((cfg.bellReg || 80) - 8, (cfg.bellReg || 80) + 8);
          if (n) {
            S.leads.fp.volume.value = lerp(-22, -6, wFP);
            S.leads.fp.triggerAttackRelease(midiToName(n), '4n', time);
          }
        }
        // Light bass
        if (beat === 0 && Math.random() < wFP * 0.4) {
          S.bass.volume.value = lerp(-24, -12, wFP);
          S.bass.triggerAttackRelease(midiToName(ch.bass), '2n', time);
        }
      }

      // ═══ GLOW+SLEEP CORNER: Deep drone ═══
      if (wFS > 0.15) {
        // FS lead: very rare, ghostly, long (wind / "ahh")
        if (beat === 0 && step % (STEPS * 4) === 0 && Math.random() < wFS * 0.3) {
          const n = pickNote(48, 60);
          if (n) {
            S.leads.fs.volume.value = lerp(-28, -10, wFS);
            S.leads.fs.triggerAttackRelease(midiToName(n), '2n', time);
          }
        }
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

      const wSP = (1 - x) * y;
      const wSS = (1 - x) * (1 - y);
      const wFP = x * y;
      const wFS = x * (1 - y);

      // Tempo
      Tone.getTransport().bpm.value = lerp(world.tempo.sleep, world.tempo.play, y) * lerp(1.0, world.tempo.glowMult, x);

      // Reverb: dry in sp, wet in fs
      sReverb.wet.value = wSP * 0.1 + wSS * 0.35 + wFP * 0.3 + wFS * 0.65;

      // Delay: glow side
      sDelay.wet.value = lerp(0.0, 0.25, x);
      sDelay.feedback.value = lerp(world.fx.fbMin, world.fx.fbMax, x);

      // Filter: bright in play, dark in sleep
      sFilter.frequency.value = wSP * 8000 + wSS * 1200 + wFP * 6000 + wFS * 800;

      // Pad: quiet in sp, LOUD in fs
      const padVol = wSP * 0.05 + wSS * 0.4 + wFP * 0.3 + wFS * 0.9;
      S.pads.forEach(p => { p.volume.value = lerp(-40, -6, padVol); });

      // Atmosphere: silent in sp, dominant in fs
      const atmoVol = wSP * 0.0 + wSS * 0.15 + wFP * 0.1 + wFS * 0.8;
      S.atmo.volume.value = lerp(-50, -8, atmoVol);

      sGain.gain.value = world.mix.master;
    },

    isActive: function() { return sStarted; }
  };
})();
