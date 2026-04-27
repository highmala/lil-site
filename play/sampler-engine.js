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