import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('verifies live connections by IDs and pin labels or indices in one read', async t => {
 const wire=(node,index,pin,title)=>({node,index,pin,title});
 const a=wire('n2',0,'Data','Player1'), b=wire('n8',0,'Deck 1','A'), b2=wire('n8',1,'Deck 2','A');
 let response={connections:[{from:a,to:b},{from:a,to:b2}]}; const seen=[];
 const mock=http.createServer((req,res)=>{seen.push([req.method,req.url]);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(response));});
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));t.after(()=>mock.close());
 const client=new Client({name:'verify',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:{...process.env,SHOWKONTROL_URL:`http://127.0.0.1:${mock.address().port}`}}));t.after(()=>client.close());
 const invoke=async connections=>JSON.parse((await client.callTool({name:'showkontrol_verify_live_connections',arguments:{connections}})).content[0].text);
 const connections=[{from:{node:'n2',pin:'Data'},to:{node:'n8',pin:0}},{from:{node:'n2'},to:{node:'n8'}},{from:{node:'n2',pin:1},to:{node:'n8'}},{from:{node:'Player1'},to:{node:'n8'}},{from:{node:'n2'},to:{node:'n8',pin:'Deck 2'}}];
 let result=await invoke(connections);assert.equal(result.complete,true);assert.deepEqual(result.results.map(x=>x.status),['present','ambiguous','missing','missing','present']);assert.deepEqual(result.results[0].matches,[{from:{node:'n2',pin:'Data',index:0},to:{node:'n8',pin:'Deck 1',index:0}}]);assert.deepEqual(result.results[4].matches,[{from:{node:'n2',pin:'Data',index:0},to:{node:'n8',pin:'Deck 2',index:1}}]);
 response={connections:Array(25).fill({from:a,to:b})};result=await invoke([connections[0]]);assert.equal(result.results[0].status,'ambiguous');assert.equal(result.results[0].matchCount,25);assert.equal(result.results[0].matches.length,20);assert.equal(result.results[0].truncated,true);
 response={connections:[{from:a,to:b},{from:{...a,index:'0'},to:b}]};result=await invoke(connections);assert.equal(result.complete,false);assert.ok(result.results.every(x=>x.status==='incomplete'));assert.equal(result.results[0].matches.length,1);
 response={connections:'invalid'};result=await invoke(connections);assert.equal(result.complete,false);assert.ok(result.results.every(x=>x.status==='incomplete'));
 assert.deepEqual(seen,Array(4).fill(['GET','/api/v1/connections']));
 const invalid=await client.callTool({name:'showkontrol_verify_live_connections',arguments:{connections:Array(101).fill(connections[0])}});assert.equal(invalid.isError,true);assert.equal(seen.length,4);
});
