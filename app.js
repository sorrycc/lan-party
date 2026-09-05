/* Menu, lobby and networking orchestration. The race itself lives in game.js. */
import * as game from './game.js';
import { Net, wsUrl } from './net.js';

const $ = id => document.getElementById(id);
const S = { net: null, id: null, room: null, hostId: null, players: [], fillAI: true, mode: 'menu', racing: false, skin: 0, name: '' };
const isHost = () => S.id !== null && S.id === S.hostId;
const meP = () => S.players.find(p => p.id === S.id);
const hex = c => '#' + c.toString(16).padStart(6, '0');

/* ---------------------------------------------------------------- persisted prefs */
try { S.name = localStorage.getItem('fk_name') || ''; S.skin = Number(localStorage.getItem('fk_skin')) || 0; } catch {}
$('nameIn').value = S.name;
const savePrefs = () => { try { localStorage.setItem('fk_name', S.name); localStorage.setItem('fk_skin', String(S.skin)); } catch {} };
const readName = () => { S.name = $('nameIn').value.trim().slice(0, 12) || 'Racer'; $('nameIn').value = S.name; savePrefs(); return S.name; };

/* ---------------------------------------------------------------- screens */
function show(screen, status) {
  $('intro').style.display = screen ? 'flex' : 'none';
  $('screenStart').classList.toggle('show', screen === 'start'); $('screenLobby').classList.toggle('show', screen === 'lobby');
  if (screen === 'start') setStatus(status || '');
}
function setStatus(text, ok = false) { const el = $('status'); el.textContent = text; el.className = ok ? 'ok' : ''; }

function renderSkins(el, selected, taken, onPick) {
  el.innerHTML = '';
  game.SKINS.forEach((sk, i) => {
    const d = document.createElement('div'); d.className = 'skin' + (i === selected ? ' sel' : '') + (taken.has(i) && i !== selected ? ' taken' : '');
    d.style.background = hex(sk.color); d.title = sk.name; const n = document.createElement('span'); n.textContent = sk.name.toUpperCase(); d.appendChild(n);
    d.onclick = () => { if (taken.has(i) && i !== selected) return; onPick(i); };
    el.appendChild(d);
  });
}
function renderStart() { renderSkins($('skinsStart'), S.skin, new Set(), i => { S.skin = i; savePrefs(); renderStart(); }); }

function renderLobby() {
  const me = meP(); const host = isHost();
  $('roomCode').textContent = S.room || '----';
  $('roomAddr').innerHTML = S.addr ? `friends on this network open <b>${S.addr}</b> and enter the code` : '';
  const taken = new Set(S.players.filter(p => p.id !== S.id).map(p => p.skin));
  renderSkins($('skinsLobby'), me ? me.skin : S.skin, taken, i => S.net && S.net.send({ t: 'lobby', skin: i }));
  $('players').innerHTML = S.players.map(p => `<li class="${p.id === S.id ? 'me' : ''}"><span class="sw" style="background:${hex(game.SKINS[p.skin].color)}"></span><span class="nm">${esc(p.name)}${p.id === S.id ? ' (you)' : ''}</span>${p.id === S.hostId ? '<span class="tag host">HOST</span>' : p.ready ? '<span class="tag ready">READY</span>' : '<span class="tag wait">NOT READY</span>'}</li>`).join('');
  $('hostRow').style.display = host ? 'flex' : 'none'; $('chkFill').checked = !!S.fillAI;
  $('btnReady').style.display = host ? 'none' : ''; $('btnReady').textContent = me && me.ready ? 'NOT READY' : 'READY'; $('btnReady').classList.toggle('good', !(me && me.ready));
  $('btnStart').style.display = host ? '' : 'none';
  const others = S.players.filter(p => p.id !== S.hostId); const allReady = others.every(p => p.ready);
  $('btnStart').disabled = !allReady;
  $('lobbyStatus').textContent = host ? (others.length === 0 ? 'Waiting for players to join… you can also start alone.' : allReady ? 'Everyone is ready. Start when you like!' : 'Waiting for everyone to press READY…') : (me && me.ready ? 'Waiting for the host to start the race…' : 'Press READY when you are set.');
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------------------------------------------------------- results footer */
function renderResultsFoot() {
  const f = $('resFoot'); f.innerHTML = '';
  const btn = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'btn small ' + cls; b.textContent = label; b.onclick = fn; f.appendChild(b); return b; };
  if (S.mode === 'solo') { btn('RACE AGAIN  (R)', 'primary', restart); btn('MENU  (ESC)', '', leaveToMenu); }
  else if (isHost()) { btn('RACE AGAIN  (R)', 'primary', restart); btn('BACK TO LOBBY  (ESC)', '', () => S.net.send({ t: 'end' })); }
  else { f.textContent = 'WAITING FOR THE HOST TO RESTART OR RETURN TO THE LOBBY…'; }
}

/* ---------------------------------------------------------------- solo */
function soloSlots() { return game.SKINS.map((_, i) => i === S.skin ? { kind: 'human', id: 'me', name: S.name } : { kind: 'ai' }); }
function startSolo() {
  readName(); S.mode = 'solo'; S.racing = true; game.setNetSend(null); game.initAudio();
  game.setHint('ARROWS / WASD · SPACE item · R restart · ESC menu · M sound');
  game.startRace({ slots: soloSlots(), myId: 'me', host: true, online: false }); show(null); renderResultsFoot();
}
function restart() { if (S.mode === 'solo') game.startRace({ slots: soloSlots(), myId: 'me', host: true, online: false }); else if (isHost()) S.net.send({ t: 'start' }); }
function leaveToMenu(msg) {
  S.racing = false; S.mode = 'menu'; game.toLobby();
  if (S.net) { S.net.close(); S.net = null; } S.id = null; S.room = null; S.hostId = null; S.players = [];
  renderStart(); show('start', msg);
}

/* ---------------------------------------------------------------- online */
async function connect() {
  if (S.net && S.net.open) return S.net;
  const net = new Net(); setStatus('Connecting…', true);
  await net.connect(wsUrl()); S.net = net;
  net.on('joined', m => { S.id = m.id; S.room = m.room; S.hostId = m.hostId; S.addr = m.addr; S.mode = 'online'; game.setNetSend(msg => net.send(msg)); renderLobby(); show('lobby'); });
  net.on('lobby', m => { S.players = m.players; S.hostId = m.hostId; S.fillAI = m.fillAI; S.room = m.room; const me = meP(); if (me) { S.skin = me.skin; savePrefs(); } renderLobby(); if (S.racing) renderResultsFoot(); });
  net.on('start', m => {
    S.hostId = m.hostId; S.racing = true; game.initAudio();
    game.setHint(isHost() ? 'ARROWS / WASD · SPACE item · R again · ESC lobby · M sound' : 'ARROWS / WASD · SPACE item · M sound');
    game.startRace({ slots: m.slots, myId: S.id, host: isHost(), online: true }); show(null); renderResultsFoot();
  });
  net.on('end', () => { S.racing = false; game.toLobby(); renderLobby(); show('lobby'); });
  net.on('left', m => { if (S.racing) game.playerLeft(m.id); });
  net.on('closed', m => leaveToMenu(m.reason || 'The room was closed'));
  net.on('error', m => { setStatus(m.msg || 'Error'); $('lobbyStatus').textContent = m.msg || ''; });
  net.on('_close', () => leaveToMenu('Lost the connection to the server'));
  net.on('*', m => { if (S.racing) game.onNetMessage(m); });
  return net;
}
async function createRoom() { readName(); try { const net = await connect(); net.send({ t: 'create', name: S.name, skin: S.skin }); } catch (e) { setStatus(e.message); } }
async function joinRoom() {
  readName(); const code = $('codeIn').value.trim().toUpperCase(); if (code.length !== 4) { setStatus('Enter the 4-letter room code'); $('codeIn').focus(); return; }
  try { const net = await connect(); net.send({ t: 'join', room: code, name: S.name, skin: S.skin }); } catch (e) { setStatus(e.message); }
}

/* ---------------------------------------------------------------- wiring */
$('btnSolo').onclick = startSolo;
$('btnCreate').onclick = createRoom;
$('btnJoin').onclick = joinRoom;
$('codeIn').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
$('nameIn').addEventListener('keydown', e => { if (e.key === 'Enter') $('nameIn').blur(); });
$('nameIn').addEventListener('change', () => { readName(); if (S.net && S.net.open) S.net.send({ t: 'lobby', name: S.name }); });
$('btnReady').onclick = () => { const me = meP(); S.net.send({ t: 'lobby', ready: !(me && me.ready) }); };
$('btnStart').onclick = () => S.net.send({ t: 'start' });
$('btnLeave').onclick = () => { S.net.send({ t: 'leave' }); leaveToMenu(); };
$('chkFill').onchange = () => S.net.send({ t: 'opt', fillAI: $('chkFill').checked });
$('intro').addEventListener('pointerdown', () => game.initAudio(), { once: true });
game.setHooks({
  onRestart: () => { if (S.racing) restart(); },
  onEscape: () => { if (!S.racing) return; if (S.mode === 'solo') leaveToMenu(); else if (isHost()) S.net.send({ t: 'end' }); },
});
if (location.hash.length === 5) $('codeIn').value = location.hash.slice(1).toUpperCase();
renderStart(); show('start');
