import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ReportingController } from '../src/reporting.controller.js';
test('summary, activity history and reconciliation belong to the tutor workspace', () => {
  for (const method of ['summary', 'summaries', 'reconcile', 'history'] as const) {
    assert.deepEqual(Reflect.getMetadata('palladium.roles', ReportingController.prototype[method]), ['owner', 'admin', 'tutor']);
  }
  assert.deepEqual(Reflect.getMetadata('palladium.roles', ReportingController.prototype.activity), ['student']);
  assert.deepEqual(Reflect.getMetadata('palladium.permissions', ReportingController.prototype.activity), ['reporting.write']);
});
