import assert from 'node:assert/strict';
import test from 'node:test';
import {skipDetector} from './test-output.mjs';
test('database runner rejects TAP, Unicode pretty and split skipped output',()=>{
 for(const parts of [['# skipped 2'],['ℹ skipped 3'],['﹣ skipped test # SKIP'],['ℹ ski','pped ','1'],['\u001b[32mℹ skipped 14\u001b[0m']]){const detector=skipDetector();parts.forEach(part=>detector.observe(part));assert.equal(detector.hasSkipped(),true);}
});
test('zero skips and normal test descriptions pass',()=>{
 const detector=skipDetector();['# skipped 0','ℹ skipped 0','✔ skipped detection fixture','ℹ pass 10'].forEach(part=>detector.observe(part+'\n'));assert.equal(detector.hasSkipped(),false);
});

test('stderr interleaving does not corrupt split stdout summary',()=>{const detector=skipDetector();detector.observe('ℹ ski');detector.observe('a separate log\n','stderr');detector.observe('pped 1');assert.equal(detector.hasSkipped(),true);});
