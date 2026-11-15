import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildLiveGraphPlan} from './live-graph-plan.js';

const nodes = [{ref:'a',request:'trigger',title:'Input',params:{mode:'Timer'}},{ref:'b',request:'action',title:'Output'}];
const connections = [{from:{node:'a',pin:0},to:{node:'b',pin:1}}];

test('previews nodes and validates translated titles without using preview IDs', async () => {
  const calls = [];
  const call = async (method,path,body) => {
    calls.push({method,path,body});
    if (path === '/nodes') return {dryRun:true,id:'temporary-id',title:calls.length === 1 ? 'Timer' : 'Notify'};
    return {dryRun:true,ok:true};
  };
  const result = await buildLiveGraphPlan({nodes,connections},call);
  const planNodes = [{request:'trigger',title:'Input',params:{mode:'Timer'}},{request:'action',title:'Output'}];
  const translated = [{from:{node:'Timer',pin:0},to:{node:'Notify',pin:1}}];
  assert.deepEqual(calls,[
    {method:'POST',path:'/nodes',body:{...planNodes[0],dryRun:true}},
    {method:'POST',path:'/nodes',body:{...planNodes[1],dryRun:true}},
    {method:'PUT',path:'/patch',body:{dryRun:true,nodes:planNodes,connections:translated}},
  ]);
  assert.deepEqual({...result.mapping},{a:'Timer',b:'Notify'});
  assert.deepEqual(result.nodes,planNodes);
  assert.deepEqual(result.connections,translated);
  assert.deepEqual(result.previews,[{ref:'a',title:'Timer'},{ref:'b',title:'Notify'}]);
  assert.deepEqual(result.validation,{dryRun:true,ok:true});
  assert.doesNotMatch(JSON.stringify(result),/temporary-id/);
});

test('rejects duplicate or unknown local references before any call', async () => {
  let calls = 0; const call = async () => {calls++;};
  await assert.rejects(buildLiveGraphPlan({nodes:[nodes[0],nodes[0]],connections:[]},call),/duplicate ref/);
  await assert.rejects(buildLiveGraphPlan({nodes,connections:[{from:{node:'a'},to:{node:'missing'}}]},call),/unknown node ref/);
  assert.equal(calls,0);
});

test('rejects ambiguous final titles and invalid preview responses', async () => {
  let calls = 0;
  await assert.rejects(buildLiveGraphPlan({nodes,connections},async () => {calls++; return {dryRun:true,title:'same'};}),/duplicate final node title/);
  assert.equal(calls,2);
  for (const response of [{dryRun:false,title:'x'},{dryRun:true,title:''},{dryRun:true,title:'x',success:false},{dryRun:true,title:'x',error:'bad'}]) {
    await assert.rejects(buildLiveGraphPlan({nodes:[nodes[0]],connections:[]},async () => response),/invalid node preview/);
  }
});

test('propagates call failures and rejects application validation failures', async () => {
  const failure = new Error('application failed');
  await assert.rejects(buildLiveGraphPlan({nodes:[nodes[0]],connections:[]},async () => {throw failure;}), e => e === failure);
  let calls = 0;
  await assert.rejects(buildLiveGraphPlan({nodes:[nodes[0]],connections:[]},async () => ++calls === 1 ? {dryRun:true,title:'x'} : {success:false}),/patch validation failed/);
  calls = 0;
  await assert.rejects(buildLiveGraphPlan({nodes:[nodes[0]],connections:[]},async () => {if (++calls === 1) return {dryRun:true,title:'x'}; throw failure;}), e => e === failure);
});

test('rejects missing or empty input titles before calling the app', async () => {
  let calls = 0;
  for (const title of [undefined, '', '   ']) {
    await assert.rejects(buildLiveGraphPlan({nodes:[{ref:'a',request:'group',title}],connections:[]},async () => {calls++;}),/nonempty ref, request and title/);
  }
  assert.equal(calls,0);
});

test('requires an explicit successful dry-run validation response', async () => {
  for (const response of [{ok:false,dryRun:true},{dryRun:true},{ok:true},{ok:true,dryRun:false},{}]) {
    let calls = 0;
    await assert.rejects(buildLiveGraphPlan({nodes:[nodes[0]],connections:[]},async () => ++calls === 1 ? {dryRun:true,title:'x'} : response),/patch validation failed/);
    assert.equal(calls,2);
  }
});


test('rejects ambiguous or empty existing endpoints before requests', async () => {
  let calls = 0;
  for (const endpoint of [{node:'a', existingNode:'n2'}, {existingNode:''}, {existingNode:'  '}, {}]) {
    await assert.rejects(buildLiveGraphPlan({nodes:[{ref:'a',request:'group',title:'Group'}], connections:[{from:endpoint,to:{node:'a'}}]}, async () => {calls++;}));
  }
  assert.equal(calls, 0);
});
