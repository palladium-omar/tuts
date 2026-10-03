import assert from 'node:assert/strict';
import test from 'node:test';
import { allocatePayment, invoiceSchema, totalMinor } from '../src/financial.js';
import { requestHash } from '../src/idempotency.js';
test('invoice quantities use exact integer multiplication and zero-decimal currencies',()=>{
  const input=invoiceSchema.parse({payerName:'Demo payer',currency:'JPY',items:[{description:'Lesson',quantity:3,unitPriceMinor:1200},{description:'Materials',quantity:2,unitPriceMinor:75}]});
  assert.equal(totalMinor(input.items),3750);
});
test('money rejects fractional values, client-authoritative totals and unsafe aggregate arithmetic',()=>{
  assert.throws(()=>invoiceSchema.parse({payerName:'Demo',currency:'USD',totalMinor:1,items:[{description:'Lesson',quantity:1,unitPriceMinor:1}]}));
  assert.throws(()=>invoiceSchema.parse({payerName:'Demo',currency:'USD',items:[{description:'Lesson',quantity:1,unitPriceMinor:1.5}]}));
  assert.throws(()=>totalMinor([{description:'Lesson',quantity:2,unitPriceMinor:Number.MAX_SAFE_INTEGER}]));
  assert.throws(()=>totalMinor([{description:'Free',quantity:1,unitPriceMinor:0}]));
});
test('partial allocation stays issued and exact remaining amount settles',()=>{
  const invoice={status:'issued',currency:'USD',totalMinor:12000,paidMinor:0};
  const partial=allocatePayment(invoice,{currency:'USD',amountMinor:4000});
  assert.deepEqual(partial,{paidMinor:4000,status:'issued'});
  assert.deepEqual(allocatePayment({...invoice,...partial},{currency:'USD',amountMinor:8000}),{paidMinor:12000,status:'settled'});
});
test('draft, mismatched currency and overpayment cannot settle an invoice',()=>{
  const invoice={status:'issued',currency:'USD',totalMinor:100,paidMinor:50};
  assert.throws(()=>allocatePayment({...invoice,status:'draft'},{currency:'USD',amountMinor:50}));
  assert.throws(()=>allocatePayment(invoice,{currency:'EUR',amountMinor:50}));
  assert.throws(()=>allocatePayment(invoice,{currency:'USD',amountMinor:51}));
});
test('idempotency fingerprint ignores object key order, preserves values and item order',()=>{
  assert.equal(requestHash({a:1,b:{c:2}}),requestHash({b:{c:2},a:1}));
  assert.notEqual(requestHash({a:1}),requestHash({a:2}));
  assert.notEqual(requestHash({items:[1,2]}),requestHash({items:[2,1]}));
});
