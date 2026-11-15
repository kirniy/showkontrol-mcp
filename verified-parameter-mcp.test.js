import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP verifies a write and handles malformed responses and timeouts without retry',async t=>{
 let mode='match';const seen=[];const mock=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;seen.push([req.method,req.url,body?JSON.parse(body):undefined]);if(mode==='put_timeout'&&req.method==='PUT'||mode==='get_timeout'&&req.method==='GET')return;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.method==='PUT'?(mode==='bad_put'?{}:{key:'a/b',value:{x:[1,true]}}):mode==='bad_get'?{}:{key:'a/b',value:mode==='mismatch'?false:{x:[1,true]}}));});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>{mock.closeAllConnections();mock.close()});const c=new Client({name:'test',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`,SHOWKONTROL_TIMEOUT_MS:'100'}}));t.after(()=>c.close());
 const invoke=async()=>JSON.parse((await c.callTool({name:'showkontrol_set_parameter_verified',arguments:{node:'n123',key:'a/b',value:{x:[1,true]}}})).content[0].text);
 for(const [m,status,count] of [['match','matched',2],['mismatch','mismatch',2],['bad_put','write_unknown',1],['bad_get','readback_unknown',2],['put_timeout','write_unknown',1],['get_timeout','readback_unknown',2]]){mode=m;const start=seen.length;assert.equal((await invoke()).status,status);assert.equal(seen.length-start,count)}
 assert.deepEqual(seen[0],['PUT','/api/v1/nodes/n123/params/a%2Fb',{value:{x:[1,true]}}]);assert.equal(seen[1][0],'GET');
 const start=seen.length;const invalid=await c.callTool({name:'showkontrol_set_parameter_verified',arguments:{node:'..',key:'x',value:null}});assert.equal(invalid.isError,true);assert.equal(seen.length,start);
});
