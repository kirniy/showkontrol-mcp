import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('typed live patch sends one exact request and validates input', async t => {
 const seen=[];
 const mock=http.createServer(async (req,res)=>{let body='';for await(const chunk of req) body+=chunk;seen.push({method:req.method,url:req.url,body:JSON.parse(body)});res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":"test"}');});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
 const client=new Client({name:'patch-compose-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}}));t.after(()=>client.close());
 const nodes=[{request:'group',title:'MCP_ALIAS_A'},{request:'group',title:'MCP_ALIAS_B'}];
 const connections=[{from:{node:'MCP_ALIAS_A',pin:0},to:{node:'MCP_ALIAS_B',pin:0}}];
 const invoke=arguments_=>client.callTool({name:'showkontrol_compose_live_patch',arguments:arguments_});
 assert.equal((await invoke({nodes,connections})).isError,true);
 assert.deepEqual(seen,[{method:'PUT',url:'/api/v1/patch',body:{dryRun:true,nodes,connections}}]);
 assert.equal((await invoke({nodes:[{request:'other:type',title:'Other'}],connections:[],dryRun:false})).isError,true);
 assert.deepEqual(seen[1].body,{dryRun:false,nodes:[{request:'other:type',title:'Other'}],connections:[]});
 assert.equal((await invoke({nodes,connections:[{from:{node:'MCP_ALIAS_A'},to:{node:'MCP_ALIAS_B'}}]})).isError,true);
 assert.deepEqual(seen[2].body,{dryRun:true,nodes,connections:[{from:{node:'MCP_ALIAS_A'},to:{node:'MCP_ALIAS_B'}}]});
 for(const args of [{nodes:[{request:'group',title:'a',alias:'x'}],connections:[]},{nodes,connections:[{from:{node:'a',pin:-1},to:{node:'b',pin:0}}]},{nodes,connections,dryRun:'false'}]) assert.equal((await invoke(args)).isError,true);
 assert.equal(seen.length,3);
});
