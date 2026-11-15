import test from 'node:test';import assert from 'node:assert/strict';import {validateNodeSettings} from './node-setting-validation.js';
// Representative fields from a live ShowKontrol R27 trigger node-type response.
const schema={request:'trigger',type:'trigger',params:[{key:'node.bypassed',kind:'boolean',value:false},{key:'node.description',kind:'text',value:''},{key:'trigger.on',kind:'enum',options:['On Change','On Receive','State On','State Off','On Increase','On Decrease','Equals'],value:'On Change'},{key:'trigger.release_ms',kind:'integer',min:0,max:10000,value:0},{key:'appact.track',kind:'enum',value:''},{key:'flash.color',kind:'color',value:'#FFFFFF'}]};
test('checks typed values, explicit options, and integer bounds',()=>{
 const result=validateNodeSettings({schema,values:{'node.bypassed':false,'node.description':'Hello','trigger.on':'State On','trigger.release_ms':10000}});
 assert.deepEqual(result.diagnostics.map(d=>d.status),['valid','valid','valid','valid']);
 const bad=validateNodeSettings({schema,values:{'node.bypassed':'false','node.description':3,'trigger.on':'state on','trigger.release_ms':10001}});
 assert.deepEqual(bad.diagnostics.map(d=>d.status),['invalid','invalid','invalid','invalid']);
});
test('reports unknown coverage for absent, ambiguous, or incomplete metadata',()=>{
 const extended={...schema,params:[...schema.params,{key:'duplicate',kind:'text'},{key:'duplicate',kind:'text'},{key:'bad.bounds',kind:'integer',min:'0'}]};
 const result=validateNodeSettings({schema:extended,values:{'appact.track':'Anything','flash.color':'#000000',missing:1,duplicate:'x','bad.bounds':0}});
 assert.deepEqual(result.diagnostics.map(d=>d.status),['unknown','unknown','unknown','unknown','unknown']);
});
test('validates finite numbers against finite optional bounds',()=>{
 const meta={params:[{key:'gain',kind:'number',min:-1.5,max:2.25},{key:'open',kind:'number'},{key:'bad',kind:'number',min:NaN},{key:'bad2',kind:'number',min:3,max:2}]};
 const check=values=>validateNodeSettings({schema:meta,values}).diagnostics.map(d=>d.status);
 assert.deepEqual(check({gain:2.25,open:-0.125,bad:1,bad2:2}),['valid','valid','unknown','unknown']);
 assert.deepEqual(check({gain:2.26,open:Infinity}),['invalid','invalid']);
 assert.deepEqual(check({gain:'1'}),['invalid']);
});
