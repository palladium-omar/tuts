import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Database } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { ReconciliationTransactionsService } from '../src/reconciliation-transactions.js';

const owner = (): RequestContext => ({ businessId: randomUUID(), sub:'synthetic-reviewer', role:'owner', requestId:randomUUID(),
  entitlements:['payments'], permissions:['payments.read','reporting.financial'], accessScope:'business', studentIds:[], policyVersion:1 });

test('confirmed receipt export denies students, scoped staff, missing capability and malformed pagination before DB access', async () => {
  let calls=0;
  const service = new ReconciliationTransactionsService({withTenant:async()=>{calls++;throw new Error('Unexpected DB access');}} as unknown as Database);
  const ctx=owner();
  for (const invalid of [{...ctx,role:'student' as const}, {...ctx,role:'parent' as const}, {...ctx,accessScope:'students' as const},
    {...ctx,permissions:['payments.read']}, {...ctx,entitlements:[]}]) await assert.rejects(service.list(invalid,{}));
  await assert.rejects(service.list(ctx,{limit:201}));
  await assert.rejects(service.list(ctx,{unknown:'field'}));
  assert.equal(calls,0);
});

test('ordinary PostgreSQL receipt export isolates tenants, paginates confirmed only and excludes credential fields', {skip:!process.env.PAYMENTS_TEST_DATABASE_URL}, async () => {
  const db=new Database(), original=db.pool, pool=new Pool({connectionString:process.env.PAYMENTS_TEST_DATABASE_URL});
  Object.defineProperty(db,'pool',{value:pool});
  const ctx=owner(),other=owner(),service=new ReconciliationTransactionsService(db);
  try {
    const role=(await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
    await db.withTenant(ctx.businessId,async tx=>{
      const connectionId=randomUUID();
      await tx.query("INSERT INTO payment_connections(id,business_id,provider,display_name,status,credentials_ciphertext) VALUES($1,$2,'bank','Synthetic','enabled','secret-not-exported')",[connectionId,ctx.businessId]);
      for(let i=0;i<3;i++) {
        const invoiceId=randomUUID();
        await tx.query("INSERT INTO invoice_snapshots(invoice_id,business_id,amount_minor,currency,issued_event_id) VALUES($1,$2,100,'EUR',$3)",[invoiceId,ctx.businessId,randomUUID()]);
        await tx.query(`INSERT INTO payment_attempts(id,business_id,invoice_id,connection_id,provider,amount_minor,currency,status,provider_reference,simulated,confirmed_at)
          VALUES($1,$2,$3,$4,'bank',100,'EUR',$5,$6,$7,$8)`,[randomUUID(),ctx.businessId,invoiceId,connectionId,i===2?'pending':'confirmed',`synthetic-transaction-${i}`,i===1,i===2?null:new Date(`2026-09-0${i+1}T12:00:00Z`)]);
      }
    });
    const page=await service.list(ctx,{limit:1});
    assert.equal(page.total,2);assert.equal(page.items.length,1);assert.equal(page.items[0]!.simulated,false);
    assert.equal(page.items[0]!.providerReference,'synthetic-transaction-0');
    assert.equal(JSON.stringify(page).includes('secret-not-exported'),false);
    const second=await service.list(ctx,{limit:1,offset:1});assert.equal(second.items[0]!.simulated,true);
    assert.deepEqual((await service.list(other,{})).items,[]);
  } finally {
    await db.withTenant(ctx.businessId,async tx=>{await tx.query('DELETE FROM payment_attempts');await tx.query('DELETE FROM invoice_snapshots');await tx.query('DELETE FROM payment_connections');});
    await pool.end();await original.end();
  }
});
