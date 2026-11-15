import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildLiveGraphPlan} from './live-graph-plan.js';

const nodes = [{ref:'a',request:'trigger',title:'Input',params:{mode:'Timer'}},{ref:'b',request:'action',title:'Output'}];
const connections = [{from:{node:'a',pin:0},to:{node:'b',pin:1}}];

test('previews nodes and validates translated titles without using preview IDs', async () => {
  const calls = [];
  const call = async (method,path,body) => {
    calls.push({method,path,body});
    if (path === '/nodes') return {dryRun:true,id:'temporary-id',title:calls.length === 1 ? 'Timer' : 'Notify',params:[{key:'mode',value:'Timer'}]};
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
  assert.deepEqual(result.previews,[{ref:'a',title:'Timer',paramComparison:{requestedCount:1,issueCount:0,issues:[],truncated:false}},{ref:'b',title:'Notify',paramComparison:{requestedCount:0,issueCount:0,issues:[],truncated:false}}]);
  assert.deepEqual(result.validation,{dryRun:true,ok:true});
  assert.doesNotMatch(JSON.stringify(result),/temporary-id/);
});

test('reports preview parameter mismatches, missing values, and ambiguous duplicates without changing the plan', async () => {
  const params = {coerced:'not_boolean', missing:1, duplicate:true, exact:{a:[1, false]}, absentValue:2};
  const node = {ref:'a', request:'trigger', title:'Input', params};
  const result = await buildLiveGraphPlan({nodes:[node], connections:[]}, async (method, path) => path === '/nodes'
    ? {dryRun:true, title:'Input', params:[{key:'coerced',value:false},{key:'duplicate',value:true},{key:'duplicate',value:true},{key:'exact',value:{a:[1,false]}},{key:'absentValue'}]}
    : {ok:true,dryRun:true});
  assert.deepEqual(result.nodes[0].params, params);
  assert.deepEqual(result.previews[0].paramComparison, {requestedCount:5,issueCount:4,issues:[{key:'coerced',kind:'mismatch'},{key:'missing',kind:'missing'},{key:'duplicate',kind:'ambiguous'},{key:'absentValue',kind:'ambiguous'}],truncated:false});
  const unknown = await buildLiveGraphPlan({nodes:[node],connections:[]}, async (method,path) => path === '/nodes' ? {dryRun:true,title:'Input'} : {ok:true,dryRun:true});
  assert.equal(unknown.previews[0].paramComparison.issueCount,5);
  assert.ok(unknown.previews[0].paramComparison.issues.every(issue => issue.kind === 'ambiguous'));
});

test('caps preview parameter diagnostics while retaining the issue count', async () => {
  const params = Object.fromEntries(Array.from({length:105}, (_, i) => [`key${i}`, i]));
  const result = await buildLiveGraphPlan({nodes:[{ref:'a',request:'trigger',title:'Input',params}],connections:[]}, async (method,path) => path === '/nodes' ? {dryRun:true,title:'Input',params:[]} : {ok:true,dryRun:true});
  assert.equal(result.previews[0].paramComparison.issueCount,105);
  assert.equal(result.previews[0].paramComparison.issues.length,100);
  assert.equal(result.previews[0].paramComparison.truncated,true);
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

test('validates existing-node connections with one patch dry run and no previews', async () => {
  const calls = [];
  const connections = [{from:{existingNode:'n2',pin:0},to:{existingNode:'n3',pin:'input'}}];
  const result = await buildLiveGraphPlan({nodes:[],connections}, async (method,path,body) => {
    calls.push({method,path,body});
    return {ok:true,dryRun:true};
  });
  const translated = [{from:{node:'n2',pin:0},to:{node:'n3',pin:'input'}}];
  assert.deepEqual(calls,[{method:'PUT',path:'/patch',body:{dryRun:true,nodes:[],connections:translated}}]);
  assert.deepEqual(result.nodes,[]);
  assert.deepEqual(result.connections,translated);
  assert.deepEqual({...result.mapping},{});
  assert.deepEqual(result.previews,[]);
});

test('rejects an empty plan and unknown references without calls', async () => {
  let calls = 0;
  const call = async () => {calls++;};
  await assert.rejects(buildLiveGraphPlan({nodes:[],connections:[]},call),/cannot both be empty/);
  await assert.rejects(buildLiveGraphPlan({nodes:[],connections:[{from:{existingNode:'n2'},to:{node:'missing'}}]},call),/unknown node ref/);
  assert.equal(calls,0);
});
