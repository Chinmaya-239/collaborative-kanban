// Demo data: 2 organizations, 5 tenants, 6 users, 5 boards, 20 tasks. Password for all users: Password@123
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const GAP = 1024;
const COLS = ['To Do', 'In Progress', 'Testing', 'Done'];
const days = (n) => new Date(Date.now() + n * 86400000);

async function main() {
  await prisma.organization.deleteMany(); // cascades to everything tenant-owned
  await prisma.user.deleteMany();
  const passwordHash = await bcrypt.hash('Password@123', 10);
  const mk = (name, email) => prisma.user.create({ data: { name, email, passwordHash } });
  const [rahul, priya, arjun, sneha, kiran, meera] = await Promise.all([
    mk('Rahul', 'rahul@abc.test'), mk('Priya', 'priya@abc.test'), mk('Arjun', 'arjun@abc.test'),
    mk('Sneha', 'sneha@abc.test'), mk('Kiran', 'kiran@xyz.test'), mk('Meera', 'meera@abc.test'),
  ]);

  const abc = await prisma.organization.create({ data: { name: 'ABC Technologies' } });
  const xyz = await prisma.organization.create({ data: { name: 'XYZ Solutions' } });
  const t = {};
  for (const [key, org, name] of [['hyd', abc, 'Hyderabad'], ['blr', abc, 'Bangalore'], ['maa', abc, 'Chennai'], ['bom', xyz, 'Mumbai'], ['pnq', xyz, 'Pune']]) {
    t[key] = await prisma.tenant.create({ data: { organizationId: org.id, name } });
  }
  const m = (user, org, tenant, role) => ({ userId: user.id, organizationId: org.id, tenantId: tenant?.id ?? null, role });
  await prisma.membership.createMany({
    data: [
      m(rahul, abc, null, 'ORG_ADMIN'),        // org-level: sees Hyderabad, Bangalore and Chennai
      m(priya, abc, t.hyd, 'TENANT_ADMIN'),
      m(arjun, abc, t.hyd, 'MEMBER'),
      m(meera, abc, t.hyd, 'MEMBER'),
      m(sneha, abc, t.blr, 'TENANT_ADMIN'),
      m(kiran, xyz, t.bom, 'MEMBER'),
      m(kiran, xyz, t.pnq, 'TENANT_ADMIN'),    // same user, different role per tenant
    ],
  });

  async function board(tenant, org, creator, name, description, tasks) {
    const b = await prisma.board.create({ data: { tenantId: tenant.id, organizationId: org.id, createdBy: creator.id, name, description } });
    const cols = [];
    for (const [i, cn] of COLS.entries()) cols.push(await prisma.boardColumn.create({ data: { boardId: b.id, tenantId: tenant.id, name: cn, position: i + 1 } }));
    const counters = {};
    for (const [title, col, assignee, priority, due, desc] of tasks) {
      counters[col] = (counters[col] ?? 0) + 1;
      await prisma.task.create({
        data: { boardId: b.id, tenantId: tenant.id, columnId: cols[col].id, title, description: desc ?? null, assignedTo: assignee?.id ?? null, createdBy: creator.id, priority, dueDate: due ? days(due) : null, position: counters[col] * GAP },
      });
    }
    await prisma.activityLog.create({ data: { tenantId: tenant.id, userId: creator.id, entityType: 'board', entityId: b.id, action: 'CREATED', details: { name } } });
  }

  await board(t.hyd, abc, priya, 'Website Development', 'Marketing site and customer portal', [
    ['Create Login Page', 0, rahul, 'HIGH', 3, 'Email + password form with validation'],
    ['Fix API Validation', 0, arjun, 'MEDIUM', -1, 'Reject empty titles and bad UUIDs'],
    ['Design Dashboard', 0, null, 'LOW', 10],
    ['Develop Registration API', 1, arjun, 'HIGH', 2, 'bcrypt + JWT'],
    ['Build Task Details Panel', 1, meera, 'MEDIUM', 5],
    ['Test Authentication', 2, priya, 'URGENT', 1, 'Cover expired and tampered tokens'],
    ['Deploy Dashboard', 3, rahul, 'MEDIUM', null],
    ['Set up CI pipeline', 3, priya, 'LOW', null],
  ]);
  await board(t.hyd, abc, priya, 'Mobile Application Development', 'Android + iOS companion app', [
    ['Wireframes for onboarding', 3, meera, 'MEDIUM', null],
    ['Push notification service', 1, arjun, 'HIGH', 7],
    ['Offline cache strategy', 0, priya, 'MEDIUM', 14],
  ]);
  await board(t.blr, abc, sneha, 'CRM Development', 'Customer relationship management', [
    ['Lead import from CSV', 1, sneha, 'HIGH', 2],
    ['Pipeline report', 0, sneha, 'MEDIUM', 6],
    ['Email templates', 2, null, 'LOW', null],
  ]);
  await board(t.blr, abc, sneha, 'AI Automation', 'Internal automation experiments', [
    ['Summarise support tickets', 0, sneha, 'MEDIUM', 9],
    ['Prompt evaluation harness', 1, sneha, 'HIGH', 4],
  ]);
  await board(t.bom, xyz, kiran, 'Customer Support Platform', 'Helpdesk rebuild', [
    ['Ticket SLA timers', 1, kiran, 'URGENT', 1],
    ['Macros for agents', 0, kiran, 'LOW', 12],
    ['Migrate legacy tickets', 3, kiran, 'MEDIUM', null],
  ]);
  console.log('Seeded. Log in with e.g. rahul@abc.test / Password@123');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
