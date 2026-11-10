// Room service: Sonnes on the same Wi-Fi share one musical key, with no codes or setup.
// Devices behind the same home router reach this function from the same public IPv4 address (or the same IPv6 /64),
// so that address, hashed, is the room. Only the key is shared (plus the loop's pulse, for Song Box Drums), never audio.
//
// POST /api/room  {app:'sonne', id:'<random per page load>', hold:bool, claim:{root:0-11, mode:'major'|'minor'}?}
//   hold  = this page has loops playing in the key, so it keeps the room's key alive
//   claim = this page just set its key from a first take; it becomes the room's key if no other page is holding one
//   -> {on:true, key:{root,mode,bpm?}|null (the key other pages are holding, null if none), holders, peers}
// When every page has cleared, the next first take anywhere sets a fresh key.
// Storage: Upstash Redis over REST (Vercel Storage -> Upstash for Redis). Without it the page just plays alone ({on:false}).
const crypto = require('crypto');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const WINDOW = 15000; // a page that hasn't checked in for 15 s is gone

// one atomic step: note the page, forget stale ones, maybe take its claim, then report what the others hold
const SCRIPT = `
redis.call('ZADD',KEYS[1],ARGV[1],ARGV[2])
redis.call('ZREMRANGEBYSCORE',KEYS[1],0,tonumber(ARGV[1])-tonumber(ARGV[3]))
redis.call('ZREMRANGEBYSCORE',KEYS[2],0,tonumber(ARGV[1])-tonumber(ARGV[3]))
local others=redis.call('ZCARD',KEYS[2])
if redis.call('ZSCORE',KEYS[2],ARGV[2]) then others=others-1 end
if ARGV[5]~='' and others==0 then redis.call('SET',KEYS[3],ARGV[5]) end
if ARGV[4]=='1' then redis.call('ZADD',KEYS[2],ARGV[1],ARGV[2]) else redis.call('ZREM',KEYS[2],ARGV[2]) end
redis.call('EXPIRE',KEYS[1],120) redis.call('EXPIRE',KEYS[2],120) redis.call('EXPIRE',KEYS[3],3600)
local key=''
if others>0 then key=redis.call('GET',KEYS[3]) or '' end
return {key,others,redis.call('ZCARD',KEYS[1])}`;

function roomOf(req, app) {
  const fwd = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim();
  let ip = fwd || (req.socket && req.socket.remoteAddress) || '';
  // every device on a home network gets its own IPv6 address, but they share the /64 prefix
  if (ip.includes(':') && !ip.startsWith('::ffff:')) ip = ip.split(':').slice(0, 4).join(':');
  const salt = process.env.ROOM_SALT || 'lil-rooms';
  return 'room:' + app + ':' + crypto.createHash('sha256').update(salt + '|' + ip).digest('hex').slice(0, 20);
}

async function redis(cmds) {
  const r = await fetch(URL_ + '/pipeline', {method: 'POST', headers: {Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json'}, body: JSON.stringify(cmds)});
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map(x => x.result);
}

const validKey = k => k && Number.isInteger(k.root) && k.root >= 0 && k.root < 12 && (k.mode === 'major' || k.mode === 'minor');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // GET is a health check: is the room store connected?
  if (req.method === 'GET') { res.status(200).json({on: !!(URL_ && TOKEN)}); return; }
  if (req.method !== 'POST') { res.status(405).json({on: false}); return; }
  if (!URL_ || !TOKEN) { res.status(200).json({on: false}); return; }
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b || {};
  const app = /^[a-z]{1,16}$/.test(b.app) ? b.app : 'sonne';
  const id = /^[a-z0-9]{6,24}$/i.test(b.id) ? b.id : null;
  if (!id) { res.status(400).json({on: false}); return; }
  const room = roomOf(req, app), now = Date.now();
  // a Sonne's key may carry its loop's pulse (bpm), so a Song Box Drums on the same Wi-Fi can play at a related tempo
  const bpmOf = k => (typeof k.bpm === 'number' && k.bpm >= 30 && k.bpm <= 300 ? {bpm: Math.round(k.bpm * 10) / 10} : {});
  const claim = validKey(b.claim) ? JSON.stringify({root: b.claim.root, mode: b.claim.mode, ...bpmOf(b.claim)}) : '';
  try {
    const out = await redis([['EVAL', SCRIPT, '3', room + ':peers', room + ':holders', room + ':key', String(now), id, String(WINDOW), b.hold ? '1' : '0', claim]]);
    const [raw, holders, peers] = out[0] || [];
    let key = null;
    try { key = raw ? JSON.parse(raw) : null; } catch (e) { key = null; }
    res.status(200).json({on: true, key: validKey(key) ? {root: key.root, mode: key.mode, ...bpmOf(key)} : null, holders: holders || 0, peers: peers || 1});
  } catch (e) {
    res.status(200).json({on: false});
  }
};
