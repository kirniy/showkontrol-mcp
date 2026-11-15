import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('staged live graph uses actual IDs and stops on every failed write', async t => {
  const seen = []; let failAt = 0; let malformed = false; let duplicateId = false; let badWire = false;
  const mock = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    seen.push({method:req.method, url:req.url, body:JSON.parse(raw)});
    if (seen.length === failAt && !malformed) { res.writeHead(500, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'private value'})); return; }
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(seen.length === failAt && malformed ? {} : req.url.endsWith('/nodes') ? {id:`actual-${duplicateId ? 1 : seen.length}`, title:'Same', params:Object.entries(seen.at(-1).body.params || {}).map(([key,value]) => ({key,value}))} : {ok:true, wire:badWire ? {from:{node:'wrong'},to:{node:'wrong'}} : {from:{node:seen.at(-1).body.from.node,index:seen.at(-1).body.from.pin,pin:seen.at(-1).body.from.pin},to:{node:seen.at(-1).body.to.node,index:seen.at(-1).body.to.pin,pin:seen.at(-1).body.to.pin}}}));
  });
  await new Promise(resolve => mock.listen(0,'127.0.0.1',resolve)); t.after(() => mock.close());
  const client = new Client({name:'staged-test',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}})); t.after(() => client.close());
  const nodes = [{ref:'a',request:'action',title:'Same'}, {ref:'b',request:'action',title:'Same',params:{x:1}}];
  const connections = [{from:{node:'a',pin:0},to:{node:'b',pin:0}}, {from:{existingNode:'existing'},to:{node:'a'}}];
  const invoke = args => client.callTool({name:'showkontrol_create_staged_live_graph',arguments:args});
  for (const invalid of [{nodes:[nodes[0],nodes[0]],connections:[]}, {nodes,connections:[{from:{node:'a'},to:{node:'missing'}}]}, {nodes:[],connections:[]}, {nodes:Array(51).fill(nodes[0]),connections:[]}]) assert.equal((await invoke(invalid)).isError,true);
  assert.equal(seen.length,0);
  const result = JSON.parse((await invoke({nodes,connections})).content[0].text);
  assert.equal(result.status,'complete');
  assert.deepEqual(result.completedNodes,[{ref:'a',id:'actual-1'},{ref:'b',id:'actual-2'}]);
  assert.deepEqual(seen.map(x=>x.body),[{request:'action',title:'Same',dryRun:false},{request:'action',title:'Same',params:{x:1},dryRun:false},{from:{node:'actual-1',pin:0},to:{node:'actual-2',pin:0},dryRun:false},{from:{node:'existing'},to:{node:'actual-1'},dryRun:false}]);
  assert.ok(seen.every(x=>x.method==='POST'));
  for (const index of [1,2,3,4]) {
    seen.length=0; failAt=index;
    const report = JSON.parse((await invoke({nodes,connections})).content[0].text);
    assert.equal(report.status,'partial'); assert.equal(seen.length,index);
    assert.deepEqual(report.failedStage,{stage:index <= 2 ? 'node':'connection',index:index <= 2 ? index-1:index-3});
    assert.equal(report.completedNodes.length,Math.min(index-1,2));
    assert.equal(report.completedConnections.length,Math.max(0,index-3));
    assert.match(report.outcomeUnknown,/may have taken effect/);
    assert.doesNotMatch(JSON.stringify(report),/private value/);
  }
  seen.length=0; failAt=2; malformed=true;
  const uncertain=JSON.parse((await invoke({nodes,connections})).content[0].text);
  assert.equal(uncertain.status,'partial'); assert.equal(seen.length,2); assert.equal(uncertain.completedNodes.length,1);
  seen.length=0; failAt=0; malformed=false; duplicateId=true;
  const duplicate=JSON.parse((await invoke({nodes,connections})).content[0].text);
  assert.equal(duplicate.status,'partial'); assert.equal(seen.length,2);
  assert.deepEqual(duplicate.failedStage,{stage:'node',index:1});
  assert.deepEqual(duplicate.completedNodes,[{ref:'a',id:'actual-1'}]);
  assert.match(duplicate.error,/ID already returned/); assert.match(duplicate.outcomeUnknown,/may have taken effect/);
  seen.length=0; duplicateId=false; badWire=true;
  const mismatch=JSON.parse((await invoke({nodes,connections})).content[0].text);
  assert.equal(mismatch.status,'partial'); assert.equal(seen.length,3);
  assert.deepEqual(mismatch.failedStage,{stage:'connection',index:0});
  assert.equal(mismatch.completedConnections.length,0); assert.match(mismatch.error,/did not match/);
});

test('staged live graph verifies requested pin values and stops on unknown outcomes', async t => {
  const seen = []; let responseWire;
  const mock = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    seen.push(JSON.parse(raw));
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true, ...(responseWire === undefined ? {} : {wire:responseWire})}));
  });
  await new Promise(resolve => mock.listen(0,'127.0.0.1',resolve)); t.after(() => mock.close());
  const client = new Client({name:'pin-verification-test',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}})); t.after(() => client.close());
  const invoke = async (from, to) => JSON.parse((await client.callTool({name:'showkontrol_create_staged_live_graph',arguments:{nodes:[],connections:[{from:{existingNode:'a',...from},to:{existingNode:'b',...to}},{from:{existingNode:'a'},to:{existingNode:'b'}}]}})).content[0].text);
  for (const [from,to,wire] of [
    [{pin:1},{pin:2},{from:{node:'a',index:0},to:{node:'b',index:2}}],
    [{pin:1},{pin:2},{from:{node:'a',index:1},to:{node:'b',index:0}}],
    [{pin:'Out'},{pin:'In'},{from:{node:'a',pin:'Other'},to:{node:'b',pin:'In'}}],
    [{pin:'Out'},{pin:'In'},{from:{node:'a',pin:'Out'},to:{node:'b'}}],
    [{pin:0},{},{from:{node:'a'},to:{node:'b'}}],
    [{},{},undefined],
  ]) {
    seen.length=0; responseWire=wire; const result=await invoke(from,to);
    assert.equal(result.status,'partial'); assert.deepEqual(result.failedStage,{stage:'connection',index:0});
    assert.equal(result.completedConnections.length,0); assert.equal(seen.length,1); assert.match(result.outcomeUnknown,/may have taken effect/);
  }
  seen.length=0; responseWire={from:{node:'a',index:1,pin:'Out'},to:{node:'b',index:2,pin:'In'}};
  const result=await invoke({pin:1},{pin:'In'});
  assert.equal(result.status,'complete'); assert.equal(result.completedConnections.length,2); assert.equal(seen.length,2);
});

test('staged graph reports sanitized validation and transport errors without further writes', async t => {
  const seen = []; let mode = 'validation';
  const mock = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    seen.push({url:req.url, body:JSON.parse(raw)});
    if (seen.length === 1) { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({id:'known-id'})); return; }
    if (mode === 'validation') { res.writeHead(422, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Invalid pin: token-secret and pair-secret\ninvalid', extra:'do not expose'})); }
    else if (mode === 'connection') req.socket.destroy();
    // Leave the timeout request open until the client aborts it.
  });
  await new Promise(resolve => mock.listen(0,'127.0.0.1',resolve)); t.after(() => { mock.closeAllConnections(); mock.close(); });
  const client = new Client({name:'staged-errors-test',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`,SHOWKONTROL_TIMEOUT_MS:'100',SHOWKONTROL_TOKEN:'token-secret',SHOWKONTROL_PAIR_KEY:'pair-secret'}})); t.after(() => client.close());
  const args = {nodes:[{ref:'a',request:'action',title:'A'}],connections:[{from:{node:'a'},to:{existingNode:'b'}},{from:{node:'a'},to:{existingNode:'c'}}]};
  for (mode of ['validation','connection','timeout']) {
    seen.length = 0;
    const report = JSON.parse((await client.callTool({name:'showkontrol_create_staged_live_graph',arguments:args})).content[0].text);
    assert.equal(report.status,'partial');
    assert.deepEqual(report.completedNodes,[{ref:'a',id:'known-id'}]);
    assert.deepEqual(report.completedConnections,[]);
    assert.deepEqual(report.failedStage,{stage:'connection',index:0});
    assert.equal(seen.length,2);
    assert.match(report.outcomeUnknown,/may have taken effect/);
    if (mode === 'validation') assert.equal(report.error,'HTTP 422: Invalid pin: [redacted] and [redacted] invalid (POST /api/v1/connections)');
    if (mode === 'connection') assert.match(report.error,/connection failed; no automatic retry/);
    if (mode === 'timeout') assert.match(report.error,/timed out.*no automatic retry/);
    assert.doesNotMatch(JSON.stringify(report),/token-secret|pair-secret|do not expose/);
  }
});

test('staged graph checks requested node parameters before later writes', async t => {
  const seen = []; let params;
  const mock = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    seen.push(JSON.parse(raw));
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({id:'created-id', ...(params === undefined ? {} : {params})}));
  });
  await new Promise(resolve => mock.listen(0,'127.0.0.1',resolve)); t.after(() => mock.close());
  const client = new Client({name:'staged-params-test',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}})); t.after(() => client.close());
  const args = {nodes:[{ref:'a',request:'group',title:'A',params:{'node.stopped':'not_boolean',nested:{a:1,b:[true,null]}}},{ref:'b',request:'group',title:'B'}],connections:[{from:{node:'a'},to:{node:'b'}}]};
  for (params of [undefined, [], [{key:'node.stopped',value:false}], [{key:'node.stopped',value:'not_boolean'},{key:'node.stopped',value:'not_boolean'},{key:'nested',value:{a:1,b:[true,null]}}], [{key:'node.stopped',value:'not_boolean'},{key:'nested',value:{a:1,b:[true,'null']}}]]) {
    seen.length = 0;
    const report = JSON.parse((await client.callTool({name:'showkontrol_create_staged_live_graph',arguments:args})).content[0].text);
    assert.equal(report.status,'partial'); assert.deepEqual(report.failedStage,{stage:'node',index:0});
    assert.deepEqual(report.completedNodes,[{ref:'a',id:'created-id'}]); assert.deepEqual(report.completedConnections,[]);
    assert.match(report.error,/may have changed the value or omitted it/); assert.match(report.outcomeUnknown,/may have taken effect/);
    assert.equal(seen.length,1);
  }
  params = [{key:'node.stopped',value:'not_boolean'},{key:'nested',value:{b:[true,null],a:1}}];
  seen.length = 0;
  const result = JSON.parse((await client.callTool({name:'showkontrol_create_staged_live_graph',arguments:{nodes:[args.nodes[0]],connections:[]}})).content[0].text);
  assert.equal(result.status,'complete'); assert.equal(seen.length,1);
});
