import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP graph planner previews and validates a reusable plan without applying it', async t => {
  const seen = [];
  const mock = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    seen.push({method:req.method, url:req.url, body});
    const response = req.url === '/api/v1/nodes'
      ? {dryRun:true, id:`temporary-${seen.length}`, title:body.request === 'trigger' ? 'cue_active' : 'FeedbackNotify'}
      : {ok:true, dryRun:true};
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(response));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  t.after(() => mock.close());
  const client = new Client({name:'graph-plan-integration-test', version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath, args:['server.js'], env:{...process.env, SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}}));
  t.after(() => client.close());

  const nodes = [{ref:'trigger', request:'trigger', title:'Trigger', params:{'trigger.mode':'Timer'}}, {ref:'notify', request:'action', title:'Action'}];
  const connections = [{from:{node:'trigger', pin:0}, to:{node:'notify', pin:0}}];
  const result = await client.callTool({name:'showkontrol_plan_live_graph', arguments:{nodes, connections}});
  assert.equal(result.isError, undefined);
  const plan = JSON.parse(result.content[0].text);
  const expectedNodes = [{request:'trigger', title:'Trigger', params:{'trigger.mode':'Timer'}}, {request:'action', title:'Action'}];
  const expectedConnections = [{from:{node:'cue_active', pin:0}, to:{node:'FeedbackNotify', pin:0}}];
  assert.deepEqual(plan.nodes, expectedNodes);
  assert.deepEqual(plan.connections, expectedConnections);
  assert.deepEqual(plan.mapping, {trigger:'cue_active', notify:'FeedbackNotify'});
  assert.doesNotMatch(JSON.stringify(plan), /temporary-/);
  assert.deepEqual(seen, [
    {method:'POST', url:'/api/v1/nodes', body:{...expectedNodes[0], dryRun:true}},
    {method:'POST', url:'/api/v1/nodes', body:{...expectedNodes[1], dryRun:true}},
    {method:'PUT', url:'/api/v1/patch', body:{dryRun:true, nodes:expectedNodes, connections:expectedConnections}},
  ]);

  for (const invalid of [
    {nodes:[nodes[0], nodes[0]], connections:[]},
    {nodes, connections:[{from:{node:'trigger'}, to:{node:'missing'}}]},
    {nodes, connections:[{from:{node:'trigger', existingNode:'n2'}, to:{node:'notify'}}]},
    {nodes, connections:[{from:{existingNode:'  '}, to:{node:'notify'}}]},
  ]) {
    const rejected = await client.callTool({name:'showkontrol_plan_live_graph', arguments:invalid});
    assert.equal(rejected.isError, true);
  }
  assert.equal(seen.length, 3);

  const mixedConnections = [
    {from:{existingNode:'n2', pin:0}, to:{node:'trigger'}},
    {from:{node:'notify'}, to:{existingNode:'n3', pin:'input'}},
    {from:{existingNode:'n2'}, to:{existingNode:'n3'}},
  ];
  const mixed = await client.callTool({name:'showkontrol_plan_live_graph', arguments:{nodes, connections:mixedConnections}});
  assert.equal(mixed.isError, undefined);
  const mixedPlan = JSON.parse(mixed.content[0].text);
  assert.deepEqual(mixedPlan.connections, [
    {from:{node:'n2', pin:0}, to:{node:'cue_active'}},
    {from:{node:'FeedbackNotify'}, to:{node:'n3', pin:'input'}},
    {from:{node:'n2'}, to:{node:'n3'}},
  ]);
  assert.deepEqual(seen.at(-1).body.connections, mixedPlan.connections);
  assert.doesNotMatch(JSON.stringify(mixedPlan), /temporary-/);
});
