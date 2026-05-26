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

  // ═══ SIMPLE WORLD: 4-quadrant system ═══
  // Field is divided into 4 quadrants, each with its own independent sequencer logic.
  // Only the quadrant currently containing the pointer is active (others stay silent).
  // Pointer position within a quadrant is remapped to local (lx, ly) ∈ [0,1].
  //
  //   UL (upper-left)   |   UR (upper-right) ← kick density (Y) + hihat density (X)
  //   ------------------+-------------------
  //   BL (bottom-left)  |   BR (bottom-right)
  function getActiveQuadrant(x, y) {
    if (x >= 0.5 && y >= 0.5) return 'UR';
    if (x <  0.5 && y >= 0.5) return 'UL';
    if (x <  0.5 && y <  0.5) return 'BL';
    return 'BR';
  }
  function localCoords(quad, x, y) {
    let lx, ly;
    if (quad === 'UR') { lx = (x - 0.5) * 2; ly = (y - 0.5) * 2; }
    else if (quad === 'UL') { lx = x * 2;       ly = (y - 0.5) * 2; }
    else if (quad === 'BL') { lx = x * 2;       ly = y * 2; }
    else /* BR */          { lx = (x - 0.5) * 2; ly = y * 2; }
    return { lx: Math.max(0, Math.min(1, lx)), ly: Math.max(0, Math.min(1, ly)) };
  }

  // ═══ DEFAULT CONFIG ═══
  // Every tweakable param for the Simple-family worlds lives here.
  // Each world's JSON may override any subset of these via its `config` block;
  // deep-merge happens at init. To diverge two worlds, edit the JSON deltas —
  // do NOT change these defaults if you only want one world to change.
  const DEFAULT_SIMPLE_CONFIG = {
    samples: {
      kick:    'simple/samples/kick.wav',
      kickAlt: 'simple/samples/kick-alt.wav',
      hihat:   'simple/samples/hihat.wav',
      blLoop:  'simple/samples/charlie.mp3',
      brLoop:  'simple/samples/soothing-rain.mp3'
    },
    drums: {
      // per-player volume in dB; applies to both UR and UL drum players.
      kickVolDb: -5, kickAltVolDb: -5, hihatVolDb: -5
    },
    ur: {
      kick: { steps: 16, noteDur: '16n', maxHits: 16, kickAltSwapMaxProb: 0.75 },
      hat:  { steps: 32, noteDur: '32n', maxHits: 32 }
    },
    ul: {
      // half-speed by default (UL note durations = 2x UR's)
      kick: { steps: 16, noteDur: '8n',  maxHits: 16, kickAltSwapMaxProb: 0.75 },
      hat:  { steps: 32, noteDur: '16n', maxHits: 32 },
      // corner-chaos system (opt-in per world)
      chaos: {
        enabled: false,
        // which UL corner is the chaos peak. supported: 'TL', 'TR', 'BL', 'BR'
        corner: 'TL',
        // probabilities AT the peak corner; scale linearly to 0 at opposite corner
        hat:  { reverse: 0.50, octaveDown: 0.20, roll: 0.10, rollHits: 4 },
        kick: { reverse: 0.33 }
      },
      // Portal-style FX send chain on UL
      fx: {
        send: { min: 0.25, max: 1.0 }, // scales with distance from UL center
        pitch: { semis: 12 },           // ±semis at L/R edges of UL
        delay: {
          centerSec: 0.375,             // delay time at lx=0.5
          edgeSec:   0.09375,           // delay time at lx=0 or lx=1
          feedback:  { min: 0.3, max: 0.7 }, // scaled by ly
          initialFb: 0.4,
          initialWet: 1.0,
          initialTime: '8n.'
        },
        filter: {
          freq: { min: 800, max: 9000 }, // lowpass cutoff, scaled by ly
          initialFreq: 4000, rolloff: -24, Q: 1
        },
        reverb: { decay: 4.0, wet: { min: 0.2, max: 0.6 }, initialWet: 0.35 },
        pitchShift: {
          windowSize: { min: 0.03, max: 0.2 }, // grain length, scaled by ly
          initialWindow: 0.1
        },
        rampSec: 0.08 // parameter smoothing
      }
    },
    bl: {
      // 2D audibility rectangle (x,y in 0..1 global coords) and filter range
      rect:   { x0: 0.0, x1: 0.66, y0: 0.0, y1: 0.68 },
      filter: { minHz: 150, maxHz: 20000, type: 'lowpass', rolloff: -96 },
      looper: { fadeSec: 10, volumeDb: 5 }
    },
    br: {
      rect:   { x0: 0.37, x1: 1.0, y0: 0.0, y1: 0.68 },
      filter: { minHz: 150, maxHz: 20000, type: 'lowpass', rolloff: -96 },
      looper: { fadeSec: 10, volumeDb: -6 }
    },
    // BL/BR crossfade and top-edge fade
    blBr: {
      overlapX: { left: 0.37, right: 0.66 },
      yCap: 0.68,
      yFade: 0.05
    }
  };

  function deepMerge(target, source) {
    if (source === null || source === undefined) return target;
    if (Array.isArray(source)) return source.slice();
    if (typeof source !== 'object') return source;
    const out = (target && typeof target === 'object' && !Array.isArray(target)) ? Object.assign({}, target) : {};
    for (const k of Object.keys(source)) {
      out[k] = deepMerge(out[k], source[k]);
    }
    return out;
  }

  async function initSimple(worldName) {
    console.log('[sampler] init SIMPLE world (4-quadrant)');

    const resp = await fetch('/play/worlds/' + worldName + '.json');
    if (!resp.ok) throw new Error('World JSON not found: ' + resp.status);
    world = await resp.json();
    console.log('[sampler] world loaded:', world.meta.name);

    // Deep-merge world.config (world deltas) on top of engine defaults.
    // World JSON's `config` block is the single source of per-world tweaks.
    const cfg = deepMerge(DEFAULT_SIMPLE_CONFIG, world.config || {});
    world._cfg = cfg; // stash for update() to use
    console.log('[sampler] world cfg merged. ul.chaos.enabled =', cfg.ul.chaos.enabled);

    // Minimal chain: master gain → destination (no FX)
    sGain = new Tone.Gain(world.mix.master).toDestination();

    const base = '/play/worlds/';

    // UR samples (the original Simple system: 2 kicks + hihat)
    S.kick    = new Tone.Player(base + cfg.samples.kick).connect(sGain);
    S.kickAlt = new Tone.Player(base + cfg.samples.kickAlt).connect(sGain);
    S.hihat   = new Tone.Player(base + cfg.samples.hihat).connect(sGain);
    S.kick.volume.value    = cfg.drums.kickVolDb;
    S.kickAlt.volume.value = cfg.drums.kickAltVolDb;
    S.hihat.volume.value   = cfg.drums.hihatVolDb;

    // BL system: charlie loop → lowpass filter → gain → master
    S.blGain   = new Tone.Gain(0).connect(sGain);
    S.blFilter = new Tone.Filter({ frequency: cfg.bl.filter.minHz, type: cfg.bl.filter.type, rolloff: cfg.bl.filter.rolloff }).connect(S.blGain);
    S.blBuffer = await new Tone.ToneAudioBuffer().load(base + cfg.samples.blLoop);

    // BR system: rain loop → mirrored filter → gain → master
    S.brGain   = new Tone.Gain(0).connect(sGain);
    S.brFilter = new Tone.Filter({ frequency: cfg.br.filter.minHz, type: cfg.br.filter.type, rolloff: cfg.br.filter.rolloff }).connect(S.brGain);
    S.brBuffer = await new Tone.ToneAudioBuffer().load(base + cfg.samples.brLoop);

    // ═══ UL system: half-tempo drum mirror, with Portal-style granular send FX ═══
    // Architecture: dedicated UL drum players → (dry to master) + (tap into ulSendBus → Portal FX → master).
    // UR drums use their own players, so they stay completely dry and unaffected.
    //
    // Portal FX chain (send return path):
    //   ulSendBus → PitchShift → Filter → FeedbackDelay → Reverb → ulFxGain → master
    //
    // Two Portal-style macros driven by XY when in UL:
    //   X (Macro 1 "Time/Pitch")   : PitchShift detune (±12 semis) + delay time (8n. → 4n)
    //   Y (Macro 2 "Grain Texture"): PitchShift windowSize (granular grain length 0.03..0.2)
    //                                + delay feedback + filter cutoff + reverb wet
    // Send amount also follows distance from UL center (more FX at the edges, dry near center).

    // FX return chain (built bottom-up so each node knows its destination)
    const fxCfg = cfg.ul.fx;
    S.ulFxGain = new Tone.Gain(1.0).connect(sGain);
    S.ulReverb = new Tone.Reverb({ decay: fxCfg.reverb.decay, wet: fxCfg.reverb.initialWet }).connect(S.ulFxGain);
    await S.ulReverb.generate();
    S.ulDelay = new Tone.FeedbackDelay({ delayTime: fxCfg.delay.initialTime, feedback: fxCfg.delay.initialFb, wet: fxCfg.delay.initialWet }).connect(S.ulReverb);
    S.ulFilter = new Tone.Filter({ frequency: fxCfg.filter.initialFreq, type: 'lowpass', rolloff: fxCfg.filter.rolloff, Q: fxCfg.filter.Q }).connect(S.ulDelay);
    // PitchShift in Tone.js uses an internal granular pitch shifter — windowSize IS the grain length.
    S.ulPitchShift = new Tone.PitchShift({ pitch: 0, windowSize: fxCfg.pitchShift.initialWindow, feedback: 0.0, delayTime: 0, wet: 1.0 }).connect(S.ulFilter);
    // The send bus: drums tap into this; it feeds the FX chain head.
    S.ulSendBus = new Tone.Gain(0).connect(S.ulPitchShift); // start with send closed; fades open in UL

    // Dedicated UL drum players (separate from UR's, so UR stays dry).
    // Each connects to BOTH master (dry) AND the send bus (wet via FX).
    S.ulKick    = new Tone.Player(base + cfg.samples.kick);
    S.ulKickAlt = new Tone.Player(base + cfg.samples.kickAlt);
    S.ulHihat   = new Tone.Player(base + cfg.samples.hihat);
    S.ulKick.volume.value    = cfg.drums.kickVolDb;
    S.ulKickAlt.volume.value = cfg.drums.kickAltVolDb;
    S.ulHihat.volume.value   = cfg.drums.hihatVolDb;
    // fan-out: dry path + send tap
    S.ulKick.fan(sGain, S.ulSendBus);
    S.ulKickAlt.fan(sGain, S.ulSendBus);
    S.ulHihat.fan(sGain, S.ulSendBus);

    // ═══ UL corner variants (only built when chaos is enabled) ═══
    await Tone.loaded(); // ensure raw buffers are ready before cloning

    if (cfg.ul.chaos.enabled) {
      function reversedPlayer(srcBuffer, volumeDb) {
        const buf = srcBuffer.slice(0); // clone
        buf.reverse = true;
        const p = new Tone.Player(buf);
        p.volume.value = volumeDb;
        p.fan(sGain, S.ulSendBus);
        return p;
      }

      S.ulHihatReverse   = reversedPlayer(S.ulHihat.buffer,    cfg.drums.hihatVolDb);
      S.ulKickReverse    = reversedPlayer(S.ulKick.buffer,     cfg.drums.kickVolDb);
      S.ulKickAltReverse = reversedPlayer(S.ulKickAlt.buffer,  cfg.drums.kickAltVolDb);

      // Octave-down hihat: playbackRate 0.5.
      S.ulHihatLow = new Tone.Player(base + cfg.samples.hihat);
      S.ulHihatLow.playbackRate = 0.5;
      S.ulHihatLow.volume.value = cfg.drums.hihatVolDb;
      S.ulHihatLow.fan(sGain, S.ulSendBus);

      // Roll pool: N separate hihat players so rapid hits don't cut each other off.
      S.ulHihatRollPool = [];
      const poolSize = cfg.ul.chaos.hat.rollHits || 4;
      for (let i = 0; i < poolSize; i++) {
        const p = new Tone.Player(S.ulHihat.buffer);
        p.volume.value = cfg.drums.hihatVolDb;
        p.fan(sGain, S.ulSendBus);
        S.ulHihatRollPool.push(p);
      }
    }

    await Tone.loaded();
    console.log('[sampler] simple samples loaded');

    // ═══ UR system: density sequencers (kick on Y, hihat on X) ═══
    const urK = cfg.ur.kick;
    const urH = cfg.ur.hat;
    let urKickStep = 0;
    sLoop = new Tone.Loop(time => {
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;
      if (getActiveQuadrant(x, y) !== 'UR') { urKickStep = (urKickStep + 1) % urK.steps; return; }
      const { ly } = localCoords('UR', x, y);
      const numHits = Math.round(ly * (urK.maxHits - 1)) + 1;
      if (isHitAtStep(urKickStep, numHits, urK.steps)) {
        const replaceChance = ly * urK.kickAltSwapMaxProb;
        if (Math.random() < replaceChance) S.kickAlt.start(time);
        else                                S.kick.start(time);
      }
      urKickStep = (urKickStep + 1) % urK.steps;
    }, urK.noteDur);

    let urHatStep = 0;
    S.hatLoop = new Tone.Loop(time => {
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;
      if (getActiveQuadrant(x, y) !== 'UR') { urHatStep = (urHatStep + 1) % urH.steps; return; }
      const { lx } = localCoords('UR', x, y);
      const numHits = Math.round(lx * (urH.maxHits - 1)) + 1;
      if (isHitAtStep(urHatStep, numHits, urH.steps)) {
        S.hihat.start(time);
      }
      urHatStep = (urHatStep + 1) % urH.steps;
    }, urH.noteDur);

    // ═══ UL drum sequencers (config-driven; defaults to half-tempo mirror) ═══
    const ulK = cfg.ul.kick;
    const ulH = cfg.ul.hat;
    const chaosCfg = cfg.ul.chaos;

    // Corner-direction map: where in UL is the chaos peak?
    // Returns a function (lx, ly) → factor in [0,1], 1 at peak, 0 at opposite corner.
    function buildCornerFactor(corner) {
      switch (corner) {
        case 'TL': return (lx, ly) => Math.max(0, 1 - Math.max(lx, 1 - ly));
        case 'TR': return (lx, ly) => Math.max(0, 1 - Math.max(1 - lx, 1 - ly));
        case 'BL': return (lx, ly) => Math.max(0, 1 - Math.max(lx, ly));
        case 'BR': return (lx, ly) => Math.max(0, 1 - Math.max(1 - lx, ly));
        default:   return (lx, ly) => Math.max(0, 1 - Math.max(lx, 1 - ly)); // fallback TL
      }
    }
    const cornerFactorFn = buildCornerFactor(chaosCfg.corner);

    let ulKickStep = 0;
    S.ulKickLoop = new Tone.Loop(time => {
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;
      if (getActiveQuadrant(x, y) !== 'UL') { ulKickStep = (ulKickStep + 1) % ulK.steps; return; }
      const { lx, ly } = localCoords('UL', x, y);
      const numHits = Math.round(ly * (ulK.maxHits - 1)) + 1;
      if (isHitAtStep(ulKickStep, numHits, ulK.steps)) {
        const replaceChance = ly * ulK.kickAltSwapMaxProb;
        const pickAlt = Math.random() < replaceChance;
        const cornerF = chaosCfg.enabled ? cornerFactorFn(lx, ly) : 0;
        const reverseChance = chaosCfg.kick.reverse * cornerF;
        if (chaosCfg.enabled && Math.random() < reverseChance) {
          if (pickAlt) S.ulKickAltReverse.start(time);
          else         S.ulKickReverse.start(time);
        } else {
          if (pickAlt) S.ulKickAlt.start(time);
          else         S.ulKick.start(time);
        }
      }
      ulKickStep = (ulKickStep + 1) % ulK.steps;
    }, ulK.noteDur);

    let ulHatStep = 0;
    S.ulHatLoop = new Tone.Loop(time => {
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;
      if (getActiveQuadrant(x, y) !== 'UL') { ulHatStep = (ulHatStep + 1) % ulH.steps; return; }
      const { lx, ly } = localCoords('UL', x, y);
      // Mirror: density grows toward the LEFT edge (low lx = high density)
      const mirroredLx = 1 - lx;
      const numHits = Math.round(mirroredLx * (ulH.maxHits - 1)) + 1;
      if (isHitAtStep(ulHatStep, numHits, ulH.steps)) {
        if (!chaosCfg.enabled) {
          S.ulHihat.start(time);
        } else {
          const cornerF = cornerFactorFn(lx, ly);
          const pReverse = chaosCfg.hat.reverse    * cornerF;
          const pOctLow  = chaosCfg.hat.octaveDown * cornerF;
          const pRoll    = chaosCfg.hat.roll       * cornerF;
          const r = Math.random();
          if (r < pReverse) {
            S.ulHihatReverse.start(time);
          } else if (r < pReverse + pOctLow) {
            S.ulHihatLow.start(time);
          } else if (r < pReverse + pOctLow + pRoll) {
            // N hits in a row, evenly spaced across one UL hat step.
            const stepDur = Tone.Time(ulH.noteDur).toSeconds();
            const n = chaosCfg.hat.rollHits;
            const spacing = stepDur / n;
            for (let i = 0; i < n; i++) S.ulHihatRollPool[i].start(time + spacing * i);
          } else {
            S.ulHihat.start(time);
          }
        }
      }
      ulHatStep = (ulHatStep + 1) % ulH.steps;
    }, ulH.noteDur);

    // ═══ UL Portal-style FX controller (config-driven) ═══
    let ulActive = false;
    const RAMP = fxCfg.rampSec;
    const lerp = (a, b, t) => a + (b - a) * t;
    S.ulTicker = new Tone.Loop(time => {
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;
      const inUL = getActiveQuadrant(x, y) === 'UL';

      if (inUL && !ulActive) { ulActive = true; }
      else if (!inUL && ulActive) {
        S.ulSendBus.gain.rampTo(0, 0.3);
        ulActive = false;
      }
      if (!inUL) return;

      const { lx, ly } = localCoords('UL', x, y);

      // Send amount: scales with distance from UL center.
      const distFromCenter = Math.hypot(lx - 0.5, ly - 0.5) * Math.SQRT2; // 0..1
      const sendAmount = fxCfg.send.min + distFromCenter * (fxCfg.send.max - fxCfg.send.min);
      S.ulSendBus.gain.rampTo(sendAmount, RAMP);

      // Macro 1 (X): pitch + delay time
      const pitchSemis = (lx - 0.5) * 2 * fxCfg.pitch.semis;
      S.ulPitchShift.pitch = pitchSemis;
      // Delay time: center value at lx=0.5, edge value at lx=0 or 1
      const delaySec = lerp(fxCfg.delay.centerSec, fxCfg.delay.edgeSec, Math.abs(lx - 0.5) * 2);
      S.ulDelay.delayTime.rampTo(delaySec, RAMP);

      // Macro 2 (Y): grain window + feedback + filter + reverb wet
      S.ulPitchShift.windowSize = lerp(fxCfg.pitchShift.windowSize.min, fxCfg.pitchShift.windowSize.max, ly);
      S.ulDelay.feedback.rampTo(lerp(fxCfg.delay.feedback.min, fxCfg.delay.feedback.max, ly), RAMP);
      S.ulFilter.frequency.rampTo(lerp(fxCfg.filter.freq.min, fxCfg.filter.freq.max, ly), RAMP);
      S.ulReverb.wet.rampTo(lerp(fxCfg.reverb.wet.min, fxCfg.reverb.wet.max, ly), RAMP);
    }, 0.033); // ~30Hz

    // ═══ BL / BR systems: handled by crossfade looper + update() filter routing ═══

    sLoop.start(0);
    S.hatLoop.start(0);
    S.ulKickLoop.start(0);
    S.ulHatLoop.start(0);
    S.ulTicker.start(0);

    // ═══ Crossfade looper helper ═══
    // Spawns a fresh Tone.Player every (duration - fadeSec) seconds, each with its own
    // fadeIn/fadeOut envelope. Adjacent cycles overlap by fadeSec, producing a seamless
    // crossfade across the loop boundary. Old players self-dispose after playback.
    function startCrossfadeLooper(buffer, destination, fadeSec, volumeDb, label) {
      const duration = buffer.duration;
      const fade = Math.min(fadeSec, duration * 0.45); // safety
      const cycleLen = duration - fade;
      let nextStart = Tone.now() + 0.2; // small lookahead

      function spawn() {
        const startAt = nextStart;
        const p = new Tone.Player(buffer).connect(destination);
        p.volume.value = volumeDb;
        p.fadeIn = fade;
        p.fadeOut = fade;
        p.start(startAt);
        // schedule disposal a bit after it would naturally stop
        const lifetimeMs = (startAt - Tone.now() + duration + 1) * 1000;
        setTimeout(() => { try { p.dispose(); } catch(_) {} }, lifetimeMs);

        nextStart = startAt + cycleLen;
        const msToNextSpawn = Math.max(0, (nextStart - Tone.now()) * 1000);
        setTimeout(spawn, msToNextSpawn);
      }
      spawn();
      console.log('[sampler] crossfade looper started:', label, 'duration=' + duration.toFixed(1) + 's fade=' + fade + 's');
    }

    startCrossfadeLooper(S.blBuffer, S.blFilter, cfg.bl.looper.fadeSec, cfg.bl.looper.volumeDb, 'BL/' + cfg.samples.blLoop);
    startCrossfadeLooper(S.brBuffer, S.brFilter, cfg.br.looper.fadeSec, cfg.br.looper.volumeDb, 'BR/' + cfg.samples.brLoop);

    Tone.getTransport().bpm.value = world.tempo.play;
    Tone.getTransport().start();

    sStarted = true;
    console.log('[sampler] simple 4-quadrant sequencer running: UR drums @', world.tempo.play, 'bpm | UL drums @', (world.tempo.play/2).toFixed(1), 'bpm → Portal-style FX send | BL + BR ambient active');
    return true;
  }

  async function init(worldName) {
    if (worldName === 'simple' || worldName === 'simple2') return initSimple(worldName);

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

      // Simple world: 4-quadrant routing. UR sequencers self-gate.
      // BL system gets continuous gain + filter modulation here.
      if (world.meta && (world.meta.name === 'Simple' || world.meta.name === 'Simple2')) {
        const cfg = world._cfg || DEFAULT_SIMPLE_CONFIG;
        sGain.gain.value = world.mix.master;

        const sx = (typeof xVal !== 'undefined') ? xVal : 0.5;
        const sy = (typeof yVal !== 'undefined') ? yVal : 0.5;

        // ═══ BL + BR audibility envelopes (config-driven 2D rectangles + crossfade) ═══
        const overlapL = cfg.blBr.overlapX.left;
        const overlapR = cfg.blBr.overlapX.right;
        const yCap     = cfg.blBr.yCap;
        const yFade    = cfg.blBr.yFade;

        let blAmp = 0, brAmp = 0;

        // X component (equal-power crossfade in the overlap band)
        let blX = 0, brX = 0;
        if (sx <= overlapL) {
          blX = 1; brX = 0;
        } else if (sx >= overlapR) {
          blX = 0; brX = 1;
        } else {
          const t = (sx - overlapL) / (overlapR - overlapL); // 0 → 1
          blX = Math.cos(t * Math.PI / 2);
          brX = Math.sin(t * Math.PI / 2);
        }

        // Y component: full inside [0, yCap], fades out over yFade above yCap
        let yAmp = 0;
        if (sy <= yCap) {
          yAmp = 1;
        } else if (sy < yCap + yFade) {
          yAmp = 1 - (sy - yCap) / yFade;
        }

        blAmp = blX * yAmp;
        brAmp = brX * yAmp;

        // BL gain + filter (cutoff sweep from BL corner to inner corner of BL square)
        if (S.blGain && S.blFilter) {
          S.blGain.gain.rampTo(blAmp, 0.08);
          if (blAmp > 0.001) {
            const clampedX = Math.min(sx, 0.5);
            const clampedY = Math.min(sy, 0.5);
            const lx = Math.max(0, Math.min(1, clampedX * 2));
            const ly = Math.max(0, Math.min(1, clampedY * 2));
            const t = (lx + ly) / 2;
            const fMin = cfg.bl.filter.minHz, fMax = cfg.bl.filter.maxHz;
            const cutoff = Math.exp(Math.log(fMin) + t * (Math.log(fMax) - Math.log(fMin)));
            S.blFilter.frequency.rampTo(cutoff, 0.05);
          }
        }

        // BR gain + filter (mirrored along anti-diagonal of BR square)
        if (S.brGain && S.brFilter) {
          S.brGain.gain.rampTo(brAmp, 0.08);
          if (brAmp > 0.001) {
            const clampedX = Math.max(sx, 0.5);
            const clampedY = Math.min(sy, 0.5);
            const lx = Math.max(0, Math.min(1, (clampedX - 0.5) * 2));
            const ly = Math.max(0, Math.min(1, clampedY * 2));
            const t = ((1 - lx) + ly) / 2;
            const fMin = cfg.br.filter.minHz, fMax = cfg.br.filter.maxHz;
            const cutoff = Math.exp(Math.log(fMin) + t * (Math.log(fMax) - Math.log(fMin)));
            S.brFilter.frequency.rampTo(cutoff, 0.05);
          }
        }
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
        newPlayer.volume.value = -5; // match UR drum balance
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