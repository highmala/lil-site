// ═══ SAMPLER ENGINE — Enhanced IDM patterns for angelxenakis world ═══
// All sounds are Tone.Player (one-shots/loops), no pitched Samplers

(function() {
  'use strict';

  let world = null;
  let S = {};
  let sGain, sReverb, sDelay, sFilter;
  let sLoop, sStarted = false;
  let step = 0;
  let rollCounter = 0; // For hi-hat rolls

  function corner(x, y) {
    if (x < 0.5 && y >= 0.5) return 'sp';
    if (x < 0.5 && y < 0.5)  return 'ss';
    if (x >= 0.5 && y >= 0.5) return 'fp';
    return 'fs';
  }

  // ═══ Euclidean-style hit distribution: spread N hits evenly across `total` steps ═══
  function isHitAtStep(stepIdx, numHits, total) {
    total = total || 16;
    if (numHits <= 0) return false;
    if (numHits >= total) return true;
    if (stepIdx === 0) return true;
    return Math.floor(stepIdx * numHits / total) !== Math.floor((stepIdx - 1) * numHits / total);
  }

  async function initSimple(worldName) {
    console.log('[sampler] init SIMPLE world');

    const resp = await fetch('/play/worlds/' + worldName + '.json');
    if (!resp.ok) throw new Error('World JSON not found: ' + resp.status);
    world = await resp.json();
    console.log('[sampler] world loaded:', world.meta.name);

    // Minimal chain: kick → master gain → destination (no FX yet, keep it simple)
    sGain = new Tone.Gain(world.mix.master).toDestination();

    const base = '/play/worlds/';
    S.kick    = new Tone.Player(base + 'simple/samples/kick.wav').connect(sGain);
    S.kickAlt = new Tone.Player(base + 'simple/samples/kick-alt.wav').connect(sGain);
    S.hihat   = new Tone.Player(base + 'simple/samples/hihat.wav').connect(sGain);

    await Tone.loaded();
    console.log('[sampler] simple kick + kick-alt + hihat loaded');

    // ═══ Kick: 16th-note sequencer, Y → density (1..16 hits per bar) ═══
    // Per-hit replacement: Y also scales the chance that OSD kick replaces the original.
    //   y=0 (far down) → 0% replace, y=1 (far up) → 75% replace, linear in between.
    let kickStep = 0;
    sLoop = new Tone.Loop(time => {
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;
      const numHits = Math.round(y * 15) + 1; // 1..16
      if (isHitAtStep(kickStep, numHits, 16)) {
        const replaceChance = y * 0.75;
        if (Math.random() < replaceChance) {
          S.kickAlt.start(time);
        } else {
          S.kick.start(time);
        }
      }
      kickStep = (kickStep + 1) % 16;
    }, '16n');

    // ═══ Hihat: 32nd-note sequencer, X → density (1..32 hits per bar) ═══
    let hatStep = 0;
    S.hatLoop = new Tone.Loop(time => {
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const numHits = Math.round(x * 31) + 1; // 1..32
      if (isHitAtStep(hatStep, numHits, 32)) {
        S.hihat.start(time);
      }
      hatStep = (hatStep + 1) % 32;
    }, '32n');

    sLoop.start(0);
    S.hatLoop.start(0);
    Tone.getTransport().bpm.value = world.tempo.play; // 111
    Tone.getTransport().start();

    sStarted = true;
    console.log('[sampler] simple sequencers (kick 16n + hat 32n) running at', world.tempo.play, 'bpm');
    return true;
  }

  async function init(worldName) {
    if (worldName === 'simple') return initSimple(worldName);

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

    // Enhanced for angelxenakis world: Multiple samples per corner
    if (worldName === 'angelxenakis') {
      // Multiple kalimbas for SP corner
      S.kalimbas = [
        new Tone.Player(base + 'angelxenakis/samples/sing-play/kalimba.wav').connect(sGain),
        new Tone.Player(base + 'angelxenakis/samples/sing-play/kalimba+7.wav').connect(sGain),
        new Tone.Player(base + 'angelxenakis/samples/sing-play/kalimba+14.wav').connect(sGain),
        new Tone.Player(base + 'angelxenakis/samples/sing-play/kalimba+21.wav').connect(sGain),
        new Tone.Player(base + 'angelxenakis/samples/sing-play/kalimba-3.wav').connect(sGain),
        new Tone.Player(base + 'angelxenakis/samples/sing-play/kalimba-7.wav').connect(sGain),
        new Tone.Player(base + 'angelxenakis/samples/sing-play/kalimba+16.wav').connect(sGain),
        new Tone.Player(base + 'angelxenakis/samples/sing-play/kalimba+23.wav').connect(sGain)
      ];
      
      // Multiple glockenspiels for FP corner
      S.glockenspiels = [
        new Tone.Player(base + 'angelxenakis/samples/float-play/glockenspiel1.wav').connect(sGain),
        new Tone.Player(base + 'angelxenakis/samples/float-play/glockenspiel2.wav').connect(sGain),
        new Tone.Player(base + 'angelxenakis/samples/float-play/glockenspiel3.wav').connect(sGain),
        new Tone.Player(base + 'angelxenakis/samples/float-play/glockenspiel4.wav').connect(sGain)
      ];
      
      // Multiple samples for SS corner (hum-sleep)
      S.sleepMelodies = [
        new Tone.Player(base + 'angelxenakis/samples/float-play/bass melody 1.wav').connect(sGain),
        new Tone.Player(base + 'angelxenakis/samples/float-play/middle melody 1.wav').connect(sGain)
      ];
      
      // Multiple samples for FS corner (glow-sleep)
      S.ambientSamples = [
        new Tone.Player(base + 'angelxenakis/samples/float-play/Saana 30sek.wav').connect(sGain),
        new Tone.Player(base + 'angelxenakis/samples/float-sleep/bass rumble 1.wav').connect(sGain)
      ];
      
      S.leads = {
        sp: S.kalimbas[0], // Main kalimba for fallback
        ss: new Tone.Player(base + ws.leads.ss).connect(sGain),
        fp: S.glockenspiels[0], // Main glockenspiel for fallback
        fs: new Tone.Player(base + ws.leads.fs).connect(sGain)
      };
    } else {
      // Standard 4 lead Players for other worlds
      S.leads = {};
      for (const c of ['sp','ss','fp','fs']) {
        S.leads[c] = new Tone.Player(base + ws.leads[c]).connect(sGain);
      }
    }

    // Rhythm one-shots
    S.kick = new Tone.Player(base + ws.kick).connect(sGain);
    S.hat  = new Tone.Player(base + ws.hat).connect(sGain);
    S.rim  = new Tone.Player(base + ws.rim).connect(sGain);
    S.bell = new Tone.Player(base + ws.bell).connect(sGain);
    
    // Add snare for angelxenakis world
    if (worldName === 'angelxenakis') {
      S.snare = new Tone.Player(base + 'angelxenakis/samples/rhythm samples/snare.wav').connect(sGain);
    }
    
    // Multiple bass players for smooth crossfading
    S.bassPlayers = [
      new Tone.Player(base + ws.bass).connect(sGain),
      new Tone.Player(base + ws.bass).connect(sGain),
      new Tone.Player(base + ws.bass).connect(sGain)
    ];
    S.currentBassIndex = 0;

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

    // ═══ ENHANCED SEQUENCER ═══
    const BPC = world.barsPerChord || 2;
    const STEPS = 8;

    // Helper function for crossfading bass
    function playBassWithCrossfade(volume, time) {
      // Fade out previous bass
      S.bassPlayers.forEach((player, i) => {
        if (i !== S.currentBassIndex && player.state === 'started') {
          player.volume.rampTo(-60, 0.05);
        }
      });
      
      // Play new bass with fade in
      const currentBass = S.bassPlayers[S.currentBassIndex];
      currentBass.volume.value = -60;
      currentBass.start(time);
      currentBass.volume.rampTo(volume, 0.05);
      
      // Cycle to next bass player
      S.currentBassIndex = (S.currentBassIndex + 1) % S.bassPlayers.length;
    }

    sLoop = new Tone.Loop(time => {
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;

      const wSP = (1 - x) * y;
      const wSS = (1 - x) * (1 - y);
      const wFP = x * y;
      const wFS = x * (1 - y);

      const beat = step % STEPS;
      const bar = Math.floor(step / STEPS);
      const beatInBar = beat;

      // ═══ HUM+PLAY: IDM-STYLE COMPLEX RHYTHMS ═══
      if (wSP > 0.15) {
        // IDM Kick Pattern: broken, syncopated
        const kickPattern = [
          1, 0, 0, 0.3, 0, 0, 0.7, 0,  // Bar pattern
          0.5, 0, 0.2, 0, 0.8, 0, 0, 0.4
        ];
        const kickProb = kickPattern[step % 16] || 0;
        if (kickProb > 0 && Math.random() < kickProb * wSP * 0.9) {
          S.kick.volume.value = lerp(-26, -2, wSP * kickProb);
          S.kick.start(time);
        }

        // IDM Hi-hat: polyrhythmic, glitchy + occasional rolls
        const hatPattern = [
          0.4, 0.8, 0.2, 0.6, 0.3, 0.9, 0.1, 0.7,
          0.5, 0.3, 0.8, 0.1, 0.6, 0.4, 0.9, 0.2
        ];
        const hatProb = hatPattern[step % 16] || 0;
        
        // Check for hi-hat rolls (more frequent, longer)
        if (step % 16 === 0 && Math.random() < 0.35 * wSP) {
          rollCounter = 12 + Math.floor(Math.random() * 8); // 12-20 hit rolls
        }
        
        if (rollCounter > 0) {
          // During roll: rapid 32nd notes
          if (step % 2 === 0) { // Every 16th note during roll
            S.hat.volume.value = lerp(-28, -8, wSP * 0.7);
            S.hat.start(time);
          }
          rollCounter--;
        } else if (Math.random() < hatProb * wSP * 0.8) {
          // Normal pattern
          S.hat.volume.value = lerp(-24, -6, wSP * hatProb);
          S.hat.start(time);
        }
        
        // Add snare to hum-play
        if (S.snare && (beat === 2 || beat === 6) && Math.random() < wSP * 0.6) {
          S.snare.volume.value = lerp(-22, -4, wSP);
          S.snare.start(time);
        }
        // Extra snare hits for variation
        if (S.snare && beat === 1 && Math.random() < wSP * 0.2) {
          S.snare.volume.value = lerp(-26, -8, wSP);
          S.snare.start(time);
        }

        // Enhanced Kalimba: Multiple samples, IDM timing
        if (S.kalimbas && worldName === 'angelxenakis') {
          // Complex melodic pattern with polyrhythms
          const melodyTriggers = [
            0.9, 0.1, 0.6, 0.2, 0.4, 0.8, 0.3, 0.7,  // 16th note grid
            0.2, 0.9, 0.1, 0.5, 0.8, 0.1, 0.6, 0.4,
            0.7, 0.3, 0.9, 0.1, 0.2, 0.6, 0.8, 0.1,
            0.4, 0.7, 0.2, 0.9, 0.1, 0.5, 0.3, 0.8
          ];
          
          // Use finer subdivision for IDM feel - check every 32nd
          const subStep = (step * 2) % melodyTriggers.length;
          const melProb = melodyTriggers[subStep] || 0;
          
          if (Math.random() < melProb * wSP * 0.7) {
            // Select kalimba sample based on position and randomness
            const kalimbaIndex = Math.floor((x * 4 + Math.random() * 4)) % S.kalimbas.length;
            const kalimba = S.kalimbas[kalimbaIndex];
            
            kalimba.volume.value = lerp(-16, 0, wSP * melProb);
            // Varied playback rates for more range
            kalimba.start(time);
          }
          
          // Additional polyrhythmic layer on triplet grid
          if (step % 3 === 0 && Math.random() < wSP * 0.3) {
            const tripletKalimba = S.kalimbas[(step / 3) % S.kalimbas.length];
            tripletKalimba.volume.value = lerp(-20, -4, wSP);
            tripletKalimba.start(time + 0.05); // Slight delay for polyrhythm
          }
        } else {
          // Fallback for other worlds
          if (Math.random() < wSP * 0.45) {
            S.leads.sp.volume.value = lerp(-18, -2, wSP);
            S.leads.sp.start(time);
          }
        }

        // Bass: Syncopated pattern with crossfade
        const bassPattern = [1, 0, 0.3, 0, 0.6, 0, 0.2, 0];
        if (bassPattern[beat] && Math.random() < bassPattern[beat] * wSP * 0.8) {
          playBassWithCrossfade(lerp(-20, -4, wSP), time);
        }
      }

      // ═══ HUM+SLEEP: Sparse, meditative with bass melody & middle melody ═══
      if (wSS > 0.15) {
        // Use only bass melody 1 and middle melody 1 for angelxenakis (no original lead)
        if (S.sleepMelodies && worldName === 'angelxenakis') {
          if (beat === 0 && Math.random() < wSS * 0.3) {
            const melodyIndex = Math.floor(Math.random() * S.sleepMelodies.length);
            const melody = S.sleepMelodies[melodyIndex];
            melody.volume.value = lerp(-20, -4, wSS);
            melody.start(time);
          }
        } else {
          // Original vocal lead for other worlds
          if (beat === 0 && Math.random() < wSS * 0.15) {
            S.leads.ss.volume.value = lerp(-22, -6, wSS);
            S.leads.ss.start(time);
          }
        }
        
        if (beat === 0 && step % (STEPS * 4) === 0 && Math.random() < wSS * 0.2) {
          playBassWithCrossfade(lerp(-28, -14, wSS), time);
        }
      }

      // ═══ GLOW+PLAY: Sparkly, airy ═══
      if (wFP > 0.15) {
        if ((beat === 0 || beat === 2 || beat === 4 || beat === 6) && Math.random() < wFP * 0.45) {
          S.bell.volume.value = lerp(-22, -4, wFP);
          S.bell.start(time);
        }
        if ((beat === 3 || beat === 7) && Math.random() < wFP * 0.4) {
          S.rim.volume.value = lerp(-22, -8, wFP);
          S.rim.start(time);
        }
        // Use all glockenspiel samples for variety
        if (Math.random() < wFP * 0.3) {
          if (S.glockenspiels && worldName === 'angelxenakis') {
            const glockIndex = Math.floor(Math.random() * S.glockenspiels.length);
            const glock = S.glockenspiels[glockIndex];
            glock.volume.value = lerp(-20, -4, wFP);
            glock.start(time);
          } else {
            S.leads.fp.volume.value = lerp(-20, -4, wFP);
            S.leads.fp.start(time);
          }
        }
        if (beat === 0 && Math.random() < wFP * 0.3) {
          playBassWithCrossfade(lerp(-24, -12, wFP), time);
        }
      }

      // ═══ GLOW+SLEEP: Deep drone with Saana & bass rumble ═══
      if (wFS > 0.15) {
        // Use only Saana 30sek and bass rumble for angelxenakis (no original lead)
        if (S.ambientSamples && worldName === 'angelxenakis') {
          // Saana 30sek - longer atmospheric sample, less frequent
          if (beat === 0 && step % (STEPS * 8) === 0 && Math.random() < wFS * 0.4) {
            const saana = S.ambientSamples[0]; // Saana 30sek
            saana.volume.value = lerp(-18, -2, wFS);
            saana.start(time);
          }
          
          // Bass rumble - more frequent, drone-like
          if ((beat === 0 || beat === 4) && Math.random() < wFS * 0.5) {
            const rumble = S.ambientSamples[1]; // Bass rumble
            rumble.volume.value = lerp(-16, 0, wFS);
            rumble.start(time);
          }
        } else {
          // Original deep lead for other worlds
          if (beat === 0 && step % (STEPS * 6) === 0 && Math.random() < wFS * 0.25) {
            S.leads.fs.volume.value = lerp(-24, -8, wFS);
            S.leads.fs.start(time);
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

      // Simple world: no FX nodes, sequencer reads yVal directly each tick
      if (world.meta && world.meta.name === 'Simple') {
        sGain.gain.value = world.mix.master;
        return;
      }

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

    isActive: function() { return sStarted; },

    // ═══ Record 15s of mic, extract top 3 transients, replace kick/kickAlt/hihat ═══
    // onState: callback({state:'requesting'|'recording'|'processing'|'done'|'error', message?, progress?})
    recordAndReplaceSamples: async function(durationSec, onState) {
      durationSec = durationSec || 15;
      const report = (s) => { try { onState && onState(s); } catch(_) {} };

      let stream;
      try {
        report({ state: 'requesting' });
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        });
      } catch (err) {
        report({ state: 'error', message: 'Mic permission denied: ' + err.message });
        throw err;
      }

      // Use a fresh AudioContext for capture so we don't fight Tone's context
      const captureCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = captureCtx.createMediaStreamSource(stream);

      // Use ScriptProcessor for max-compat (deprecated but works everywhere reliably enough for 15s capture)
      const bufSize = 4096;
      const proc = captureCtx.createScriptProcessor(bufSize, 1, 1);
      const sampleRate = captureCtx.sampleRate;
      const totalSamples = Math.floor(sampleRate * durationSec);
      const captureBuf = new Float32Array(totalSamples);
      let writeIdx = 0;

      proc.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const remaining = totalSamples - writeIdx;
        if (remaining <= 0) return;
        const n = Math.min(input.length, remaining);
        captureBuf.set(input.subarray(0, n), writeIdx);
        writeIdx += n;
      };

      src.connect(proc);
      proc.connect(captureCtx.destination); // some browsers require this to actually pull data
      // Mute output: route through a zero-gain node
      // (already implicit since we don't actually wire audible feedback; ScriptProcessor needs dest)

      report({ state: 'recording', progress: 0 });

      // Progress ticks
      const startTs = Date.now();
      const progressTimer = setInterval(() => {
        const p = Math.min(1, (Date.now() - startTs) / (durationSec * 1000));
        report({ state: 'recording', progress: p });
      }, 100);

      // Wait for capture
      await new Promise(r => setTimeout(r, durationSec * 1000 + 100));
      clearInterval(progressTimer);

      // Tear down capture
      try { src.disconnect(); proc.disconnect(); } catch(_) {}
      try { stream.getTracks().forEach(t => t.stop()); } catch(_) {}
      try { captureCtx.close(); } catch(_) {}

      report({ state: 'processing' });

      // ═══ Transient detection ═══
      // 1. RMS envelope over short windows
      const hopMs = 5;
      const winMs = 10;
      const hop = Math.max(1, Math.floor(sampleRate * hopMs / 1000));
      const win = Math.max(2, Math.floor(sampleRate * winMs / 1000));
      const nFrames = Math.floor((captureBuf.length - win) / hop);
      const env = new Float32Array(nFrames);
      for (let f = 0; f < nFrames; f++) {
        let sum = 0;
        const start = f * hop;
        for (let i = 0; i < win; i++) {
          const s = captureBuf[start + i];
          sum += s * s;
        }
        env[f] = Math.sqrt(sum / win);
      }

      // 2. Onset function: positive derivative of envelope (rising edges only)
      const onset = new Float32Array(nFrames);
      for (let f = 1; f < nFrames; f++) {
        const d = env[f] - env[f - 1];
        onset[f] = d > 0 ? d : 0;
      }

      // 3. Pick top 3 peaks with min spacing (~150ms) via greedy NMS by strength
      const minSpacingFrames = Math.floor(150 / hopMs);
      const sliceLenSec = 0.2;
      const sliceLenSamples = Math.floor(sampleRate * sliceLenSec);

      // Build list of (frame, strength) sorted by strength desc
      const candidates = [];
      for (let f = 1; f < nFrames - 1; f++) {
        // local peak check
        if (onset[f] > onset[f - 1] && onset[f] >= onset[f + 1] && onset[f] > 0.0005) {
          candidates.push({ frame: f, strength: onset[f] });
        }
      }
      candidates.sort((a, b) => b.strength - a.strength);

      const chosen = [];
      for (const c of candidates) {
        let conflict = false;
        for (const k of chosen) {
          if (Math.abs(c.frame - k.frame) < minSpacingFrames) { conflict = true; break; }
        }
        if (!conflict) {
          // Also need room for a 0.2s slice from this point
          const startSample = c.frame * hop;
          if (startSample + sliceLenSamples > captureBuf.length) continue;
          chosen.push(c);
        }
        if (chosen.length >= 3) break;
      }

      if (chosen.length < 3) {
        report({ state: 'error', message: 'Found only ' + chosen.length + ' transients. Try recording with louder, more distinct hits.' });
        throw new Error('Not enough transients (' + chosen.length + ')');
      }

      // 4. Slice 0.2s windows; apply tiny pre-roll (3ms) so attack isn't cut
      const preRollSamples = Math.floor(sampleRate * 0.003);
      const slices = chosen.map(c => {
        let start = c.frame * hop - preRollSamples;
        if (start < 0) start = 0;
        const end = Math.min(start + sliceLenSamples, captureBuf.length);
        const slice = captureBuf.slice(start, end);
        // Small fade-out (last 5ms) to avoid clicks
        const fadeSamples = Math.min(slice.length, Math.floor(sampleRate * 0.005));
        for (let i = 0; i < fadeSamples; i++) {
          const idx = slice.length - fadeSamples + i;
          slice[idx] *= (1 - i / fadeSamples);
        }
        return { slice, strength: c.strength };
      });

      // 5. Build Tone audio buffers and swap into S.kick / S.kickAlt / S.hihat
      // Strongest → kick, 2nd → kickAlt, 3rd → hihat
      const labels = ['kick', 'kickAlt', 'hihat'];
      for (let i = 0; i < 3; i++) {
        const data = slices[i].slice;
        // Create AudioBuffer in Tone's context
        const toneCtx = Tone.getContext().rawContext;
        const ab = toneCtx.createBuffer(1, data.length, sampleRate);
        ab.getChannelData(0).set(data);

        const newPlayer = new Tone.Player(ab).connect(sGain);
        await Tone.loaded();

        const slot = labels[i];
        try { if (S[slot]) S[slot].dispose(); } catch(_) {}
        S[slot] = newPlayer;
      }

      report({ state: 'done', message: 'Replaced kick / kickAlt / hihat with 3 recorded transients.' });
      return true;
    }
  };
})();