// ═══ SAMPLER ENGINE — ElevenLabs SFX-based ═══
// All sounds are Tone.Player (one-shots/loops), no pitched Samplers

(function() {
  'use strict';

  let world = null;
  let S = {};
  let sGain, sReverb, sDelay, sFilter;
  let sLoop, sStarted = false;
  let step = 0;

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

    // 4 lead Players (one per corner)
    S.leads = {};
    for (const c of ['sp','ss','fp','fs']) {
      S.leads[c] = new Tone.Player(base + ws.leads[c]).connect(sGain);
    }

    // Rhythm one-shots
    S.kick = new Tone.Player(base + ws.kick).connect(sGain);
    S.hat  = new Tone.Player(base + ws.hat).connect(sGain);
    S.rim  = new Tone.Player(base + ws.rim).connect(sGain);
    S.bell = new Tone.Player(base + ws.bell).connect(sGain);
    S.bass = new Tone.Player(base + ws.bass).connect(sGain);

    // Pad loops
    const padFiles = Array.isArray(ws.pad) ? ws.pad : [ws.pad];
    S.pads = padFiles.map(u => {
      const p = new Tone.Player(base + u).connect(sGain);
      p.loop = true;
      return p;
    });

    // Atmosphere loop
    S.atmo = new Tone.Player(base + ws.atmosphere).connect(sGain);
    S.atmo.loop = true;

    await Tone.loaded();
    console.log('[sampler] all buffers loaded');

    // Start loopers (muted, controlled by update)
    S.pads.forEach(p => { p.volume.value = -40; p.start(); });
    S.atmo.volume.value = -50;
    S.atmo.start();

    // ═══ SEQUENCER ═══
    //
    // HUM+PLAY (sp):  Rhythmic — kick, hat, bass, frequent lead triggers
    // HUM+SLEEP (ss): Sparse — rare lead triggers, no drums, breathing space
    // GLOW+PLAY (fp): Sparkly — bells, rim, plucky lead
    // GLOW+SLEEP (fs): Drone — pads+atmo dominate, very rare ghostly lead

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

      const beat = step % STEPS;

      // ═══ HUM+PLAY: Full energy ═══
      if (wSP > 0.15) {
        // Kick on 1 and 3
        if ((beat === 0 || beat === 4) && Math.random() < wSP * 0.85) {
          S.kick.volume.value = lerp(-28, -4, wSP);
          S.kick.start(time);
        }
        // Hat on even 8ths
        if (beat % 2 === 0 && Math.random() < wSP * 0.65) {
          S.hat.volume.value = lerp(-26, -8, wSP);
          S.hat.start(time);
        }
        // Bass on beat 1
        if (beat === 0) {
          S.bass.volume.value = lerp(-22, -6, wSP);
          S.bass.start(time);
        }
        // Lead: bird chirps / vocal "da" — frequent, rhythmic
        if (Math.random() < wSP * 0.45) {
          S.leads.sp.volume.value = lerp(-18, -2, wSP);
          // Pitch-shift by changing playbackRate slightly for variety
          S.leads.sp.playbackRate = 0.8 + Math.random() * 0.8;
          S.leads.sp.start(time);
        }
      }

      // ═══ HUM+SLEEP: Sparse, meditative ═══
      if (wSS > 0.15) {
        // Lead: owl hoot / "ooh" — rare, slow
        if (beat === 0 && Math.random() < wSS * 0.15) {
          S.leads.ss.volume.value = lerp(-22, -6, wSS);
          S.leads.ss.playbackRate = 0.7 + Math.random() * 0.3;
          S.leads.ss.start(time);
        }
        // Very rare bass
        if (beat === 0 && step % (STEPS * 4) === 0 && Math.random() < wSS * 0.2) {
          S.bass.volume.value = lerp(-28, -14, wSS);
          S.bass.playbackRate = 0.6;
          S.bass.start(time);
        }
      }

      // ═══ GLOW+PLAY: Sparkly, airy ═══
      if (wFP > 0.15) {
        // Bells
        if ((beat === 0 || beat === 2 || beat === 4 || beat === 6) && Math.random() < wFP * 0.45) {
          S.bell.volume.value = lerp(-22, -4, wFP);
          S.bell.playbackRate = 0.8 + Math.random() * 0.6;
          S.bell.start(time);
        }
        // Rim on offbeats
        if ((beat === 3 || beat === 7) && Math.random() < wFP * 0.4) {
          S.rim.volume.value = lerp(-22, -8, wFP);
          S.rim.start(time);
        }
        // Lead: water drops / "ee" — mid-density plucky
        if (Math.random() < wFP * 0.3) {
          S.leads.fp.volume.value = lerp(-20, -4, wFP);
          S.leads.fp.playbackRate = 0.7 + Math.random() * 0.8;
          S.leads.fp.start(time);
        }
        // Light bass
        if (beat === 0 && Math.random() < wFP * 0.3) {
          S.bass.volume.value = lerp(-24, -12, wFP);
          S.bass.start(time);
        }
      }

      // ═══ GLOW+SLEEP: Deep drone ═══
      if (wFS > 0.15) {
        // Lead: wind / "ahh" — very rare, ghostly
        if (beat === 0 && step % (STEPS * 6) === 0 && Math.random() < wFS * 0.25) {
          S.leads.fs.volume.value = lerp(-24, -8, wFS);
          S.leads.fs.playbackRate = 0.5 + Math.random() * 0.3;
          S.leads.fs.start(time);
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

      // Reverb: dry in sp, soaked in fs
      sReverb.wet.value = wSP * 0.1 + wSS * 0.4 + wFP * 0.3 + wFS * 0.7;

      // Delay: glow side only
      sDelay.wet.value = lerp(0.0, 0.3, x);
      sDelay.feedback.value = lerp(world.fx.fbMin, world.fx.fbMax, x);

      // Filter: bright play, dark sleep
      sFilter.frequency.value = wSP * 8000 + wSS * 1200 + wFP * 6000 + wFS * 700;

      // Pad: quiet in sp, loud in fs
      const padVol = wSP * 0.03 + wSS * 0.4 + wFP * 0.25 + wFS * 0.95;
      S.pads.forEach(p => { p.volume.value = lerp(-45, -4, padVol); });

      // Atmosphere: silent in sp, dominant in fs
      const atmoVol = wSP * 0.0 + wSS * 0.2 + wFP * 0.1 + wFS * 0.85;
      S.atmo.volume.value = lerp(-50, -6, atmoVol);

      sGain.gain.value = world.mix.master;
    },

    isActive: function() { return sStarted; }
  };
})();
