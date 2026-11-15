import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setVerifiedParameter} from './verified-parameter.js';
const args={node:'n123',key:'a/b',value:{nested:[1,false,null]}};
test('writes once, encodes segments and compares JSON deeply',async()=>{const calls=[];const r=await setVerifiedParameter(args,async(...a)=>{calls.push(a);return a[0]==='PUT'?{key:args.key,value:args.value}:{key:args.key,value:{nested:[1,false,null]}}});assert.equal(r.status,'matched');assert.deepEqual(calls,[['PUT','/nodes/n123/params/a%2Fb',{value:args.value}],['GET','/nodes/n123/params/a%2Fb']]);});
test('reports mismatch without disclosing values',async()=>{const r=await setVerifiedParameter(args,async m=>m==='PUT'?{key:args.key,value:args.value}:{key:args.key,value:'secret'});assert.equal(r.status,'mismatch');assert(!JSON.stringify(r).includes('secret'));});
test('failed and malformed writes are unknown and are not retried',async()=>{for(const result of [null,{},[],{ok:false},{success:false},{key:args.key,value:args.value,success:false},{error:'secret'},'bad',new Error('secret')]){let calls=0;const r=await setVerifiedParameter(args,async()=>{calls++;if(result instanceof Error)throw result;return result});assert.equal(r.status,'write_unknown');assert.equal(calls,1);assert(!JSON.stringify(r).includes('secret'));}});
test('failed and malformed readbacks are unknown',async()=>{for(const result of [null,{},[],{key:'wrong',value:1},{key:args.key},new Error('secret')]){let calls=0;const r=await setVerifiedParameter(args,async()=>{calls++;if(calls===1)return {key:args.key,value:args.value};if(result instanceof Error)throw result;return result});assert.equal(r.status,'readback_unknown');assert.equal(calls,2);assert(!JSON.stringify(r).includes('secret'));}});
test('rejects invalid segments before writing',async()=>{for(const part of ['', ' ','.','..'])for(const field of ['node','key']){let calls=0;await assert.rejects(setVerifiedParameter({...args,[field]:part},async()=>{calls++}));assert.equal(calls,0);}});

test('a match can be a preexisting value and carries a concurrency warning',async()=>{const r=await setVerifiedParameter(args,async m=>m==='PUT'?{key:args.key,value:args.value}:{key:args.key,value:args.value});assert.equal(r.status,'matched');assert.match(r.warning,/existed before/);});

test('rejects names instead of observed node ID format',async()=>{let calls=0;await assert.rejects(setVerifiedParameter({...args,node:'Group'},async()=>{calls++}));assert.equal(calls,0);});
