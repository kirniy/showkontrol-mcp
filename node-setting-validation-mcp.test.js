import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP validates proposed settings against live node type metadata',async t=>{
 const requests=[];const mock=http.createServer((req,res)=>{requests.push([req.method,req.url]);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({request:'trigger',params:[{key:'trigger.on',kind:'enum',options:['On Change','State On']},{key:'trigger.release_ms',kind:'integer',min:0,max:10000},{key:'appact.track',kind:'enum'}]}));});
 await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));t.after(()=>{mock.closeAllConnections();mock.close()});
 const client=new Client({name:'node-validation-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}}));t.after(()=>client.close());
 const response=await client.callTool({name:'showkontrol_validate_node_settings',arguments:{request:'trigger',values:{'trigger.on':'State On','trigger.release_ms':10001,'appact.track':'Song'}}});
 assert.equal(response.isError,undefined);assert.deepEqual(JSON.parse(response.content[0].text).diagnostics.map(d=>[d.key,d.status]),[['trigger.on','valid'],['trigger.release_ms','invalid'],['appact.track','unknown']]);
 assert.deepEqual(requests,[['GET','/api/v1/nodes/types/trigger']]);
});
