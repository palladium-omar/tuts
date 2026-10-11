import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiError,createApi,errorMessage,isAuthenticationRequired} from '../lib/api';
const requestId='9d641b30-9c33-4c2f-92eb-208a4b9870ec';
test('anonymous session HTTP401 has a typed authentication error and preserves support text',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'A valid browser session is required',code:'AUTH_REQUIRED'}}),{status:401,headers:{'x-request-id':requestId}});
 try {
  await assert.rejects(createApi()('platform/v1/session'),error=>{
   assert.ok(error instanceof ApiError);assert.equal(error.status,401);assert.equal(error.code,'AUTH_REQUIRED');assert.equal(isAuthenticationRequired(error),true);
   assert.equal(errorMessage(error),`A valid browser session is required Reference: ${requestId}`);return true;
  });
 }finally{globalThis.fetch=original;}
});
test('forbidden, server and network errors never become expected anonymous sessions',async()=>{
 const original=globalThis.fetch;
 try {
  for(const status of [403,500]) {
   globalThis.fetch=async()=>new Response(JSON.stringify({message:['First problem','Second problem'],code:'ERROR'}),{status});
   await assert.rejects(createApi()('platform/v1/session'),error=>{
    assert.ok(error instanceof ApiError);assert.equal(error.status,status);assert.equal(isAuthenticationRequired(error),false);assert.equal(errorMessage(error),'First problem. Second problem');return true;
   });
  }
  globalThis.fetch=async()=>{throw new TypeError('Network failed');};
  await assert.rejects(createApi()('platform/v1/session'),error=>{assert.equal(isAuthenticationRequired(error),false);assert.equal(errorMessage(error),'Network failed');return true;});
  for(const value of [new Error('A valid browser session is required'),{status:401},null,undefined])assert.equal(isAuthenticationRequired(value),false);
 }finally{globalThis.fetch=original;}
});
test('unstructured HTTP errors keep the status fallback without inventing a code',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response('unstructured',{status:502});
 try{await assert.rejects(createApi()('platform/v1/session'),error=>{assert.ok(error instanceof ApiError);assert.equal(errorMessage(error),'Request failed (502)');assert.equal(error.code,undefined);return true;});}
 finally{globalThis.fetch=original;}
});
