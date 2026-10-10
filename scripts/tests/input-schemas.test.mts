import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inputCatalog,reviewedInputs} from '../document-input-schemas.mts';
test('reviewed catalog stays deterministic and derives bounded strict request shapes from validators',async()=>{
 const first=await inputCatalog(),second=await inputCatalog();assert.deepEqual(first,second);
 assert.equal(first.inputs.length,3);
 for(const input of first.inputs){assert.match(input.sourceSha256,/^[a-f\d]{64}$/);assert.ok(input.sourceLine>0);assert.equal(input.jsonSchema.additionalProperties,false);}
 const reporting=first.inputs.find(input=>input.symbol==='summaryBatch')!;
 assert.equal(reporting.jsonSchema.properties.studentIds.minItems,1);assert.equal(reporting.jsonSchema.properties.studentIds.maxItems,100);
 const diagnostics=first.inputs.find(input=>input.symbol==='clientDiagnosticsSchema')!;
 assert.equal(diagnostics.jsonSchema.properties.events.maxItems,10);
 assert.equal(diagnostics.jsonSchema.properties.events.items.additionalProperties,false);
 assert.ok(first.scope.includes('not complete'));
});
test('documented requests are accepted by actual validators; custom refinements remain enforced',()=>{
 for(const input of reviewedInputs)assert.ok(input.schema.safeParse(input.example).success);
 const reporting=reviewedInputs.find(input=>input.symbol==='summaryBatch')!;
 assert.equal(reporting.schema.safeParse({...reporting.example,timeZone:'Invalid/Zone'}).success,false);
 const identity=reviewedInputs.find(input=>input.symbol==='reviewSchema')!;
 assert.equal(identity.schema.safeParse({...identity.example,status:'ambiguous'}).success,false);
 const diagnostics=reviewedInputs.find(input=>input.symbol==='clientDiagnosticsSchema')!;
 assert.equal(diagnostics.schema.safeParse({events:[{kind:'Error',source:'window',view:'other',message:'private'}]}).success,false);
});
