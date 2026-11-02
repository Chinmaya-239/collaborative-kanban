// End-to-end checks for tenant isolation, RBAC, concurrency and real-time scoping.
// Usage: (server running + seeded)  npm run smoke
import { io } from 'socket.io-client';

const API = process.env.API_URL || 'http://localhost:5000';
let passed = 0, failed = 0;
const check = (name, ok, extra = '') => { ok ? passed++ : failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); };

async function call(method, path, { token, tenant, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...(tenant && { 'X-Tenant-Id': tenant }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
const login = async (email) => (await call('POST', '/api/auth/login', { body: { email, password: 'Password@123' } })).data.token;
const tenantId = (me, org, name) => me.organizations.find((o) => o.name === org).tenants.find((t) => t.name === name).id;
const connect = (token) => new Promise((resolve, reject) => {
  const s = io(API, { auth: { token }, transports: ['websocket'] });
  s.on('connect', () => resolve(s));
  s.on('connect_error', reject);
});
const join = (s, tid) => new Promise((r) => s.emit('tenant:join', { tenantId: tid }, r));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const [rahulT, priyaT, arjunT, sneha, kiranT] = await Promise.all(['rahul@abc.test', 'priya@abc.test', 'arjun@abc.test', 'sneha@abc.test', 'kiran@xyz.test'].map(login));
const me = (t) => call('GET', '/api/auth/me', { token: t }).then((r) => r.data);
const [rahulMe, priyaMe, snehaMe, kiranMe] = await Promise.all([me(rahulT), me(priyaT), me(sneha), me(kiranT)]);
const HYD = tenantId(rahulMe, 'ABC Technologies', 'Hyderabad');
const BLR = tenantId(rahulMe, 'ABC Technologies', 'Bangalore');
const BOM = tenantId(kiranMe, 'XYZ Solutions', 'Mumbai');

// ---- Auth
check('401 without token', (await call('GET', '/api/boards', { tenant: HYD })).status === 401);
check('401 with tampered token', (await call('GET', '/api/boards', { token: priyaT + 'x', tenant: HYD })).status === 401);

// ---- Tenant isolation (REST)
check('Priya sees only Hyderabad', priyaMe.organizations.flatMap((o) => o.tenants).map((t) => t.name).join() === 'Hyderabad');
check('Rahul (org admin) sees 3 ABC tenants', rahulMe.organizations.find((o) => o.name === 'ABC Technologies').tenants.length === 3);
check('Hyderabad user + Bangalore header => 403', (await call('GET', '/api/boards', { token: priyaT, tenant: BLR })).status === 403);
check('Cross-ORG: Priya + Mumbai header => 403', (await call('GET', '/api/boards', { token: priyaT, tenant: BOM })).status === 403);
check('Missing tenant header => 400', (await call('GET', '/api/boards', { token: priyaT })).status === 400);
const blrBoards = (await call('GET', '/api/boards', { token: sneha, tenant: BLR })).data.boards;
const blrBoard = (await call('GET', `/api/boards/${blrBoards[0].id}`, { token: sneha, tenant: BLR })).data.board;
const blrTask = blrBoard.tasks[0];
check('Bangalore task by ID with Hyderabad header => 404', (await call('GET', `/api/tasks/${blrTask.id}`, { token: priyaT, tenant: HYD })).status === 404);
check('Bangalore task by ID with Bangalore header (not a member) => 403', (await call('GET', `/api/tasks/${blrTask.id}`, { token: priyaT, tenant: BLR })).status === 403);
check('Cannot PUT a foreign-tenant task', (await call('PUT', `/api/tasks/${blrTask.id}`, { token: priyaT, tenant: HYD, body: { title: 'hacked', expectedVersion: blrTask.version } })).status === 404);
check('Cannot DELETE a foreign-tenant task', (await call('DELETE', `/api/tasks/${blrTask.id}`, { token: priyaT, tenant: HYD })).status === 404);
check('Body tenantId is ignored (cannot create in other tenant)', (await call('POST', '/api/tasks', { token: priyaT, tenant: HYD, body: { boardId: blrBoard.id, columnId: blrBoard.columns[0].id, title: 'x', tenantId: BLR } })).status === 400);

// ---- RBAC
check('Member cannot create board', (await call('POST', '/api/boards', { token: arjunT, tenant: HYD, body: { name: 'nope' } })).status === 403);
check('Tenant admin cannot create tenant', (await call('POST', '/api/tenants', { token: priyaT, body: { organizationId: priyaMe.organizations[0].id, name: 'Goa' } })).status === 403);
const goaRes = await call('POST', '/api/tenants', { token: rahulT, body: { organizationId: rahulMe.organizations.find((o) => o.name === 'ABC Technologies').id, name: 'Goa-' + Date.now() } });
check('Org admin can create tenant', goaRes.status === 201);

// ---- CRUD + versioning + concurrency
const hydBoards = (await call('GET', '/api/boards', { token: priyaT, tenant: HYD })).data.boards;
const hydBoard = (await call('GET', `/api/boards/${hydBoards[0].id}`, { token: priyaT, tenant: HYD })).data.board;
const [todo, doing, , done] = hydBoard.columns;
const created = await call('POST', '/api/tasks', { token: arjunT, tenant: HYD, body: { boardId: hydBoard.id, columnId: todo.id, title: 'Smoke test task' } });
check('Member creates task', created.status === 201 && created.data.task.version === 1);
let task = created.data.task;

const u1 = await call('PUT', `/api/tasks/${task.id}`, { token: priyaT, tenant: HYD, body: { title: 'Edited by Priya', expectedVersion: 1 } });
check('Update with correct version => 200, version 2', u1.status === 200 && u1.data.task.version === 2);
const u2 = await call('PUT', `/api/tasks/${task.id}`, { token: arjunT, tenant: HYD, body: { description: 'stale write', expectedVersion: 1 } });
check('Stale update => 409 with current task', u2.status === 409 && u2.data.code === 'VERSION_CONFLICT' && u2.data.current.version === 2);

const [m1, m2] = await Promise.all([
  call('PATCH', `/api/tasks/${task.id}/move`, { token: priyaT, tenant: HYD, body: { columnId: doing.id, index: 0, expectedVersion: 2 } }),
  call('PATCH', `/api/tasks/${task.id}/move`, { token: arjunT, tenant: HYD, body: { columnId: done.id, index: 0, expectedVersion: 2 } }),
]);
check('Concurrent moves: exactly one wins, one gets 409', [m1.status, m2.status].sort().join() === '200,409', JSON.stringify([m1.status, m2.status]));
task = (await call('GET', `/api/tasks/${task.id}`, { token: priyaT, tenant: HYD })).data.task;
const opId = 'op-' + Date.now();
const mv = { columnId: todo.id, index: 0, expectedVersion: task.version, clientOpId: opId };
const r1 = await call('PATCH', `/api/tasks/${task.id}/move`, { token: priyaT, tenant: HYD, body: mv });
const r2 = await call('PATCH', `/api/tasks/${task.id}/move`, { token: priyaT, tenant: HYD, body: mv });
check('Retry with same clientOpId is idempotent', r1.status === 200 && r2.status === 200 && r1.data.task.version === r2.data.task.version);

// Member cannot delete a task they did not create (task is created by Priya, so Arjun did not create it)
const ownedByPriya = await call('POST', '/api/tasks', { token: priyaT, tenant: HYD, body: { boardId: hydBoard.id, columnId: todo.id, title: 'Smoke: owned by Priya' } });
const delByMember = await call('DELETE', `/api/tasks/${ownedByPriya.data.task.id}`, { token: arjunT, tenant: HYD });
check('Member cannot delete a task they did not create', ownedByPriya.status === 201 && delByMember.status === 403);
await call('DELETE', `/api/tasks/${ownedByPriya.data.task.id}`, { token: priyaT, tenant: HYD });

// ---- Real-time scoping
const sPriya = await connect(priyaT);
const sSneha = await connect(sneha);
const sKiran = await connect(kiranT);
check('Priya joins Hyderabad room', (await join(sPriya, HYD)).ok);
check('Priya CANNOT join Bangalore room', (await join(sPriya, BLR)).ok === false);
check('Priya CANNOT join Mumbai room (other org)', (await join(sPriya, BOM)).ok === false);
check('Sneha joins Bangalore', (await join(sSneha, BLR)).ok);
check('Kiran joins Mumbai', (await join(sKiran, BOM)).ok);
const got = { priya: [], sneha: [], kiran: [] };
sPriya.on('task:moved', (p) => got.priya.push(p)); sSneha.on('task:moved', (p) => got.sneha.push(p)); sKiran.on('task:moved', (p) => got.kiran.push(p));
task = (await call('GET', `/api/tasks/${task.id}`, { token: priyaT, tenant: HYD })).data.task;
await call('PATCH', `/api/tasks/${task.id}/move`, { token: arjunT, tenant: HYD, body: { columnId: doing.id, index: 0, expectedVersion: task.version } });
await wait(300);
check('Hyderabad subscriber receives task:moved', got.priya.length === 1);
check('Bangalore + Mumbai subscribers receive nothing', got.sneha.length === 0 && got.kiran.length === 0);
check('Unauthenticated socket is rejected', await new Promise((res) => { const s = io(API, { auth: { token: 'bad' }, transports: ['websocket'], reconnection: false }); s.on('connect_error', () => { s.close(); res(true); }); s.on('connect', () => { s.close(); res(false); }); }));

// cleanup
await call('DELETE', `/api/tasks/${task.id}`, { token: priyaT, tenant: HYD });
const goaId = goaRes.data?.tenant?.id ?? goaRes.data?.id;
if (goaId) await call('DELETE', `/api/tenants/${goaId}`, { token: rahulT });
[sPriya, sSneha, sKiran].forEach((s) => s.close());
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);