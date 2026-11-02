import http from 'node:http';
import { app } from './app.js';
import { config } from './config.js';
import { initSocket } from './realtime.js';

const server = http.createServer(app);
initSocket(server);
server.listen(config.port, () => console.log(`API + WebSocket server on http://localhost:${config.port}`));
