import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Reflector } from '@nestjs/core';
import type { RequestContext } from '@palladium/contracts';
import { assertHistoryAccess } from '../src/history.js';
import { HistoryImportsController, WorkLogController, InvoiceHistoryController, BusinessAnalyticsController } from '../src/history.controller.js';
const ctx={sub:'user',businessId:'business',role:'owner',entitlements:['billing'],requestId:'request'} as RequestContext;
test('Business financial history rejects learners, student-scoped tutors and missing permissions',()=>{
 assert.doesNotThrow(()=>assertHistoryAccess(ctx,true));
 for(const role of ['student','parent'] as const)assert.throws(()=>assertHistoryAccess({...ctx,role,permissions:['billing.read','billing.write','reporting.financial']},true),/business access/);
 assert.throws(()=>assertHistoryAccess({...ctx,role:'tutor',accessScope:'students'},true),/business access/);
 assert.throws(()=>assertHistoryAccess({...ctx,permissions:['billing.read']}),/not permitted/);
 assert.throws(()=>assertHistoryAccess({...ctx,permissions:['billing.read','reporting.financial']},true),/not permitted/);
});
test('Controller metadata requires financial/read capability and write on every mutation',()=>{
 const reflector=new Reflector();
 for(const type of [HistoryImportsController,WorkLogController,InvoiceHistoryController,BusinessAnalyticsController]){
 assert.deepEqual(reflector.get('palladium.roles',type),['owner','admin','tutor']);assert.equal(reflector.get('palladium.student-scoped',type),undefined);assert.deepEqual(reflector.get('palladium.permissions',type),['billing.read','reporting.financial']);}
 for(const handler of [HistoryImportsController.prototype.preview,HistoryImportsController.prototype.commit,WorkLogController.prototype.edit,WorkLogController.prototype.identity,InvoiceHistoryController.prototype.create,InvoiceHistoryController.prototype.edit])assert.deepEqual(reflector.get('palladium.permissions',handler),['billing.read','reporting.financial','billing.write']);
});
