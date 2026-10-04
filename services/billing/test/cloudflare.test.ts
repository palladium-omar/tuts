import "reflect-metadata";
import test from "node:test";
import assert from "node:assert/strict";
import { MonthlyService } from "../src/monthly.js";

test("Worker initialization registers class projection without opening polling/database work", () => {
  const previous = process.env.TUTS_RUNTIME;
  process.env.TUTS_RUNTIME = "cloudflare";
  try {
    const subscriptions: string[] = [];
    const service = new MonthlyService({} as any, { subscribe(type: string) { subscriptions.push(type); } } as any);
    service.runAutomatic = async () => { throw new Error("Initialization must not poll"); };
    service.onModuleInit();
    assert.deepEqual(subscriptions, ["scheduling.class-updated.v1"]);
    assert.equal((service as any).timer, undefined);
  } finally { if (previous === undefined) delete process.env.TUTS_RUNTIME; else process.env.TUTS_RUNTIME = previous; }
});
