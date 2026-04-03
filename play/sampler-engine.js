// ═══ SAMPLER-BASED AUDIO ENGINE ═══
// Loads world config + samples instead of using synthesis

let currentWorld = null;
let samplerInstruments = {};
let masterGain, masterReverb, masterDelay, masterFilter;
let mainLoop, audioStarted = false;

async function loadWorld(worldName) {
  try {
    const response = await fetch(`worlds/${worldName}.json`);
    const world = await response.json();
    console.log(`Loading world: ${world.meta.name} by ${world.meta.artist}`);
    
    // Load all samples
    await loadSamples(world);
    currentWorld = world;
    
    // Update UI colors
    updateWorldColors(world.colors);
    
    return world;
  } catch (err) {
    console.error(`Failed to load world ${worldName}:`, err);
    return null;
  }
}

async function loadSamples(world) {
  const samples = world.samples;
  samplerInstruments = {};
  
  // Melody sampler - loads all note samples
  const melodyUrls = {};
  const notes = ['C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'D5', 'E5'];
  for (const note of notes) {
    const url = samples.melody.replace('{note}', note);
    melodyUrls[note] = `worlds/${url}`;
  }
  
  samplerInstruments.melody = new Tone.Sampler(melodyUrls);
  samplerInstruments.bell = new Tone.Player(`worlds/${samples.bell}`);
  
  // Pad - can be multiple samples for variety
  if (Array.isArray(samples.pad)) {
    samplerInstruments.pad = samples.pad.map(url => new Tone.Player(`worlds/${url}`));
  } else {
    samplerInstruments.pad = [new Tone.Player(`worlds/${samples.pad}`)];
  }
  
  // Bass - note-based like melody
  const bassUrls = {};
  const bassNotes = ['C2', 'F2']; // Just need a few bass notes
  for (const note of bassNotes) {
    const url = samples.bass.replace('{note}', note);
    bassUrls[note] = `worlds/${url}`;
  }
  samplerInstruments.bass = new Tone.Sampler(bassUrls);
  
  // Rhythm samples
  samplerInstruments.kick = new Tone.Player(`worlds/${samples.kick}`);
  samplerInstruments.hat = new Tone.Player(`worlds/${samples.hat}`);
  samplerInstruments.rim = new Tone.Player(`worlds/${samples.rim}`);
  
  // Atmosphere loop
  samplerInstruments.atmosphere = new Tone.Player(`worlds/${samples.atmosphere}`);
  samplerInstruments.atmosphere.loop = true;
  
  console.log('Samples loaded:', Object.keys(samplerInstruments));
}

function connectSamplers() {
  if (!masterGain) return;
  
  // Connect all samplers to the FX chain
  Object.values(samplerInstruments).forEach(instrument => {
    if (Array.isArray(instrument)) {
      instrument.forEach(player => player.connect(masterGain));
    } else {
      instrument.connect(masterGain);
    }
  });
}

function updateWorldColors(colors) {
  // Update CSS custom properties for world colors
  document.documentElement.style.setProperty('--color-sp', colors.sp);
  document.documentElement.style.setProperty('--color-fp', colors.fp);
  document.documentElement.style.setProperty('--color-ss', colors.ss);
  document.documentElement.style.setProperty('--color-fs', colors.fs);
}

function getWorldChord(x, y) {
  if (!currentWorld) return null;
  
  // Use same corner logic but with world-specific chord progressions
  const corners = currentWorld.corners;
  let cornerChords;
  
  if (x < 0.5 && y >= 0.5) cornerChords = corners.sp; // hum+play
  else if (x < 0.5 && y < 0.5) cornerChords = corners.ss; // hum+sleep
  else if (x >= 0.5 && y >= 0.5) cornerChords = corners.fp; // glow+play
  else cornerChords = corners.fs; // glow+sleep
  
  return cornerChords;
}

async function startSamplerAudio() {
  await Tone.start();
  
  // Check for world parameter in URL
  const params = new URLSearchParams(window.location.search);
  const worldName = params.get('world') || 'default';
  
  if (worldName === 'default') {
    // Fallback to synth engine
    console.log('Using synth engine (no world specified)');
    return startAudio(); // Call original synth function
  }
  
  // Load the world
  await loadWorld(worldName);
  if (!currentWorld) {
    console.error('World loading failed, falling back to synth');
    return startAudio();
  }
  
  // Create FX chain
  masterReverb = new Tone.Reverb({ decay: currentWorld.fx.decayMin, wet: 0.3 }).toDestination();
  masterDelay = new Tone.FeedbackDelay({ 
    delayTime: '8n.', 
    feedback: currentWorld.fx.fbMin, 
    wet: 0.05 
  }).connect(masterReverb);
  masterFilter = new Tone.Filter({ 
    frequency: currentWorld.fx.filtMax, 
    type: 'lowpass', 
    rolloff: -12 
  }).connect(masterDelay);
  masterGain = new Tone.Gain(currentWorld.mix.master).connect(masterFilter);
  
  // Connect samplers
  connectSamplers();
  
  // Start atmosphere loop
  if (samplerInstruments.atmosphere) {
    samplerInstruments.atmosphere.volume.value = -20;
    samplerInstruments.atmosphere.start();
  }
  
  audioStarted = true;
  startAudioControlLoop();
  
  console.log(`Sampler engine started with world: ${currentWorld.meta.name}`);
}

function updateSamplerAudio() {
  if (!audioStarted || !currentWorld || isMuted) return;
  
  const x = xVal, y = yVal;
  const world = currentWorld;
  
  // Update tempo and FX based on world settings
  Tone.getTransport().bpm.value = lerp(world.tempo.sleep, world.tempo.play, y) * lerp(1.0, world.tempo.glowMult, x);
  
  masterReverb.wet.value = Math.min(lerp(0.1, 0.6, x) + lerp(0.2, 0, y), 0.8);
  masterDelay.wet.value = lerp(0.03, 0.3, x);
  masterDelay.feedback.value = lerp(world.fx.fbMin, world.fx.fbMax, x);
  masterFilter.frequency.value = lerp(world.fx.filtMin, world.fx.filtMax, y) * lerp(1.0, 0.75, x);
  
  // Volume control
  masterGain.gain.value = world.mix.master * (isMuted ? 0 : 1);
}

// Only activate sampler engine when ?world= is present
// The main index.html checks for this and calls startSamplerAudio instead of startAudio
window._samplerEngine = {
  start: startSamplerAudio,
  update: updateSamplerAudio,
  isActive: () => !!currentWorld
};