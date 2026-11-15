import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {createHash} from 'node:crypto';import path from 'node:path';import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
test('MCP overview and paged part read use a consistent hash',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-overview-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'show.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const timeline='<sktimeline version="1" name="Track"><layers><layer name="Layer 1"/></layers><cue id="c1" label="🎵"/></sktimeline>';
 const show=`<skshow>${part('patch.skf','<showkontrol version="2" name="Show"><graph><node id="n1" type="trigger" title="Start"><settings/></node></graph><appSettings/></showkontrol>')}${part('content/Track.sktl',timeline)}${part('content/Setlist.skls','<sksetlist version="2" active="0"><set name="Set 1"><entry track="Track"/></set></sksetlist>')}</skshow>`;await writeFile(file,show);
 const client=new Client({name:'overview-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const names=(await client.listTools()).tools.map(t=>t.name);for(const name of ['showkontrol_inspect_show_overview','showkontrol_read_show_part_page'])assert.ok(names.includes(name));
 const call=(name,args)=>client.callTool({name,arguments:args}), parse=r=>JSON.parse(r.content[0].text);
 const summary=await call('showkontrol_inspect_show_overview',{file});assert.equal(summary.isError,undefined);const overview=parse(summary);assert.equal(overview.timelines[0].name,'Track');assert.equal(overview.timelines[0].cueCount,1);assert.deepEqual(overview.setlists[0].sets[0].tracks,['Track']);assert.equal(overview.patch.nodes[0].id,'n1');
 let offset=0,text='',pages=0;do{const response=await call('showkontrol_read_show_part_page',{file,name:'content/Track.sktl',offset,limit:7,sha256:overview.sha256});assert.equal(response.isError,undefined);const page=parse(response);text+=page.text;offset=page.nextOffset;pages++;}while(offset!==null);
 assert.ok(pages>1);assert.equal(text,timeline);
 await writeFile(file,show.replace('<skshow>','<skshow name="Changed">'));const stale=await call('showkontrol_read_show_part_page',{file,name:'content/Track.sktl',offset:0,limit:7,sha256:overview.sha256});assert.equal(stale.isError,true);assert.match(stale.content[0].text,/changed/i);
});
test('MCP overview summarizes the canonical Program and rejects invalid Program parts',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-overview-program-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'show.skshow');
 const part=(name,body,md5=createHash('md5').update(body).digest('hex'))=>`<part name="${name}" md5="${md5}">${Buffer.from(body).toString('base64')}</part>`;
 const program='<skprogram version="1"><item start="12.5" name="Intro" notes="Ready"><graph/><sktimeline/></item><item start="30" name="Next" notes=""/></skprogram>';
 const client=new Client({name:'overview-program-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=()=>client.callTool({name:'showkontrol_inspect_show_overview',arguments:{file}});
 await writeFile(file,`<skshow>${part('content/Program.skpr',program)}</skshow>`);
 let response=await call();assert.equal(response.isError,undefined);const overview=JSON.parse(response.content[0].text);
 assert.deepEqual(overview.program.items,[{index:0,start:12.5,name:'Intro',notes:'Ready',hasGraph:true,hasTimeline:true},{index:1,start:30,name:'Next',notes:'',hasGraph:false,hasTimeline:false}]);
 assert.equal(overview.program.programSha256,createHash('sha256').update(program).digest('hex'));assert.match(overview.program.note,/not verified/);
 for(const bad of [
  part('content/Program.skpr','<skprogram version="1"><item start="1" name="x" notes=""><unknown/></item></skprogram>'),
  part('content/Program.skpr',program,'00000000000000000000000000000000'),
  part('content/program.skpr',program),
  part('content/Program.skpr',program)+part('CONTENT/PROGRAM.SKPR',program),
  part('content/Program.skpr',`<skprogram version="1">${'<item start="1" name="x" notes=""/>'.repeat(1001)}</skprogram>`),
 ]){await writeFile(file,`<skshow>${bad}</skshow>`);response=await call();assert.equal(response.isError,true);}
});
