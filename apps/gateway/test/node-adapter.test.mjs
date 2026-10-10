import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {createNodeGateway} from '../src/node-adapter.ts';
test('Node adapter shares private-path and origin protections, headers and cookie separation',async()=>{
 let seen;
 const binding={async fetch(r){seen=r;const h=new Headers({'content-type':'application/json'});h.append('set-cookie','one=1; Path=/');h.append('set-cookie','two=2; Path=/');return new Response('{}',{headers:h});}};
 const env={ASSETS:binding,PLATFORM:binding,PUBLIC_APP_URL:'https://tuts.example.test',PUBLIC_GATEWAY_URL:'http://127.0.0.1',CONTEXT_PRIVATE_KEY:'unused',PLATFORM_INTERNAL_SECRET:'internal',INTERNAL_RUNTIME_SECRET:'unused'};
 const server=createServer(createNodeGateway(env));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 try{
   const r=await fetch(origin+'/api/platform/v1/session',{headers:{'cf-connecting-ip':'forged','x-platform-internal-secret':'forged'}});assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/no-store/);assert.equal(r.headers.getSetCookie().length,2);assert.notEqual(seen.headers.get('x-real-ip'),'forged');assert.equal(seen.headers.get('x-platform-internal-secret'),null);
   assert.equal((await fetch(origin+'/api/platform/internal/context')).status,404);
   assert.equal((await fetch(origin+'/api/platform/auth/sign-out',{method:'POST',headers:{origin:'https://attacker.test'}})).status,403);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
