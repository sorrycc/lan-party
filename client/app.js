/* Shell: menu, lobby and the lifecycle of the chosen game. Games live in games/<id>/ and are loaded on demand;
   the game contract is documented at the top of games/kart/index.js. */
import { GAMES, gameById, defaultOpts, cleanOpts } from './games/registry.js';
import { AVATARS, MAX_NAME } from './core/avatars.js';
import { Net, wsUrl } from './core/net.js';
import { createAudio } from './core/audio.js';
import { loadPrefs, savePrefs } from './core/prefs.js';
import { esc, hex } from './core/ui.js';
import { drawQr } from './core/qr.js';
import { makeT, pick, onLang, nextLang, applyDoc, isZh } from './core/i18n.js';
import { STR } from './strings.js';

const $ = id => document.getElementById(id);
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/; // server/rooms.js's alphabet
const audio = createAudio();
const T = makeT(STR);
const S = { net: null, id: null, room: null, hostId: null, addr: '', players: [], opts: {}, soloOpts: {}, gameId: GAMES[0].id, mode: 'menu', playing: false, name: '', avatar: 0, game: null, gameMeta: null, loading: null, rematch: [] };
const isHost = () => S.id !== null && S.id === S.hostId;
const meP = () => S.players.find(p => p.id === S.id);
const curGame = () => gameById(S.gameId) || GAMES[0];
const titleOf = g => pick(g.title);
const teamLabel = id => { const t = (curGame().teams || []).find(t => t.id === id); return t ? pick(t.label) : String(id); };
/* a message from the server is a code plus vars (server/rooms.js), worded here; a team id among the vars becomes its name */
const serverText = (kind, m) => m.code ? T(kind + '.' + m.code, m.vars && m.vars.team !== undefined ? { ...m.vars, team: teamLabel(m.vars.team) } : m.vars) : (m.msg || m.reason || '');

/* ---------------------------------------------------------------- persisted prefs */
{ const p = loadPrefs(); S.name = p.name; S.avatar = AVATARS[p.avatar] ? p.avatar : 0; if (gameById(p.game)) S.gameId = p.game; }
$('nameIn').value = S.name;
const savePrefsNow = () => savePrefs({ name: S.name, avatar: S.avatar, game: S.gameId });
const readName = () => { S.name = $('nameIn').value.trim().slice(0, MAX_NAME) || T('defaultName'); $('nameIn').value = S.name; savePrefsNow(); return S.name; };

/* ---------------------------------------------------------------- language
   index.html's static words carry data-t / data-tph; everything app.js writes is redrawn by re-rendering the screen */
function translateStatic() {
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = T(el.dataset.t);
  for (const el of document.querySelectorAll('[data-tph]')) el.placeholder = T(el.dataset.tph);
}
onLang(() => { translateStatic(); if (S.mode === 'online' && !S.playing) renderLobby(); else renderStart(); redrawStatus(); });
$('btnLang').onclick = () => nextLang();

/* ---------------------------------------------------------------- screens
   status lines keep their key, not their words, so a language switch rewords them */
let statusMsg = null, errMsg = null, errTimer = 0;
function show(screen, status) {
  $('intro').hidden = !screen; $('stage').hidden = !!screen;
  $('screenStart').classList.toggle('show', screen === 'start'); $('screenLobby').classList.toggle('show', screen === 'lobby');
  if (screen === 'start') setStatus(status || '');
}
/* `text` is a key, [key, vars], or () => words (for a sentence built from several parts) */
const word = m => typeof m === 'function' ? m() : Array.isArray(m) ? T(m[0], m[1]) : m ? T(m) : '';
function setStatus(msg, ok = false) { statusMsg = [msg, ok]; const el = $('status'); el.textContent = word(msg); el.className = ok ? 'ok' : ''; }
/* lobby errors and notices get their own line for a few seconds: the next lobby broadcast rewrites the status line under them */
function lobbyNote(msg) { errMsg = msg; $('lobbyErr').textContent = word(msg); clearTimeout(errTimer); errTimer = setTimeout(() => { errMsg = null; $('lobbyErr').textContent = ''; }, 5000); }
function redrawStatus() { if (statusMsg) setStatus(...statusMsg); if (errMsg) $('lobbyErr').textContent = word(errMsg); }

function renderAvatars(el, selected, taken, onPick) {
  el.innerHTML = '';
  AVATARS.forEach((av, i) => {
    const d = document.createElement('div'); d.className = 'avatar' + (i === selected ? ' sel' : '') + (taken.has(i) && i !== selected ? ' taken' : '');
    d.style.background = hex(av.color); d.title = av.name; const n = document.createElement('span'); n.textContent = av.name.toUpperCase(); d.appendChild(n); // avatar names stay as they are: they name the karts
    d.onclick = () => { if (taken.has(i) && i !== selected) return; onPick(i); };
    el.appendChild(d);
  });
}
function renderGames() {
  const el = $('gameList'); el.innerHTML = '';
  for (const g of GAMES) {
    const d = document.createElement('div'); d.className = 'game-card' + (g.id === S.gameId ? ' sel' : '');
    const n = g.minPlayers === g.maxPlayers ? g.maxPlayers : `${g.minPlayers}–${g.maxPlayers}`; // in Chinese the English title rides underneath, the name people already know
    d.innerHTML = `<div class="title">${esc(titleOf(g))}</div>${isZh() ? `<div class="en">${esc(g.title.en)}</div>` : ''}<div class="tag">${esc(pick(g.tagline) || '')}</div><div class="cap">${T('players', { n })}${g.minPlayers <= 1 ? T('soloOk') : ''}</div>`;
    d.onclick = () => { S.gameId = g.id; savePrefsNow(); renderGames(); };
    el.appendChild(d);
  }
  $('btnSolo').disabled = curGame().minPlayers > 1;
  renderSoloOpts();
}
function renderStart() { renderAvatars($('avatarsStart'), S.avatar, new Set(), i => { S.avatar = i; savePrefsNow(); renderStart(); }); renderGames(); }

/* game options are declared by the game (registry.js). In the lobby the host edits them and everyone else sees them;
   on the start screen the player edits a private copy that PLAY SOLO uses. */
function renderOptsInto(el, game, opts, enabled, onChange) {
  el.innerHTML = '';
  for (const o of game.options || []) {
    const label = document.createElement('label'); label.className = 'opt'; let input;
    const text = pick(o.label);
    if (o.type === 'bool') { input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!opts[o.key]; label.append(input, document.createTextNode(text)); }
    else if (o.type === 'number') { input = document.createElement('input'); input.type = 'number'; if (o.min !== undefined) input.min = o.min; if (o.max !== undefined) input.max = o.max; if (o.step !== undefined) input.step = o.step; input.value = opts[o.key] ?? o.default; label.append(document.createTextNode(text), input); }
    else if (o.type === 'select') { input = document.createElement('select'); for (const c of o.choices) { const opt = document.createElement('option'); opt.value = String(c.value); opt.textContent = pick(c.label); opt.selected = c.value === opts[o.key]; input.appendChild(opt); } label.append(document.createTextNode(text), input); }
    else continue;
    input.disabled = !enabled;
    input.onchange = () => onChange(o.key, o.type === 'bool' ? input.checked : o.type === 'number' ? Number(input.value) : (o.choices.find(c => String(c.value) === input.value) || {}).value);
    el.appendChild(label);
  }
}
function renderOpts() { renderOptsInto($('opts'), curGame(), S.opts, isHost(), (key, v) => { if (S.net) S.net.send({ t: 'opt', opts: { [key]: v } }); }); }
const soloOpts = () => { const g = curGame(); return (S.soloOpts[g.id] ||= defaultOpts(g)); };
function renderSoloOpts() { const g = curGame(); $('soloOptsWrap').hidden = !(g.options || []).length; renderOptsInto($('soloOpts'), g, soloOpts(), true, (key, v) => { S.soloOpts[g.id] = cleanOpts(g, { [key]: v }, soloOpts()); }); }
const playerLi = p => `<li class="${p.id === S.id ? 'me' : ''}"><span class="sw" style="background:${hex(AVATARS[p.avatar].color)}"></span><span class="nm">${esc(p.name)}${p.id === S.id ? T('you') : ''}</span>${p.id === S.hostId ? `<span class="tag host">${T('host')}</span>` : p.ready ? `<span class="tag ready">${T('readyTag')}</span>` : `<span class="tag wait">${T('waitTag')}</span>`}</li>`;
const pickTeam = id => { const me = meP(); if (S.net && me && !me.ready && me.team !== id) S.net.send({ t: 'lobby', team: id }); };
/* team games: the roster is split into one column per side; click a column (or the friend/enemy shortcuts) to switch */
function renderTeams(game, me, host) {
  const el = $('teams'); el.innerHTML = ''; const size = game.teamSize || Infinity, locked = !!(me && me.ready);
  for (const t of game.teams) {
    const members = S.players.filter(p => p.team === t.id), mine = !!(me && me.team === t.id), full = members.length >= size;
    const d = document.createElement('div'); d.className = 'team-col' + (mine ? ' sel' : '') + (full ? ' full' : '') + (locked ? ' locked' : ''); d.style.setProperty('--tc', hex(t.color));
    const tl = pick(t.label);
    d.title = mine ? '' : locked ? T('sideLocked') : full ? T('sideFull', { team: tl }) : T('sideJoin', { team: tl });
    d.innerHTML = `<div class="team-head"><span>${esc(tl)}</span><small>${members.length}/${Number.isFinite(size) ? size : '∞'}</small></div>` + (members.length ? `<ul class="players">${members.map(playerLi).join('')}</ul>` : `<div class="empty">${T('nobody')}</div>`);
    d.onclick = () => { if (!mine && !full) pickTeam(t.id); };
    el.appendChild(d);
  }
  const hostP = S.players.find(p => p.id === S.hostId), hostTeam = hostP ? hostP.team : null, other = game.teams.find(t => t.id !== hostTeam);
  const canGo = t => !!(t && me && !locked && me.team !== t.id && S.players.filter(p => p.team === t.id).length < size);
  $('btnFriend').disabled = !canGo(game.teams.find(t => t.id === hostTeam)); $('btnFriend').onclick = () => hostTeam && pickTeam(hostTeam);
  $('btnEnemy').disabled = !canGo(other); $('btnEnemy').onclick = () => other && pickTeam(other.id);
  $('teamBtns').hidden = host; // the host just clicks a column
}
/* the join link as a QR code (address + room code as the hash, which the start screen picks up); drawn once per room */
let qrShown = '';
function renderQr() {
  const el = $('roomQr'), link = S.addr && S.room ? `${S.addr}/#${S.room}` : '';
  if (link === qrShown) return; qrShown = link;
  if (!link) { el.hidden = true; return; }
  try { drawQr(el.querySelector('canvas'), link); el.hidden = false; } catch (e) { console.error(e); el.hidden = true; }
}
function renderLobby() {
  const me = meP(), host = isHost(), game = curGame(), teams = game.teams || null;
  $('roomCode').textContent = S.room || '----';
  $('roomAddr').innerHTML = S.addr ? T('roomAddr', { addr: esc(S.addr) }) : '';
  renderQr();
  $('lobbyGame').textContent = T('lobbyGame', { title: titleOf(game).toUpperCase(), n: S.players.length, max: game.maxPlayers });
  const taken = new Set(S.players.filter(p => p.id !== S.id).map(p => p.avatar));
  renderAvatars($('avatarsLobby'), me ? me.avatar : S.avatar, taken, i => S.net && S.net.send({ t: 'lobby', avatar: i }));
  $('players').hidden = !!teams; $('teams').hidden = !teams; $('teamBtns').hidden = !teams;
  if (teams) renderTeams(game, me, host); else $('players').innerHTML = S.players.map(playerLi).join('');
  renderOpts();
  $('btnReady').style.display = host ? 'none' : ''; $('btnReady').textContent = T(me && me.ready ? 'notReady' : 'ready'); $('btnReady').classList.toggle('good', !(me && me.ready));
  $('btnStart').style.display = host ? '' : 'none';
  const others = S.players.filter(p => p.id !== S.hostId); const allReady = others.every(p => p.ready); const enough = S.players.length >= game.minPlayers;
  $('btnStart').disabled = !allReady || !enough;
  const emptySide = teams && others.length ? teams.find(t => !S.players.some(p => p.team === t.id)) : null;
  $('lobbyStatus').textContent = host
    ? (!enough ? T('needPlayersLobby', { title: titleOf(game), n: game.minPlayers }) : others.length === 0 ? T('aloneOk') : (emptySide ? T('sideEmpty', { team: pick(emptySide.label) }) : '') + T(allReady ? 'allReady' : 'waitReady'))
    : T(me && me.ready ? 'waitHost' : teams ? 'pickSide' : 'pressReady');
}

/* ---------------------------------------------------------------- game lifecycle
   onRestart / onExit are the host's (solo counts as the host); a guest's way out is onLeave, and a guest asks the host for another
   round with onRematch(on). The votes come back to the game as instance.rematchVotes(ids) - the ids of the guests who want one. */
const hooks = {
  onRestart: () => { if (!S.playing || !S.game) return; if (S.mode === 'solo') S.game.start(soloSession()); else if (isHost()) S.net.send({ t: 'start' }); },
  onExit: () => { if (!S.playing) return; if (S.mode === 'solo') leaveToMenu(); else if (isHost()) S.net.send({ t: 'end' }); },
  onLeave: () => { if (S.mode === 'solo') { leaveToMenu(); return; } if (S.net) S.net.send({ t: 'leave' }); leaveToMenu(); },
  onRematch: (on = true) => { if (S.mode === 'online' && S.playing && !isHost() && S.net) S.net.send({ t: 'rematch', on: !!on }); },
};
const send = msg => { if (S.mode === 'online' && S.net) S.net.send(msg); };
let gen = 0; // bumps whenever the current game is torn down, so a load that finishes late is discarded
async function ensureGame(game) {
  if (S.game && S.gameMeta && S.gameMeta.id === game.id) return S.game;
  if (S.loading && S.loading.id === game.id) return S.loading.promise;
  destroyGame(); const my = ++gen;
  const promise = (async () => {
    const mod = await game.load(); const inst = await mod.create({ mount: $('stage'), audio, send, hooks });
    if (my !== gen) { inst.destroy(); return null; }
    S.game = inst; S.gameMeta = game; return inst;
  })().finally(() => { if (S.loading && S.loading.promise === promise) S.loading = null; });
  S.loading = { id: game.id, promise };
  return promise;
}
function destroyGame() { gen++; if (S.game) { try { S.game.destroy(); } catch (e) { console.error(e); } } S.game = null; S.gameMeta = null; S.loading = null; $('stage').innerHTML = ''; }
const loadError = (game, e) => { console.error(e); return () => T('loadFail', { title: titleOf(game), err: e.message }); };

/* ---------------------------------------------------------------- screen wake lock
   A race can go a long stretch with no touch at all (Frostline Kart drives itself on a phone), so the screen dims and
   locks mid-game. The lock is dropped by the browser whenever the page hides, so it is taken again on the way back, and
   Safari refuses one outside a user gesture, so a refusal is retried on the next tap. */
let wakeLock = null, wakeWanted = false;
async function wakeAcquire() {
  if (!wakeWanted || wakeLock || !navigator.wakeLock || document.hidden) return;
  try { const l = await navigator.wakeLock.request('screen'); if (!wakeWanted) { l.release().catch(() => {}); return; } wakeLock = l; l.addEventListener('release', () => { if (wakeLock === l) wakeLock = null; }); }
  catch {}
}
function wakeKeep(on) {
  wakeWanted = on;
  if (on) wakeAcquire();
  else if (wakeLock) { const l = wakeLock; wakeLock = null; l.release().catch(() => {}); }
}

/* ---------------------------------------------------------------- solo */
const newSeed = () => (Math.random() * 0x100000000) >>> 0;
const soloSession = () => { const g = curGame(); return { players: [{ id: 'me', name: S.name, avatar: S.avatar, team: g.teams ? g.teams[0].id : undefined }], myId: 'me', hostId: 'me', isHost: true, online: false, opts: cleanOpts(g, soloOpts(), defaultOpts(g)), seed: newSeed() }; };
async function startSolo() {
  readName(); const game = curGame(); if (game.minPlayers > 1) { setStatus(() => T('needPlayersLobby', { title: titleOf(game), n: game.minPlayers })); return; }
  S.mode = 'solo'; setStatus('loading', true); audio.init();
  try { const inst = await ensureGame(game); if (!inst || S.mode !== 'solo') return; S.playing = true; wakeKeep(true); inst.start(soloSession()); show(null); }
  catch (e) { S.mode = 'menu'; setStatus(loadError(game, e)); }
}
function leaveToMenu(msg) {
  S.playing = false; wakeKeep(false); S.mode = 'menu'; S.rematch = []; destroyGame();
  if (S.net) { S.net.close(); S.net = null; } S.id = null; S.room = null; S.hostId = null; S.players = []; S.opts = {};
  renderStart(); show('start', msg);
}

/* ---------------------------------------------------------------- online */
async function connect() {
  if (S.net && S.net.open) return S.net;
  const net = new Net(); setStatus('connecting', true);
  try { await net.connect(wsUrl()); } catch { throw new Error('unreachable'); } // a key: setStatus words it
  S.net = net;
  net.on('joined', m => {
    S.id = m.id; S.room = m.room; S.hostId = m.hostId; S.addr = m.addr; S.mode = 'online'; if (gameById(m.game)) S.gameId = m.game; savePrefsNow();
    renderLobby(); show('lobby');
    ensureGame(curGame()).catch(e => lobbyNote(loadError(curGame(), e))); // build the game while people gather so START is instant
  });
  net.on('lobby', m => { S.players = m.players; S.hostId = m.hostId; S.opts = m.opts || {}; S.room = m.room; if (gameById(m.game)) S.gameId = m.game; const me = meP(); if (me) { S.avatar = me.avatar; savePrefsNow(); } renderLobby(); });
  net.on('start', async m => { // the seed is the round's shared id: every machine must land on the same number, so only a missing one is replaced
    S.hostId = m.hostId; S.playing = true; S.rematch = []; wakeKeep(true); audio.init(); const game = curGame();
    const session = { players: m.players, myId: S.id, hostId: m.hostId, isHost: isHost(), online: true, opts: m.opts || {}, seed: Number.isFinite(m.seed) ? (m.seed >>> 0) : newSeed() };
    try { const inst = await ensureGame(game); if (!inst || !S.playing || S.mode !== 'online') return; inst.start(session); show(null); }
    catch (e) { lobbyNote(loadError(game, e)); }
  });
  net.on('end', () => { S.playing = false; S.rematch = []; wakeKeep(false); if (S.game) S.game.stop(); renderLobby(); show('lobby'); });
  net.on('left', m => { if (S.playing && S.game) S.game.playerLeft(m.id); });
  net.on('closed', m => leaveToMenu(m.code || m.reason ? () => serverText('notice', m) : 'closed'));
  net.on('error', m => { const w = () => serverText('err', m); if (S.mode === 'online') lobbyNote(w); else setStatus(w); });
  net.on('notice', m => { const w = () => serverText('notice', m); lobbyNote(w); if (S.playing && S.game && S.game.notice) S.game.notice(w()); });
  net.on('rematch', m => { S.rematch = Array.isArray(m.ids) ? m.ids : []; if (S.playing && S.game && S.game.rematchVotes) S.game.rematchVotes(S.rematch); });
  net.on('_close', () => leaveToMenu('lost'));
  net.on('*', m => { if (S.playing && S.game) S.game.onNetMessage(m); });
  return net;
}
async function createRoom() {
  readName(); const code = $('codeIn').value.trim().toUpperCase(); // a code typed in the box names the new room; empty lets the server pick one
  if (code && !CODE_RE.test(code)) { setStatus('badCodeLocal'); $('codeIn').focus(); return; }
  try { const net = await connect(); net.send({ t: 'create', room: code || undefined, name: S.name, avatar: S.avatar, game: S.gameId }); } catch (e) { setStatus(e.message); }
}
async function joinRoom() {
  readName(); const code = $('codeIn').value.trim().toUpperCase(); if (code.length !== 4) { setStatus('enterCode'); $('codeIn').focus(); return; }
  try { const net = await connect(); net.send({ t: 'join', room: code, name: S.name, avatar: S.avatar }); } catch (e) { setStatus(e.message); }
}

/* ---------------------------------------------------------------- wiring */
$('btnSolo').onclick = startSolo;
$('btnCreate').onclick = createRoom;
$('btnJoin').onclick = () => { $('btnJoin').classList.remove('hot'); joinRoom(); };
$('codeIn').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
/* room codes never hold I, O, 0 or 1 (server/rooms.js): drop them as they are typed, and say why, rather than fail on JOIN */
$('codeIn').addEventListener('input', () => {
  const el = $('codeIn'), raw = el.value.toUpperCase(), clean = raw.split('').filter(c => CODE_CHARS.includes(c)).join('').slice(0, 4);
  if (clean !== el.value) el.value = clean;
  if (clean.length < raw.length) setStatus('codeStripped');
});
$('nameIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('nameIn').blur(); });
$('nameIn').addEventListener('change', () => { readName(); if (S.net && S.net.open) S.net.send({ t: 'lobby', name: S.name }); });
$('btnReady').onclick = () => { const me = meP(); S.net.send({ t: 'lobby', ready: !(me && me.ready) }); };
$('btnStart').onclick = () => S.net.send({ t: 'start' });
$('btnLeave').onclick = () => { S.net.send({ t: 'leave' }); leaveToMenu(); };
/* browsers only unlock audio inside a user gesture; iOS counts touchend and click but not always the pointerdown before them */
document.addEventListener('pointerdown', () => { audio.init(); wakeAcquire(); }); // a tap is also the gesture Safari wants for the wake lock
document.addEventListener('touchend', () => audio.init(), { passive: true });
document.addEventListener('click', () => audio.init());
document.addEventListener('keydown', () => audio.init());
document.addEventListener('visibilitychange', () => { if (!document.hidden) { audio.init(); wakeAcquire(); } }); // the browser drops the wake lock while hidden
applyDoc(); translateStatic(); renderStart(); show('start');
if (/^#[A-Za-z0-9]{4}$/.test(location.hash)) { // arrived by a scanned lobby code: fill it in and point at JOIN
  $('codeIn').value = location.hash.slice(1).toUpperCase(); $('btnJoin').classList.add('hot'); setStatus('codeFromLink', true);
}
