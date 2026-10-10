import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import type {Request} from 'express';
import type {Database} from '@palladium/service-kit';
import {BusinessesController} from '../src/businesses.controller.js';
import {IdentityService} from '../src/identity.service.js';
const request={headers:{origin:'https://example.test','content-type':'application/json','content-length':'100'}} as Request;
const event={kind:'TypeError',source:'window',view:'dashboard'};
function controller(auth=true,origin=true){const calls:string[]=[];return {calls,controller:new BusinessesController({} as Database,{requireSession:async()=>{calls.push('session');if(!auth)throw new Error('session required');return {user:{id:'sensitive-user-id',name:'Sensitive Name',email:'private@example.test'}};},assertMutationOrigin:()=>{calls.push('origin');if(!origin)throw new Error('origin rejected');}} as unknown as IdentityService)};}
test('diagnostics require authenticated session and mutation origin before accepting telemetry',async()=>{
 const records:unknown[]=[];const old=console.warn;console.warn=(value)=>records.push(value);
 try{
  for(const [auth,origin,error] of [[false,true,/session required/],[true,false,/origin rejected/]] as const){const c=controller(auth,origin);await assert.rejects(c.controller.clientDiagnostics(request,{events:[event]}),error);assert.deepEqual(c.calls,auth?['session','origin']:['session']);}
  assert.deepEqual(records,[]);
 }finally{console.warn=old;}
});
test('diagnostics reject arbitrary fields, invalid enums, malformed headers and more than ten events without logging',async()=>{
 const records:unknown[]=[];const old=console.warn;console.warn=(value)=>records.push(value);
 try{
  for(const body of [{events:[]},{events:Array.from({length:11},()=>event)},{events:[{...event,message:'secret'}]},{events:[{...event,url:'https://private.test'}]},{events:[{...event,kind:'CustomSecretError'}]},{events:[{...event,source:'other'}]},{events:[{...event,view:'student-name'}]},{events:[event],businessId:'private'}])await assert.rejects(controller().controller.clientDiagnostics(request,body));
  for(const headers of [{'content-type':'text/plain'},{'content-type':'application/json','content-length':'2049'},{'content-type':'application/json','content-length':'invalid'}])await assert.rejects(controller().controller.clientDiagnostics({headers} as Request,{events:[event]}));
  await assert.rejects(controller().controller.clientDiagnostics({...request,rawBody:Buffer.alloc(2049)} as Request,{events:[event]}));
  assert.deepEqual(records,[]);
 }finally{console.warn=old;}
});
test('diagnostics emit only whitelisted categories and aggregate identical events without names or identifiers',async()=>{
 const records:string[]=[];const old=console.warn;console.warn=(value)=>records.push(value);
 try{
  const result=await controller().controller.clientDiagnostics(request,{events:[event,event,{kind:'UnknownError',source:'promise',view:'other'}]});assert.equal(result.item.accepted,3);assert.equal(records.length,2);
  const parsed=records.map(record=>JSON.parse(record));assert.equal(parsed[0].event,'browser_error');assert.equal(parsed[0].browserKind,'TypeError');assert.equal(parsed[0].source,'window');assert.equal(parsed[0].view,'dashboard');assert.equal(parsed[0].count,2);
  assert.doesNotMatch(records.join(''),/Sensitive|sensitive|private@example|message|stack|url|userId/);
 }finally{console.warn=old;}
});
