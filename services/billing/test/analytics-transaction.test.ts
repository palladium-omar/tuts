import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Database } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import { HistoryService } from '../src/history.js';
import { HistoryAnalyticsService } from '../src/history-analytics.js';

test('production Database analytics keeps unlinked hours and money, exact ranges and tenant isolation', { skip: !process.env.BILLING_TEST_DATABASE_URL }, async () => {
  const db = new Database(), original = db.pool;
  const pool = new Pool({ connectionString: process.env.BILLING_TEST_DATABASE_URL, max: 2 });
  Object.defineProperty(db, 'pool', { value: pool });
  const ctx: RequestContext = { businessId: randomUUID(), sub: 'synthetic-reviewer', role: 'owner', entitlements: ['billing'], requestId: randomUUID() };
  const other = { ...ctx, businessId: randomUUID() };
  const history = new HistoryService(db), analytics = new HistoryAnalyticsService(db);
  try {
    const role = (await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
    await db.withTenant(ctx.businessId, tx => tx.query("INSERT INTO billing_settings(business_id,time_zone) VALUES($1,'Africa/Casablanca')", [ctx.businessId]));
    // The same production helper must retain its snapshot when another scoped
    // transaction commits between reads; no isolation SQL is intercepted.
    await db.withTenant(ctx.businessId, async tx => {
      assert.equal((await tx.query('SELECT time_zone FROM billing_settings')).rows[0].time_zone, 'Africa/Casablanca');
      await db.withTenant(ctx.businessId, writer => writer.query("UPDATE billing_settings SET time_zone='UTC'"));
      assert.equal((await tx.query('SELECT time_zone FROM billing_settings')).rows[0].time_zone, 'Africa/Casablanca');
    }, { isolation: 'repeatable read' });
    await db.withTenant(ctx.businessId, tx => tx.query("UPDATE billing_settings SET time_zone='Africa/Casablanca'"));
    const preview = await history.preview(ctx, { originalname: 'synthetic-work.csv', buffer: Buffer.from('Date,Student Name,Hours Worked,Hourly Rate,Invoice Status\n2026-09-01,Synthetic A,1.5,40,Paid\n2026-09-02,Synthetic B,0.25,20,Pending\n2026-08-01,Synthetic A,1,10,Unsent') }, { kind: 'work', currency: 'EUR' });
    await history.commit(ctx, { token: preview.token }, 'synthetic-commit');
    const result = await analytics.analytics(ctx, { month: '2026-09' });
    assert.equal(result.timeZone, 'Africa/Casablanca');
    assert.equal(result.engagement.totalHours, 2.75); assert.equal(result.engagement.monthHours, 1.75);
    assert.equal(result.students.tracked, null); assert.equal(result.students.activeThisMonth, null);
    assert.equal(result.engagement.averageCommitmentHours, null); assert.equal(result.engagement.averageClassFrequency, null);
    assert.equal(result.coverage.studentIdentity, 'partial_reviewed_work_identities');
    assert.ok(result.trend.every(row => row.activeStudents === null && row.classes === null));
    const ledger = result.currencies[0]!;
    assert.equal(ledger.ledgerTotalMinor, 7500); assert.equal(ledger.ledgerPaidMinor, 6000);
    assert.equal(ledger.ledgerPendingMinor, 500); assert.equal(ledger.ledgerUnsentMinor, 1000);
    assert.equal(ledger.ledgerMonthMinor, 6500); assert.equal(ledger.expectedThisMonthMinor, 6500);
    assert.equal(ledger.totalRecordedRevenueMinor, null); assert.equal(ledger.verifiedCollectedMinor, null);
    const absentMonth = await analytics.analytics(ctx, { month: '2026-10' });
    assert.equal(absentMonth.engagement.monthHours, 0); assert.equal(absentMonth.currencies[0]!.ledgerMonthMinor, 0);
    const isolated = await analytics.analytics(other, { month: '2026-09' });
    assert.deepEqual(isolated.currencies, []); assert.equal(isolated.engagement.totalHours, null);
    await db.withTenant(ctx.businessId, tx => tx.query('UPDATE billing_work_log SET amount_minor=$1', [Number.MAX_SAFE_INTEGER]));
    await assert.rejects(analytics.analytics(ctx, { month: '2026-09' }), /supported exact monetary range/);
  } finally {
    await db.withTenant(ctx.businessId, async tx => {
      await tx.query('DELETE FROM billing_work_log'); await tx.query('DELETE FROM billing_history_sources');
      await tx.query('DELETE FROM billing_settings');
      await tx.query('DELETE FROM billing_idempotency');
      await tx.query("DELETE FROM service_outbox WHERE event->>'businessId'=$1", [ctx.businessId]);
    });
    await pool.end(); await original.end();
  }
});
