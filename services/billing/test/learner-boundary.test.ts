import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { StudentFinanceController } from '../src/student-finance.js';
test('student financial history is restricted to staff roles and billing capability', () => {
  assert.deepEqual(Reflect.getMetadata('palladium.roles', StudentFinanceController), ['owner', 'admin', 'tutor']);
  assert.deepEqual(Reflect.getMetadata('palladium.permissions', StudentFinanceController), ['billing.read']);
});
