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
    res.end(JSON.stringify(seen.length === failAt && malformed ? {} : req.url.endsWith('/nodes') ? {id:`actual-${duplicateId ? 1 : seen.length}`, title:'Same'} : {ok:true, ...(badWire ? {wire:{from:{node:'wrong'},to:{node:'wrong'}}} : {})}));
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
