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

  // ═══ Play-event broadcast ═══
  // The UI sets window._samplerEngine.onPlay = (slot, time) => {...} to subscribe.
  // bindSlot() monkey-patches a player's .start so every trigger fires the hook.
  function notifyPlay(slot, time) {
    const eng = window._samplerEngine;
    if (eng && typeof eng.onPlay === 'function') {
      try { eng.onPlay(slot, time); } catch (_) {}
    }
  }
  function bindSlot(player, slot) {
    if (!player || player._slotBound === slot) return player;
    const origStart = player.start.bind(player);
    player.start = function(time) {
      notifyPlay(slot, time);
      return origStart.apply(player, arguments);
    };
    player._slotBound = slot;
    return player;
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


  // ═══ TABBY — LIL's recording/sampling subsystem ═══
  // Tabby is the live-mic record + transient-detect + slot-assign feature. It's
  // designed to be portable: every world that wants user-recorded samples can
  // plug into the same engine surface area:
  //   - window._samplerEngine.recordAndReplaceSamples(durationSec, onState)
  //   - window._samplerEngine.replaceSliceForSlot(slot, frame)
  //   - window._samplerEngine.lastRecording   ({ buffer, sampleRate, chosenSlots, allTransients, hop, sliceLenSec, durationSec })
  //   - window._samplerEngine.onRecording / .onPlay   (UI hooks)
  // The visible UI is the waveform overlay with the "Tabby" badge in the top-left.
  // When adding a new world that needs sampling, just wire its drum players into the
  // same { snare, kick, kickAlt, hihat } slot names and Tabby will work out of the box.
  //
  // ═══ Slice extraction + slot swap (shared by recordAndReplaceSamples & replaceSliceForSlot) ═══
  // Pulls a 200ms window starting at `frame*hop` from the recording buffer, peak-normalizes
  // it to ~-1 dBFS, applies a 5ms fade-out, and returns a Tone.ToneAudioBuffer.
  function extractAndPrepareSlice(buffer, frame, hop, sampleRate) {
    const SLICE_LEN_SEC = 0.2;
    const PREROLL_SEC = 0.003;
    const FADE_SEC = 0.005;
    const NORMALIZE_PEAK = 0.89;   // ~-1 dBFS
    const SILENCE_THRESHOLD = 0.001;

    const sliceLenSamples = Math.floor(sampleRate * SLICE_LEN_SEC);
    const preRollSamples = Math.floor(sampleRate * PREROLL_SEC);
    let start = frame * hop - preRollSamples;
    if (start < 0) start = 0;
    if (start + sliceLenSamples > buffer.length) start = buffer.length - sliceLenSamples;
    if (start < 0) start = 0;
    const end = Math.min(start + sliceLenSamples, buffer.length);
    const slice = buffer.slice(start, end);

    // Peak normalize
    let peak = 0;
    for (let i = 0; i < slice.length; i++) {
      const a = Math.abs(slice[i]);
      if (a > peak) peak = a;
    }
    if (peak > SILENCE_THRESHOLD) {
      const g = NORMALIZE_PEAK / peak;
      for (let i = 0; i < slice.length; i++) slice[i] *= g;
    }

    // 5ms fade-out to avoid clicks
    const fadeSamples = Math.min(slice.length, Math.floor(sampleRate * FADE_SEC));
    for (let i = 0; i < fadeSamples; i++) {
      const idx = slice.length - fadeSamples + i;
      slice[idx] *= (1 - i / fadeSamples);
    }

    const toneCtx = Tone.getContext().rawContext;
    const ab = toneCtx.createBuffer(1, slice.length, sampleRate);
    ab.getChannelData(0).set(slice);
    return new Tone.ToneAudioBuffer(ab);
  }

  // Swaps the player(s) for a given slot to a new Tone.ToneAudioBuffer. Rebuilds the UR slot
  // and (for non-snare slots) also the UL twin + reversed chaos variant + hihat-extras
  // (octave-down + roll pool). Old players are disposed cleanly. Each new player is wrapped
  // with bindSlot so play events still broadcast.
  async function swapSlotFromBuffer(slot, toneBuf) {
    function disposeQuietly(node) { try { if (node) node.dispose(); } catch (_) {} }

    // UR slot
    const urPlayer = new Tone.Player(toneBuf);
    if (slot === 'snare' && S.snareWetSend) {
      urPlayer.fan(sGain, S.snareWetSend);
      urPlayer.volume.value = -4;
    } else {
      urPlayer.connect(sGain);
      urPlayer.volume.value = -5;
    }
    await Tone.loaded();
    disposeQuietly(S[slot]);
    S[slot] = urPlayer;
    bindSlot(urPlayer, slot);
    if (slot === 'snare') S.snareReady = true;

    // UL twin + chaos variants (no UL snare — snare is shared)
    if (slot === 'snare') return;

    const ulSlot = 'ul' + slot.charAt(0).toUpperCase() + slot.slice(1);
    if (S.ulSendBus) {
      const ulPlayer = new Tone.Player(toneBuf);
      ulPlayer.volume.value = -5;
      ulPlayer.fan(sGain, S.ulSendBus);
      disposeQuietly(S[ulSlot]);
      S[ulSlot] = ulPlayer;
      bindSlot(ulPlayer, slot);

      const reverseSlot = ulSlot + 'Reverse';
      if (S[reverseSlot]) {
        const revBuf = toneBuf.slice(0); // clone
        revBuf.reverse = true;
        const revPlayer = new Tone.Player(revBuf);
        revPlayer.volume.value = -5;
        revPlayer.fan(sGain, S.ulSendBus);
        disposeQuietly(S[reverseSlot]);
        S[reverseSlot] = revPlayer;
        bindSlot(revPlayer, slot);
      }

      if (slot === 'hihat') {
        if (S.ulHihatLow) {
          const low = new Tone.Player(toneBuf);
          low.playbackRate = 0.5;
          low.volume.value = -5;
          low.fan(sGain, S.ulSendBus);
          disposeQuietly(S.ulHihatLow);
          S.ulHihatLow = low;
          bindSlot(low, 'hihat');
        }
        if (S.ulHihatRollPool && S.ulHihatRollPool.length) {
          const poolSize = S.ulHihatRollPool.length;
          for (const p of S.ulHihatRollPool) disposeQuietly(p);
          S.ulHihatRollPool = [];
          for (let j = 0; j < poolSize; j++) {
            const rp = new Tone.Player(toneBuf);
            rp.volume.value = -5;
            rp.fan(sGain, S.ulSendBus);
            bindSlot(rp, 'hihat');
            S.ulHihatRollPool.push(rp);
          }
        }
      }
    }
    await Tone.loaded();
  }

  async function initSimple1(worldName) {
    console.log('[sampler] init SIMPLE1 world (4-quadrant)');

    const resp = await fetch('/play/worlds/' + worldName + '.json');
    if (!resp.ok) throw new Error('World JSON not found: ' + resp.status);
    world = await resp.json();
    console.log('[sampler] world loaded:', world.meta.name);

    // Minimal chain: master gain → destination (no FX)
    sGain = new Tone.Gain(world.mix.master).toDestination();

    const base = '/play/worlds/';

    // UR samples (the original Simple system: 2 kicks + hihat)
    // -5 dB on each to balance against BL sample level
    S.kick    = new Tone.Player(base + 'simple/samples/kick.wav').connect(sGain);
    S.kickAlt = new Tone.Player(base + 'simple/samples/kick-alt.wav').connect(sGain);
    S.hihat   = new Tone.Player(base + 'simple/samples/hihat.wav').connect(sGain);
    S.kick.volume.value    = -5;
    S.kickAlt.volume.value = -5;
    S.hihat.volume.value   = -5;
    bindSlot(S.kick, 'kick'); bindSlot(S.kickAlt, 'kickAlt'); bindSlot(S.hihat, 'hihat');

    // BL system: "charlie" with 10s crossfade loop → lowpass filter → gain → master
    S.blGain   = new Tone.Gain(0).connect(sGain);
    S.blFilter = new Tone.Filter({ frequency: 150, type: 'lowpass', rolloff: -96 }).connect(S.blGain);
    S.blBuffer = await new Tone.ToneAudioBuffer().load(base + 'simple/samples/charlie.mp3');

    // BR system: "soothing rain" with 10s crossfade loop → mirrored filter → gain → master
    S.brGain   = new Tone.Gain(0).connect(sGain);
    S.brFilter = new Tone.Filter({ frequency: 150, type: 'lowpass', rolloff: -96 }).connect(S.brGain);
    S.brBuffer = await new Tone.ToneAudioBuffer().load(base + 'simple/samples/soothing-rain.mp3');

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
    S.ulFxGain = new Tone.Gain(1.0).connect(sGain);
    S.ulReverb = new Tone.Reverb({ decay: 4.0, wet: 0.35 }).connect(S.ulFxGain);
    await S.ulReverb.generate();
    S.ulDelay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.4, wet: 1.0 }).connect(S.ulReverb);
    S.ulFilter = new Tone.Filter({ frequency: 4000, type: 'lowpass', rolloff: -24, Q: 1 }).connect(S.ulDelay);
    // PitchShift in Tone.js uses an internal granular pitch shifter — windowSize IS the grain length.
    S.ulPitchShift = new Tone.PitchShift({ pitch: 0, windowSize: 0.1, feedback: 0.0, delayTime: 0, wet: 1.0 }).connect(S.ulFilter);
    // The send bus: drums tap into this; it feeds the FX chain head.
    S.ulSendBus = new Tone.Gain(0).connect(S.ulPitchShift); // start with send closed; fades open in UL

    // Dedicated UL drum players (separate from UR's, so UR stays dry).
    // Each connects to BOTH master (dry) AND the send bus (wet via FX).
    S.ulKick    = new Tone.Player(base + 'simple/samples/kick.wav');
    S.ulKickAlt = new Tone.Player(base + 'simple/samples/kick-alt.wav');
    S.ulHihat   = new Tone.Player(base + 'simple/samples/hihat.wav');
    S.ulKick.volume.value    = -5;
    S.ulKickAlt.volume.value = -5;
    S.ulHihat.volume.value   = -5;
    // fan-out: dry path + send tap
    S.ulKick.fan(sGain, S.ulSendBus);
    S.ulKickAlt.fan(sGain, S.ulSendBus);
    S.ulHihat.fan(sGain, S.ulSendBus);
    bindSlot(S.ulKick, 'kick'); bindSlot(S.ulKickAlt, 'kickAlt'); bindSlot(S.ulHihat, 'hihat');

    // ═══ UL corner variants ═══
    // Build reversed and pitched variants for the corner-chaos probabilities.
    // Buffers are reused; reverse=true on a cloned ToneAudioBuffer gives a backward player.
    await Tone.loaded(); // ensure raw buffers are ready before cloning

    function reversedPlayer(srcBuffer, volumeDb) {
      const buf = srcBuffer.slice(0); // clone
      buf.reverse = true;
      const p = new Tone.Player(buf);
      p.volume.value = volumeDb;
      p.fan(sGain, S.ulSendBus);
      return p;
    }

    S.ulHihatReverse  = reversedPlayer(S.ulHihat.buffer, -5);
    S.ulKickReverse   = reversedPlayer(S.ulKick.buffer, -5);
    S.ulKickAltReverse= reversedPlayer(S.ulKickAlt.buffer, -5);
    bindSlot(S.ulHihatReverse, 'hihat');
    bindSlot(S.ulKickReverse, 'kick');
    bindSlot(S.ulKickAltReverse, 'kickAlt');

    // Octave-down hihat: playbackRate 0.5 (one octave lower).
    S.ulHihatLow = new Tone.Player(base + 'simple/samples/hihat.wav');
    S.ulHihatLow.playbackRate = 0.5;
    S.ulHihatLow.volume.value = -5;
    S.ulHihatLow.fan(sGain, S.ulSendBus);
    bindSlot(S.ulHihatLow, 'hihat');

    // Roll pool: 4 separate hihat players so 4 rapid 32nd hits don't cut each other off.
    S.ulHihatRollPool = [];
    for (let i = 0; i < 4; i++) {
      const p = new Tone.Player(S.ulHihat.buffer);
      p.volume.value = -5;
      p.fan(sGain, S.ulSendBus);
      bindSlot(p, 'hihat');
      S.ulHihatRollPool.push(p);
    }

    await Tone.loaded();
    console.log('[sampler] simple samples loaded');

    // ═══ UR system: kick 16n density (Y) + hihat 32n density (X) ═══
    let urKickStep = 0;
    sLoop = new Tone.Loop(time => {
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;
      if (getActiveQuadrant(x, y) !== 'UR') { urKickStep = (urKickStep + 1) % 16; return; }
      const { ly } = localCoords('UR', x, y);
      const numHits = Math.round(ly * 15) + 1; // 1..16
      if (isHitAtStep(urKickStep, numHits, 16)) {
        const replaceChance = ly * 0.75;
        if (Math.random() < replaceChance) S.kickAlt.start(time);
        else                                S.kick.start(time);
      }
      urKickStep = (urKickStep + 1) % 16;
    }, '16n');

    let urHatStep = 0;
    S.hatLoop = new Tone.Loop(time => {
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;
      if (getActiveQuadrant(x, y) !== 'UR') { urHatStep = (urHatStep + 1) % 32; return; }
      const { lx } = localCoords('UR', x, y);
      const numHits = Math.round(lx * 31) + 1; // 1..32
      if (isHitAtStep(urHatStep, numHits, 32)) {
        S.hihat.start(time);
      }
      urHatStep = (urHatStep + 1) % 32;
    }, '32n');

    // ═══ UL drum sequencers: mirror of UR, running at half tempo (55.5 BPM feel) ═══
    // Global transport stays at 111 BPM so UR is unaffected. UL uses doubled note values
    // (8n / 16n instead of 16n / 32n) so its clock ticks at half the rate → 55.5 BPM equivalent.
    // Corner-chaos probability scaler: 1.0 at far-TL of UL (lx=0, ly=1), 0.0 at far-BR.
    // Uses Chebyshev distance so the influence is square-ish around the corner.
    function ulCornerFactor(lx, ly) {
      const d = Math.max(lx, 1 - ly); // 0 at TL corner, 1 at BR corner
      return Math.max(0, 1 - d);      // 1 at TL, 0 at BR
    }

    // Chaos flag: enabled in Simple2, off in Simple. Read from world JSON.
    const ulChaos = !!(world.ul && world.ul.chaos);

    let ulKickStep = 0;
    S.ulKickLoop = new Tone.Loop(time => {
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;
      if (getActiveQuadrant(x, y) !== 'UL') { ulKickStep = (ulKickStep + 1) % 16; return; }
      const { lx, ly } = localCoords('UL', x, y);
      const numHits = Math.round(ly * 15) + 1; // 1..16
      if (isHitAtStep(ulKickStep, numHits, 16)) {
        const replaceChance = ly * 0.75; // existing kickAlt swap
        const pickAlt = Math.random() < replaceChance;
        // Corner-chaos (Simple2 only): 33% chance (scaled by corner proximity) to play reversed.
        const cornerF = ulChaos ? ulCornerFactor(lx, ly) : 0;
        const reverseChance = 0.33 * cornerF;
        if (Math.random() < reverseChance) {
          if (pickAlt) S.ulKickAltReverse.start(time);
          else         S.ulKickReverse.start(time);
        } else {
          if (pickAlt) S.ulKickAlt.start(time);
          else         S.ulKick.start(time);
        }
      }
      ulKickStep = (ulKickStep + 1) % 16;
    }, '8n'); // half the UR rate → 55.5 BPM feel

    let ulHatStep = 0;
    S.ulHatLoop = new Tone.Loop(time => {
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;
      if (getActiveQuadrant(x, y) !== 'UL') { ulHatStep = (ulHatStep + 1) % 32; return; }
      const { lx, ly } = localCoords('UL', x, y);
      // Mirror: density grows toward the LEFT edge (low lx = high density)
      const mirroredLx = 1 - lx;
      const numHits = Math.round(mirroredLx * 31) + 1; // 1..32
      if (isHitAtStep(ulHatStep, numHits, 32)) {
        if (!ulChaos) {
          S.ulHihat.start(time);
        } else {
          // Corner-chaos (Simple2 only): pick ONE variant via a single dice roll, mutually exclusive.
          // At the TL corner (cornerF=1): 50% reverse, 20% octave-down, 10% roll, 20% normal.
          // Toward BR: probabilities scale down toward 0 (so plain hihat dominates).
          const cornerF = ulCornerFactor(lx, ly);
          const pReverse = 0.50 * cornerF;
          const pOctLow  = 0.20 * cornerF;
          const pRoll    = 0.10 * cornerF;
          const r = Math.random();
          if (r < pReverse) {
            S.ulHihatReverse.start(time);
          } else if (r < pReverse + pOctLow) {
            S.ulHihatLow.start(time);
          } else if (r < pReverse + pOctLow + pRoll) {
            // 4 hits in a row at 32nd-note spacing (in UL's half-time grid).
            // UL hat step is 16n long → spacing = 16n / 4. Use the pool so hits don't truncate.
            const stepDur = Tone.Time('16n').toSeconds();
            const spacing = stepDur / 4;
            for (let i = 0; i < 4; i++) S.ulHihatRollPool[i].start(time + spacing * i);
          } else {
            S.ulHihat.start(time);
          }
        }
      }
      ulHatStep = (ulHatStep + 1) % 32;
    }, '16n'); // half the UR rate → 55.5 BPM feel

    // ═══ UL Portal-style FX controller (driven by xVal/yVal) ═══
    // Runs at ~30Hz, smoothly ramps the send bus level and FX params from current XY.
    // Send level fades to 0 outside UL so the FX tails ring out cleanly.
    let ulActive = false;
    const RAMP = 0.08; // 80ms parameter smoothing
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

      // Send amount: how much drum signal feeds the Portal chain. More FX at the edges,
      // close to dry near the center of UL. Floors at 0.25 so there's always some character.
      const distFromCenter = Math.hypot(lx - 0.5, ly - 0.5) * Math.SQRT2; // 0..1
      const sendAmount = 0.25 + distFromCenter * 0.75; // 0.25..1.0
      S.ulSendBus.gain.rampTo(sendAmount, RAMP);

      // Macro 1 (X): pitch + delay time
      // lx 0 → -12 semis (octave down) | lx 0.5 → 0 | lx 1 → +12 (octave up)
      const pitchSemis = (lx - 0.5) * 2 * 12;
      S.ulPitchShift.pitch = pitchSemis;
      // Delay time morphs from dotted-8th feel (slow swing) to 16th (tight stutter) as X moves
      const delaySec = lerp(0.375, 0.09375, Math.abs(lx - 0.5) * 2); // 8n. -> 16n at edges
      S.ulDelay.delayTime.rampTo(delaySec, RAMP);

      // Macro 2 (Y): grain window size + feedback + filter + reverb wet
      // ly 0 → small window 30ms (glitchy granular), low feedback, dark/dry
      // ly 1 → large window 200ms (smeared), high feedback, bright/washy
      const windowSize = lerp(0.03, 0.2, ly);
      S.ulPitchShift.windowSize = windowSize;
      const delayFb = lerp(0.3, 0.7, ly);
      const filterFreq = lerp(800, 9000, ly);
      const reverbWet = lerp(0.2, 0.6, ly);

      S.ulDelay.feedback.rampTo(delayFb, RAMP);
      S.ulFilter.frequency.rampTo(filterFreq, RAMP);
      S.ulReverb.wet.rampTo(reverbWet, RAMP);
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

    startCrossfadeLooper(S.blBuffer, S.blFilter, 10, 5,  'BL/charlie');
    startCrossfadeLooper(S.brBuffer, S.brFilter, 10, -6, 'BR/rain');

    Tone.getTransport().bpm.value = world.tempo.play;
    Tone.getTransport().start();

    sStarted = true;
    console.log('[sampler] simple 4-quadrant sequencer running: UR drums @', world.tempo.play, 'bpm | UL drums @', (world.tempo.play/2).toFixed(1), 'bpm → Portal-style FX send | BL + BR ambient active');
    return true;
  }
  async function initSimple2(worldName) {
    console.log('[sampler] init SIMPLE2 world (4-quadrant)');

    const resp = await fetch('/play/worlds/' + worldName + '.json');
    if (!resp.ok) throw new Error('World JSON not found: ' + resp.status);
    world = await resp.json();
    console.log('[sampler] world loaded:', world.meta.name);

    // Minimal chain: master gain → destination (no FX)
    sGain = new Tone.Gain(world.mix.master).toDestination();

    const base = '/play/worlds/';

    // UR samples (the original Simple system: 2 kicks + hihat)
    // -5 dB on each to balance against BL sample level
    S.kick    = new Tone.Player(base + 'simple/samples/kick.wav').connect(sGain);
    S.kickAlt = new Tone.Player(base + 'simple/samples/kick-alt.wav').connect(sGain);
    S.hihat   = new Tone.Player(base + 'simple/samples/hihat.wav').connect(sGain);
    S.kick.volume.value    = -5;
    S.kickAlt.volume.value = -5;
    S.hihat.volume.value   = -5;
    bindSlot(S.kick, 'kick'); bindSlot(S.kickAlt, 'kickAlt'); bindSlot(S.hihat, 'hihat');

    // BL system: "charlie" with 10s crossfade loop → lowpass filter → gain → master
    S.blGain   = new Tone.Gain(0).connect(sGain);
    S.blFilter = new Tone.Filter({ frequency: 150, type: 'lowpass', rolloff: -96 }).connect(S.blGain);
    S.blBuffer = await new Tone.ToneAudioBuffer().load(base + 'simple/samples/charlie.mp3');

    // BR system: "soothing rain" with 10s crossfade loop → mirrored filter → gain → master
    S.brGain   = new Tone.Gain(0).connect(sGain);
    S.brFilter = new Tone.Filter({ frequency: 150, type: 'lowpass', rolloff: -96 }).connect(S.brGain);
    S.brBuffer = await new Tone.ToneAudioBuffer().load(base + 'simple/samples/soothing-rain.mp3');

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
    S.ulFxGain = new Tone.Gain(1.0).connect(sGain);
    S.ulReverb = new Tone.Reverb({ decay: 4.0, wet: 0.35 }).connect(S.ulFxGain);
    await S.ulReverb.generate();
    S.ulDelay = new Tone.FeedbackDelay({ delayTime: '8n.', feedback: 0.4, wet: 1.0 }).connect(S.ulReverb);
    S.ulFilter = new Tone.Filter({ frequency: 4000, type: 'lowpass', rolloff: -24, Q: 1 }).connect(S.ulDelay);
    // PitchShift in Tone.js uses an internal granular pitch shifter — windowSize IS the grain length.
    S.ulPitchShift = new Tone.PitchShift({ pitch: 0, windowSize: 0.1, feedback: 0.0, delayTime: 0, wet: 1.0 }).connect(S.ulFilter);
    // The send bus: drums tap into this; it feeds the FX chain head.
    S.ulSendBus = new Tone.Gain(0).connect(S.ulPitchShift); // start with send closed; fades open in UL

    // Dedicated UL drum players (separate from UR's, so UR stays dry).
    // Each connects to BOTH master (dry) AND the send bus (wet via FX).
    S.ulKick    = new Tone.Player(base + 'simple/samples/kick.wav');
    S.ulKickAlt = new Tone.Player(base + 'simple/samples/kick-alt.wav');
    S.ulHihat   = new Tone.Player(base + 'simple/samples/hihat.wav');
    S.ulKick.volume.value    = -5;
    S.ulKickAlt.volume.value = -5;
    S.ulHihat.volume.value   = -5;
    // fan-out: dry path + send tap
    S.ulKick.fan(sGain, S.ulSendBus);
    S.ulKickAlt.fan(sGain, S.ulSendBus);
    S.ulHihat.fan(sGain, S.ulSendBus);
    bindSlot(S.ulKick, 'kick'); bindSlot(S.ulKickAlt, 'kickAlt'); bindSlot(S.ulHihat, 'hihat');

    // ═══ UL corner variants ═══
    // Build reversed and pitched variants for the corner-chaos probabilities.
    // Buffers are reused; reverse=true on a cloned ToneAudioBuffer gives a backward player.
    await Tone.loaded(); // ensure raw buffers are ready before cloning

    function reversedPlayer(srcBuffer, volumeDb) {
      const buf = srcBuffer.slice(0); // clone
      buf.reverse = true;
      const p = new Tone.Player(buf);
      p.volume.value = volumeDb;
      p.fan(sGain, S.ulSendBus);
      return p;
    }

    S.ulHihatReverse  = reversedPlayer(S.ulHihat.buffer, -5);
    S.ulKickReverse   = reversedPlayer(S.ulKick.buffer, -5);
    S.ulKickAltReverse= reversedPlayer(S.ulKickAlt.buffer, -5);
    bindSlot(S.ulHihatReverse, 'hihat');
    bindSlot(S.ulKickReverse, 'kick');
    bindSlot(S.ulKickAltReverse, 'kickAlt');

    // Octave-down hihat: playbackRate 0.5 (one octave lower).
    S.ulHihatLow = new Tone.Player(base + 'simple/samples/hihat.wav');
    S.ulHihatLow.playbackRate = 0.5;
    S.ulHihatLow.volume.value = -5;
    S.ulHihatLow.fan(sGain, S.ulSendBus);
    bindSlot(S.ulHihatLow, 'hihat');

    // Roll pool: 4 separate hihat players so 4 rapid 32nd hits don't cut each other off.
    S.ulHihatRollPool = [];
    for (let i = 0; i < 4; i++) {
      const p = new Tone.Player(S.ulHihat.buffer);
      p.volume.value = -5;
      p.fan(sGain, S.ulSendBus);
      bindSlot(p, 'hihat');
      S.ulHihatRollPool.push(p);
    }

    // ═══ Snare zone (horizontal stripe, Simple2 only) ═══
    // Pointer y ∈ [0.60, 0.72]: when inside this band, drum sequencers get a 25%
    // backbeat-snare chance. Spans full width (both UL + UR feed it).
    // TR-808Snare07 routed dry + parallel heavy reverb send (50% per-hit chance).
    const SNARE_Y_LO = 0.60;
    const SNARE_Y_HI = 0.72;
    function inSnareZone(y) { return y >= SNARE_Y_LO && y <= SNARE_Y_HI; }

    // Heavy reverb on a parallel bus; the snare fans into both dry (sGain) and wet (this bus).
    S.snareReverb = new Tone.Reverb({ decay: 6.0, wet: 1.0, preDelay: 0.02 }).connect(sGain);
    await S.snareReverb.generate();
    // Wet-send gain: toggled 0 or 1 right before each snare hit to gate the reverb tail in/out.
    S.snareWetSend = new Tone.Gain(0).connect(S.snareReverb);

    // Snare player. Pre-flight HEAD to detect whether TR-808Snare07.wav is deployed yet;
    // if 404, skip loading so the engine doesn't hang on a missing buffer.
    S.snareReady = false;
    const snareUrl = base + 'simple/samples/TR-808Snare07.wav';
    try {
      const head = await fetch(snareUrl, { method: 'HEAD' });
      if (head.ok) {
        S.snare = new Tone.Player(snareUrl);
        S.snare.volume.value = -4;
        S.snare.fan(sGain, S.snareWetSend);
        bindSlot(S.snare, 'snare');
        // Tone.loaded() resolves when all in-flight buffers are ready.
        await Tone.loaded();
        S.snareReady = true;
        console.log('[sampler] TR-808Snare07 loaded.');
      } else {
        console.warn('[sampler] TR-808Snare07.wav not deployed (HTTP', head.status, '). Snare zone will be silent until you drop the file at play/worlds/simple/samples/TR-808Snare07.wav.');
      }
    } catch (e) {
      console.warn('[sampler] TR-808Snare07.wav probe failed; snare zone disabled. Error:', e);
    }

    function fireSnare(time) {
      if (!S.snareReady || !S.snare) return;
      // 50% chance: also open the wet reverb send for this hit.
      const withReverb = Math.random() < 0.5;
      S.snareWetSend.gain.cancelScheduledValues(time);
      S.snareWetSend.gain.setValueAtTime(withReverb ? 1.0 : 0.0, time);
      // Close the send shortly after so subsequent hits don't bleed; reverb tail still rings.
      S.snareWetSend.gain.setValueAtTime(0.0, time + 0.4);
      S.snare.start(time);
    }

    // ═══ Thailand birds (UR-only one-shot with diagonal volume + delay-time gradient) ═══
    //   Chain: Player → FeedbackDelay → Gain → master
    //   When pointer is in UR:
    //     volume     = blend along UR's inner-BL → outer-TR diagonal (0 → 1)
    //     delay time = same blend, mapped 0.05s → 2.0s
    //   Plays start-to-finish per UR entry: retriggers from 0 once the previous playthrough
    //   has ended (so re-entering UR mid-play doesn't restart; re-entering after end does).
    S.thaiBirdsReady = false;
    S.thaiBirdsPlaying = false;
    const thaiUrl = base + 'simple/samples/thailand-birds.mp3';
    try {
      const head = await fetch(thaiUrl, { method: 'HEAD' });
      if (head.ok) {
        // ═══ Ableton-style stereo delay (custom-built) ═══
        // PingPong topology with cross-coupled feedback, plus filtered+saturated feedback
        // loops for analog warmth and dub-style high/low cuts on each repeat. Subtle LFO
        // on the delay time gives chorus-like wobble even when the ball is stationary.
        //
        // Topology per channel (mirror for R):
        //   in → splitter[L] → delayL ─┬→ wet outL
        //                            │
        //                   fbHpL ← fbLpL ← (saturation) ← fbGainL
        //                            │
        //                            └→ delayR.input  (cross-coupled → ping-pong)
        //
        // A single shared `delayTime` Signal fans out to both delayL and delayR so the
        // pitch-wobble ramp logic below stays unchanged.
        function buildAbletonStyleDelay({
          delayTime = 0.5,
          maxDelay  = 2.5,
          feedback  = 0.55,    // medium-heavy
          wet       = 0.65,
          hpHz      = 80,      // remove low-end mud from feedback
          lpHz      = 5500,    // remove harsh top from feedback
          driveAmt  = 0.18,    // subtle saturation for warmth
          lfoHz     = 0.22,    // very slow modulation
          lfoDepth  = 0.0015   // ±1.5ms wobble
        } = {}) {
          // I/O
          const inputGain  = new Tone.Gain(1);
          const wetOut     = new Tone.Gain(wet);
          const dryOut     = new Tone.Gain(1 - Math.min(0.7, wet)); // crude dry-trim
          const output     = new Tone.Gain(1);

          // Stereo split + merge
          const splitter   = new Tone.Split();
          const mergerWet  = new Tone.Merge();

          // Per-channel delays
          const delayL = new Tone.Delay({ delayTime, maxDelay });
          const delayR = new Tone.Delay({ delayTime, maxDelay });

          // Feedback chains (filter + saturation + gain) — one per channel
          function buildFbChain() {
            const hp    = new Tone.Filter({ frequency: hpHz, type: 'highpass', rolloff: -12 });
            const lp    = new Tone.Filter({ frequency: lpHz, type: 'lowpass',  rolloff: -12 });
            const drive = new Tone.Distortion({ distortion: driveAmt, oversample: '2x', wet: 0.6 });
            const fbG   = new Tone.Gain(feedback);
            hp.chain(lp, drive, fbG);
            return { input: hp, output: fbG, hp, lp, drive, fbG };
          }
          const fbL = buildFbChain();
          const fbR = buildFbChain();

          // Routing — input split into L/R delays
          inputGain.connect(splitter);
          splitter.connect(delayL, 0); // left channel → delayL
          splitter.connect(delayR, 1); // right channel → delayR

          // Cross-coupled feedback (this is what creates ping-pong)
          //   delayL out → fbL chain → delayR input
          //   delayR out → fbR chain → delayL input
          delayL.connect(fbL.input);
          fbL.output.connect(delayR);
          delayR.connect(fbR.input);
          fbR.output.connect(delayL);

          // Wet path: each delay output → a channel of the wet merger
          delayL.connect(mergerWet, 0, 0);
          delayR.connect(mergerWet, 0, 1);
          mergerWet.connect(wetOut);

          // Dry path (parallel)
          inputGain.connect(dryOut);

          // Sum to output
          wetOut.connect(output);
          dryOut.connect(output);

          // Shared delayTime control: a Signal that fans to both delays' delayTime AudioParams.
          // Ramping this Signal is what produces the tape-style pitch wobble (Doppler on read head).
          const delayTimeSignal = new Tone.Signal({ value: delayTime, units: 'time' });
          delayTimeSignal.connect(delayL.delayTime);
          delayTimeSignal.connect(delayR.delayTime);

          // Subtle modulation LFO — adds character even when delayTime is steady.
          const lfo = new Tone.LFO({ frequency: lfoHz, min: -lfoDepth, max: lfoDepth, type: 'sine' });
          lfo.connect(delayL.delayTime);
          lfo.connect(delayR.delayTime);
          lfo.start();

          return {
            input: inputGain,
            output,
            delayTime: delayTimeSignal,
            feedback: fbL.fbG.gain,        // expose for dynamic tweaks if needed
            _nodes: { delayL, delayR, fbL, fbR, splitter, mergerWet, wetOut, dryOut, lfo, delayTimeSignal }
          };
        }

        S.thaiBirdsGain = new Tone.Gain(0).connect(sGain);
        // ═══ Delay disabled on TR (UR) corner per user request 2026-05-28 ═══
        // Birds now route directly to the master gain — clean, no echoes, no pitch wobble.
        // The buildAbletonStyleDelay helper is preserved above so it can be re-enabled
        // by reconnecting `S.thaiBirds → S.thaiBirdsDelay.input → S.thaiBirdsGain`.
        S.thaiBirdsDelay = null; // sentinel — controller below checks for this

        S.thaiBirds = new Tone.Player({
          url: thaiUrl,
          loop: false,
          onstop: () => { S.thaiBirdsPlaying = false; }
        }).connect(S.thaiBirdsGain);
        await Tone.loaded();
        S.thaiBirdsReady = true;
        console.log('[sampler] thailand-birds loaded (delay bypassed — dry signal only).');
      } else {
        console.warn('[sampler] thailand-birds.mp3 not deployed (HTTP', head.status, '). UR bird layer silent until you drop the file at play/worlds/simple/samples/thailand-birds.mp3.');
      }
    } catch (e) {
      console.warn('[sampler] thailand-birds.mp3 probe failed; UR bird layer disabled. Error:', e);
    }

    await Tone.loaded();
    console.log('[sampler] simple samples loaded');

    // ═══ UR system: kick 16n density (Y) + hihat 32n density (X) ═══
    let urKickStep = 0;
    sLoop = new Tone.Loop(time => {
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;
      if (getActiveQuadrant(x, y) !== 'UR') { urKickStep = (urKickStep + 1) % 16; return; }
      const { ly } = localCoords('UR', x, y);
      const numHits = Math.round(ly * 15) + 1; // 1..16
      if (isHitAtStep(urKickStep, numHits, 16)) {
        const replaceChance = ly * 0.75;
        if (Math.random() < replaceChance) S.kickAlt.start(time);
        else                                S.kick.start(time);
      }
      // Backbeat snare (steps 4 and 12 in a 16-step 16n bar): 25% in the snare zone.
      if ((urKickStep === 4 || urKickStep === 12) && inSnareZone(y) && Math.random() < 0.25) {
        fireSnare(time);
      }
      urKickStep = (urKickStep + 1) % 16;
    }, '16n');

    let urHatStep = 0;
    S.hatLoop = new Tone.Loop(time => {
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;
      if (getActiveQuadrant(x, y) !== 'UR') { urHatStep = (urHatStep + 1) % 32; return; }
      const { lx } = localCoords('UR', x, y);
      const numHits = Math.round(lx * 31) + 1; // 1..32
      if (isHitAtStep(urHatStep, numHits, 32)) {
        S.hihat.start(time);
      }
      urHatStep = (urHatStep + 1) % 32;
    }, '32n');

    // ═══ UL drum sequencers: mirror of UR, running at half tempo (55.5 BPM feel) ═══
    // Global transport stays at 111 BPM so UR is unaffected. UL uses doubled note values
    // (8n / 16n instead of 16n / 32n) so its clock ticks at half the rate → 55.5 BPM equivalent.
    // Corner-chaos probability scaler: 1.0 at far-TL of UL (lx=0, ly=1), 0.0 at far-BR.
    // Uses Chebyshev distance so the influence is square-ish around the corner.
    function ulCornerFactor(lx, ly) {
      const d = Math.max(lx, 1 - ly); // 0 at TL corner, 1 at BR corner
      return Math.max(0, 1 - d);      // 1 at TL, 0 at BR
    }

    // Chaos flag: enabled in Simple2, off in Simple. Read from world JSON.
    const ulChaos = !!(world.ul && world.ul.chaos);

    let ulKickStep = 0;
    S.ulKickLoop = new Tone.Loop(time => {
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;
      if (getActiveQuadrant(x, y) !== 'UL') { ulKickStep = (ulKickStep + 1) % 16; return; }
      const { lx, ly } = localCoords('UL', x, y);
      const numHits = Math.round(ly * 15) + 1; // 1..16
      if (isHitAtStep(ulKickStep, numHits, 16)) {
        const replaceChance = ly * 0.75; // existing kickAlt swap
        const pickAlt = Math.random() < replaceChance;
        // Corner-chaos (Simple2 only): 33% chance (scaled by corner proximity) to play reversed.
        const cornerF = ulChaos ? ulCornerFactor(lx, ly) : 0;
        const reverseChance = 0.33 * cornerF;
        if (Math.random() < reverseChance) {
          if (pickAlt) S.ulKickAltReverse.start(time);
          else         S.ulKickReverse.start(time);
        } else {
          if (pickAlt) S.ulKickAlt.start(time);
          else         S.ulKick.start(time);
        }
      }
      // Backbeat snare (steps 4 and 12 in UL's 16-step 8n bar): 25% in the snare zone.
      // Same stripe spans UL too — fires at UL's half-time backbeat positions.
      if ((ulKickStep === 4 || ulKickStep === 12) && inSnareZone(y) && Math.random() < 0.25) {
        fireSnare(time);
      }
      ulKickStep = (ulKickStep + 1) % 16;
    }, '8n'); // half the UR rate → 55.5 BPM feel

    let ulHatStep = 0;
    S.ulHatLoop = new Tone.Loop(time => {
      const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
      const y = (typeof yVal !== 'undefined') ? yVal : 0.5;
      if (getActiveQuadrant(x, y) !== 'UL') { ulHatStep = (ulHatStep + 1) % 32; return; }
      const { lx, ly } = localCoords('UL', x, y);
      // Mirror: density grows toward the LEFT edge (low lx = high density)
      const mirroredLx = 1 - lx;
      const numHits = Math.round(mirroredLx * 31) + 1; // 1..32
      if (isHitAtStep(ulHatStep, numHits, 32)) {
        if (!ulChaos) {
          S.ulHihat.start(time);
        } else {
          // Corner-chaos (Simple2 only): pick ONE variant via a single dice roll, mutually exclusive.
          // At the TL corner (cornerF=1): 50% reverse, 20% octave-down, 10% roll, 20% normal.
          // Toward BR: probabilities scale down toward 0 (so plain hihat dominates).
          const cornerF = ulCornerFactor(lx, ly);
          const pReverse = 0.50 * cornerF;
          const pOctLow  = 0.20 * cornerF;
          const pRoll    = 0.10 * cornerF;
          const r = Math.random();
          if (r < pReverse) {
            S.ulHihatReverse.start(time);
          } else if (r < pReverse + pOctLow) {
            S.ulHihatLow.start(time);
          } else if (r < pReverse + pOctLow + pRoll) {
            // 4 hits in a row at 32nd-note spacing (in UL's half-time grid).
            // UL hat step is 16n long → spacing = 16n / 4. Use the pool so hits don't truncate.
            const stepDur = Tone.Time('16n').toSeconds();
            const spacing = stepDur / 4;
            for (let i = 0; i < 4; i++) S.ulHihatRollPool[i].start(time + spacing * i);
          } else {
            S.ulHihat.start(time);
          }
        }
      }
      ulHatStep = (ulHatStep + 1) % 32;
    }, '16n'); // half the UR rate → 55.5 BPM feel

    // ═══ UL Portal-style FX controller (driven by xVal/yVal) ═══
    // Runs at ~30Hz, smoothly ramps the send bus level and FX params from current XY.
    // Send level fades to 0 outside UL so the FX tails ring out cleanly.
    let ulActive = false;
    const RAMP = 0.08; // 80ms parameter smoothing
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

      // Send amount: how much drum signal feeds the Portal chain. More FX at the edges,
      // close to dry near the center of UL. Floors at 0.25 so there's always some character.
      const distFromCenter = Math.hypot(lx - 0.5, ly - 0.5) * Math.SQRT2; // 0..1
      const sendAmount = 0.25 + distFromCenter * 0.75; // 0.25..1.0
      S.ulSendBus.gain.rampTo(sendAmount, RAMP);

      // Macro 1 (X): pitch + delay time
      // lx 0 → -12 semis (octave down) | lx 0.5 → 0 | lx 1 → +12 (octave up)
      const pitchSemis = (lx - 0.5) * 2 * 12;
      S.ulPitchShift.pitch = pitchSemis;
      // Delay time morphs from dotted-8th feel (slow swing) to 16th (tight stutter) as X moves
      const delaySec = lerp(0.375, 0.09375, Math.abs(lx - 0.5) * 2); // 8n. -> 16n at edges
      S.ulDelay.delayTime.rampTo(delaySec, RAMP);

      // Macro 2 (Y): grain window size + feedback + filter + reverb wet
      // ly 0 → small window 30ms (glitchy granular), low feedback, dark/dry
      // ly 1 → large window 200ms (smeared), high feedback, bright/washy
      const windowSize = lerp(0.03, 0.2, ly);
      S.ulPitchShift.windowSize = windowSize;
      const delayFb = lerp(0.3, 0.7, ly);
      const filterFreq = lerp(800, 9000, ly);
      const reverbWet = lerp(0.2, 0.6, ly);

      S.ulDelay.feedback.rampTo(delayFb, RAMP);
      S.ulFilter.frequency.rampTo(filterFreq, RAMP);
      S.ulReverb.wet.rampTo(reverbWet, RAMP);
    }, 0.033); // ~30Hz

    // ═══ BL / BR systems: handled by crossfade looper + update() filter routing ═══

    sLoop.start(0);
    S.hatLoop.start(0);
    S.ulKickLoop.start(0);
    S.ulHatLoop.start(0);
    S.ulTicker.start(0);

    // ═══ Thailand birds controller: UR-entry trigger + continuous gain/delay-time updates ═══
    if (S.thaiBirdsReady) {
      let urActive = false;
      // Tape-pitch-bend trick: instead of `rampTo` (which keeps cancelling/restarting at
      // every tick), schedule a LINEAR sweep on the raw delayTime AudioParam over exactly
      // one ticker period. That makes the DelayNode's read head move at a rate ≠ 1.0,
      // producing the Doppler-style pitch shift while the ball moves. Faster ball motion
      // → larger ΔdelayTime per tick → deeper pitch wobble. With heavy feedback the wobble
      // also cycles through the tail.
      const TICK_SEC = 0.033;
      const VOL_RAMP = 0.08;
      // Delay disabled on TR (UR) — dtParam is a no-op when S.thaiBirdsDelay is null.
      const dtParam = S.thaiBirdsDelay ? S.thaiBirdsDelay.delayTime : null;
      // Anchor the initial value so the linear ramps have a defined start (if delay present).
      if (dtParam) { try { dtParam.setValueAtTime(0.05, Tone.now()); } catch (_) {} }
      S.thaiBirdsTicker = new Tone.Loop(time => {
        const x = (typeof xVal !== 'undefined') ? xVal : 0.5;
        const y = (typeof yVal !== 'undefined') ? yVal : 0.5;
        const inUR = getActiveQuadrant(x, y) === 'UR';

        if (inUR) {
          // UR local coords: lx,ly ∈ [0,1] with (0,0) = inner BL of UR (global 0.5,0.5)
          //                                       (1,1) = outer TR of UR (global 1,1)
          const { lx, ly } = localCoords('UR', x, y);
          // Diagonal blend from inner-BL (t=0) to outer-TR (t=1).
          const t = (lx + ly) / 2;
          const vol = t;                                       // 0 → 1
          const rate = 0.5 + t * 0.5;                          // 0.5× at inner BL → 1.0× at outer TR

          // Volume: standard smoothed ramp — no pitch consequence, just a clean fade.
          S.thaiBirdsGain.gain.rampTo(vol, VOL_RAMP);

          // Playback rate sweep on the sample itself (separate from the delay-line pitch wobble).
          // In Tone v15.1.22, Player.playbackRate is exposed as a plain number setter (it
          // internally updates the active BufferSource's AudioParam via setValueAtTime).
          // Just assign; the setter does the right thing on each tick. Don't poke `.rampTo`
          // or use `in` here — those throw on primitives.
          const pr = S.thaiBirds.playbackRate;
          if (pr && typeof pr === 'object' && typeof pr.rampTo === 'function') {
            pr.rampTo(rate, VOL_RAMP);
          } else if (pr && typeof pr === 'object') {
            pr.value = rate;
          } else {
            S.thaiBirds.playbackRate = rate;
          }

          // Delay disabled on TR corner — skip the delay-time ramp entirely.
          // (If you re-enable the delay above, restore the dtParam ramp here.)

          // Trigger from start whenever we're in UR and the sample isn't currently
          // playing. Covers both the UR-entry edge AND the case where the sample
          // ran out while we were still in UR (so birds keep cycling indefinitely
          // until the ball leaves UR).
          urActive = true;
          if (!S.thaiBirdsPlaying) {
            try { S.thaiBirds.stop(); } catch (_) {}
            S.thaiBirdsPlaying = true;
            S.thaiBirds.start(time, 0);
          }
        } else {
          // Outside UR: silence the gate; sample keeps playing (or finishes) in background.
          S.thaiBirdsGain.gain.rampTo(0, 0.2);
          urActive = false;
        }
      }, 0.033); // ~30Hz
      S.thaiBirdsTicker.start(0);
    }

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

    startCrossfadeLooper(S.blBuffer, S.blFilter, 10, 5,  'BL/charlie');
    startCrossfadeLooper(S.brBuffer, S.brFilter, 10, -6, 'BR/rain');

    Tone.getTransport().bpm.value = world.tempo.play;
    Tone.getTransport().start();

    sStarted = true;
    console.log('[sampler] simple 4-quadrant sequencer running: UR drums @', world.tempo.play, 'bpm | UL drums @', (world.tempo.play/2).toFixed(1), 'bpm → Portal-style FX send | BL + BR ambient active');
    return true;
  }

  async function init(worldName) {
    if (worldName === 'simple') return initSimple1(worldName);
    if (worldName === 'simple2') return initSimple2(worldName);

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
    // Move a slot's slice to a different frame in the most recent recording.
    // Used by the draggable waveform overlay so users can hand-pick which 200ms window
    // each drum slot uses (vs the algorithmic strongest-transient pick).
    replaceSliceForSlot: async function(slot, frame) {
      const rec = window._samplerEngine.lastRecording;
      if (!rec || !rec.buffer) return false;
      const validSlots = ['snare', 'kick', 'kickAlt', 'hihat'];
      if (!validSlots.includes(slot)) return false;
      // Clamp frame so the slice stays inside the buffer.
      const hop = rec.hop || (rec.chosenSlots && rec.chosenSlots[0] && rec.chosenSlots[0].hop) || 1;
      const sliceLenSamples = Math.floor(rec.sampleRate * (rec.sliceLenSec || 0.2));
      const maxFrame = Math.max(0, Math.floor((rec.buffer.length - sliceLenSamples) / hop));
      const clampedFrame = Math.max(0, Math.min(maxFrame, Math.floor(frame)));
      const toneBuf = extractAndPrepareSlice(rec.buffer, clampedFrame, hop, rec.sampleRate);
      await swapSlotFromBuffer(slot, toneBuf);
      // Update the recording's chosenSlots so the UI redraw reflects the new position.
      const entry = rec.chosenSlots.find(c => c.slot === slot);
      if (entry) entry.frame = clampedFrame;
      else rec.chosenSlots.push({ frame: clampedFrame, hop, strength: 0, slot });
      return true;
    },

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
        sGain.gain.value = world.mix.master;

        const sx = (typeof xVal !== 'undefined') ? xVal : 0.5;
        const sy = (typeof yVal !== 'undefined') ? yVal : 0.5;

        // ═══ Charlie (BL) + Rain (BR) audibility envelopes ═══
        // Each sample has a 2D rectangle defining where it's audible.
        // The rectangles overlap in x ∈ [0.37, 0.66] (the crossfade band).
        //
        //   Charlie:  x ∈ [0,    0.66],  y ∈ [0, 0.68]
        //   Rain:     x ∈ [0.37, 1.00],  y ∈ [0, 0.68]
        //
        // In the x overlap band: equal-power crossfade (cos/sin).
        // Outside the overlap (within each sample's rectangle): full amplitude.
        // Above y=0.68: short soft fade to silence (5% band) to avoid clicks.
        const overlapL = 0.37;
        const overlapR = 0.66;
        const yCap     = 0.68;
        const yFade    = 0.05; // soft top edge

        let blAmp = 0, brAmp = 0;

        // X component
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

        // Y component: full inside [0, yCap], fades out over yFade above yCap, silent further up
        let yAmp = 0;
        if (sy <= yCap) {
          yAmp = 1;
        } else if (sy < yCap + yFade) {
          yAmp = 1 - (sy - yCap) / yFade;
        }

        blAmp = blX * yAmp;
        brAmp = brX * yAmp;

        // BL gain + filter
        if (S.blGain && S.blFilter) {
          S.blGain.gain.rampTo(blAmp, 0.08);
          // Filter follows the original BL-square mapping: BL corner (0,0) → 150 Hz,
          // UR corner of BL square (lx=1, ly=1, i.e. global (0.5, 0.5)) → 20 kHz.
          // Clamp inputs to the BL square so behavior stays predictable outside.
          if (blAmp > 0.001) {
            const clampedX = Math.min(sx, 0.5);
            const clampedY = Math.min(sy, 0.5);
            const lx = Math.max(0, Math.min(1, clampedX * 2));
            const ly = Math.max(0, Math.min(1, clampedY * 2));
            const t = (lx + ly) / 2;
            const cutoff = Math.exp(Math.log(150) + t * (Math.log(20000) - Math.log(150)));
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
            const cutoff = Math.exp(Math.log(150) + t * (Math.log(20000) - Math.log(150)));
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

      // Greedy NMS for the chosen 4-slot assignment (existing behavior).
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
        if (chosen.length >= 4) break;
      }

      // Expanded candidate pool for click-to-pick UI (same NMS rule, larger budget).
      // Each entry has room for a full 0.2s slice; UI shows them as clickable markers.
      // Cap at 32 so the waveform doesn't turn into a forest of markers.
      const allTransients = [];
      for (const c of candidates) {
        let conflict = false;
        for (const k of allTransients) {
          if (Math.abs(c.frame - k.frame) < minSpacingFrames) { conflict = true; break; }
        }
        if (!conflict) {
          const startSample = c.frame * hop;
          if (startSample + sliceLenSamples > captureBuf.length) continue;
          allTransients.push({ frame: c.frame, strength: c.strength });
        }
        if (allTransients.length >= 32) break;
      }

      if (chosen.length < 3) {
        report({ state: 'error', message: 'Found only ' + chosen.length + ' transients. Try recording with louder, more distinct hits.' });
        throw new Error('Not enough transients (' + chosen.length + ')');
      }

      // 4. (Extraction + normalization happens inside extractAndPrepareSlice now.)
      //    We just pass each chosen frame to that helper below.

      // 5. Swap each chosen transient into its slot via the shared helper.
      //    Order in `chosen` (by descending strength):
      //      i=0 → snare (loudest — the impactful backbeat hit)
      //      i=1 → kick   (BD1)
      //      i=2 → kickAlt (BD2)
      //      i=3 → hihat  (quietest)
      const labels = ['snare', 'kick', 'kickAlt', 'hihat'];
      const count = Math.min(chosen.length, 4);
      for (let i = 0; i < count; i++) {
        const toneBuf = extractAndPrepareSlice(captureBuf, chosen[i].frame, hop, sampleRate);
        await swapSlotFromBuffer(labels[i], toneBuf);
      }

      const replaced = labels.slice(0, count).join(' / ');

      // Expose the recording for the UI waveform display.
      // chosenSlots is sorted by descending strength to match labels[0..count-1].
      const chosenSlots = chosen.slice(0, count).map((c, i) => ({
        frame: c.frame, hop, strength: c.strength, slot: labels[i]
      }));
      window._samplerEngine.lastRecording = {
        buffer: captureBuf,
        sampleRate,
        chosenSlots,
        allTransients,   // for click-to-pick UI (markers on the waveform)
        hop,             // shared with chosenSlots so UI can map frame ↔ time
        sliceLenSec,
        durationSec
      };
      try { if (typeof window._samplerEngine.onRecording === 'function') window._samplerEngine.onRecording(window._samplerEngine.lastRecording); } catch(_) {}

      report({ state: 'done', message: 'Replaced ' + replaced + ' on both UR and UL with ' + count + ' recorded transients.' });
      return true;
    }
  };
})();