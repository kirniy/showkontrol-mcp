import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('live node diagnostic compares only unambiguous boolean states',async t=>{
 // The response ID equals the requested identifier, so only the stopped-state warning applies.
 let response={id:'n / 1',title:'Test',type:'trigger',stopped:true,params:[{key:'node.stopped',value:false}]};
 const seen=[];const mock=http.createServer((req,res)=>{seen.push([req.method,req.url]);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(response));});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
 const client=new Client({name:'node-diagnostic-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}}));t.after(()=>client.close());
 const get=async()=>{const r=await client.callTool({name:'showkontrol_diagnose_live_node',arguments:{id:'n / 1'}});assert.equal(r.isError,undefined);return JSON.parse(r.content[0].text);};
 let result=await get();assert.equal(result.id,'n / 1');assert.equal(result.title,'Test');assert.equal(result.type,'trigger');assert.equal(result.requestedStopped,false);assert.equal(result.effectiveStopped,true);assert.equal(result.raw.requestedMatches[0].value,false);assert.equal(result.raw.effectiveStopped,true);assert.equal(result.warnings.length,1);
 response={stopped:false,params:[{key:'node.stopped',value:false}]};result=await get();assert.equal(result.requestedStopped,false);assert.equal(result.effectiveStopped,false);assert.deepEqual(result.warnings,[]);
 for(const bad of [{},{stopped:'true',params:[{key:'node.stopped',value:'false'}]},{stopped:null,params:[{key:'node.stopped',value:false},{key:'node.stopped',value:false}]},'invalid']){response=bad;result=await get();assert.equal(result.requestedStopped,'unknown');assert.equal(result.effectiveStopped,'unknown');assert.deepEqual(result.warnings,[]);}
 assert.deepEqual(seen,Array(6).fill(['GET','/api/v1/nodes/n%20%2F%201']));
 const invalid=await client.callTool({name:'showkontrol_diagnose_live_node',arguments:{id:'..'}});assert.equal(invalid.isError,true);assert.equal(seen.length,6);
});
