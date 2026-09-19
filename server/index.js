/* LAN party server: serves the client and relays room messages over WebSocket. */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createStaticHandler } from './static.js';
import { createRooms } from './rooms.js';
import { GAMES } from '../client/games/registry.js';
import { pickEn } from '../client/core/i18n.js';

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = path.join(ROOT, 'client');
const THREE_PATH = path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');
const CANNON_PATH = path.join(ROOT, 'node_modules', 'cannon-es', 'dist', 'cannon-es.js');
const THREE_ADDONS = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm'); // Sundown Showdown's bloom pass

function lanAddresses() { const out = []; for (const list of Object.values(os.networkInterfaces())) for (const a of list) if (a.family === 'IPv4' && !a.internal) out.push(a.address); return out; }
const addrHint = () => { const a = lanAddresses(); return a.length ? `http://${a[0]}:${PORT}` : `http://localhost:${PORT}`; };

const server = http.createServer(createStaticHandler({ root: CLIENT, aliases: { '/lib/three.module.js': THREE_PATH, '/lib/cannon-es.js': CANNON_PATH }, mounts: { '/lib/three-addons/': THREE_ADDONS } }));
const wss = new WebSocketServer({ server });
createRooms({ addrHint }).attach(wss);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`LAN party server running with ${GAMES.length} game(s): ${GAMES.map(g => pickEn(g.title)).join(', ')}`);
  console.log('Open one of these on every machine:');
  console.log(`  http://localhost:${PORT}   (this machine)`);
  for (const a of lanAddresses()) console.log(`  http://${a}:${PORT}`);
  if (!fs.existsSync(THREE_PATH)) console.log('WARNING: three.js not found - run `npm install` first.');
  if (!fs.existsSync(CANNON_PATH)) console.log('WARNING: cannon-es not found - run `npm install` first.');
});
