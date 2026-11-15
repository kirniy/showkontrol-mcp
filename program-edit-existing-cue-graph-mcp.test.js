import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readShowPart} from './xml-copy.js';
const hash=(type,data)=>createHash(type).update(data).digest('hex');
const part=(name,data)=>`<part name="${name}" md5="${hash('md5',data)}">${Buffer.from(data).toString('base64')}</part>`;
test('MCP composers copy to an existing cue and reject ambiguous selectors atomically',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'existing-cue-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=name=>path.join(dir,name);
 const program='<skprogram version="1"><item start="0" name="A" notes=""><sktimeline version="1"><layers><layer name="Base"/></layers><cue id="existing" layer="0" startMs="0" lenMs="10" label="Old"/></sktimeline></item></skprogram>';
 const show=`<skshow>${part('content/Program.skpr',program)}</skshow>`;
 const donor='<sktimeline version="1"><layers/><cue id="donor"><graph><node id="n1" type="trigger"><settings><setting key="trigger.path">old</setting></settings></node></graph></cue></sktimeline>';
 await writeFile(f('source.skshow'),show);await writeFile(f('donor.sktl'),donor);
 const client=new Client({name:'existing-cue-copy-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const copy={action:'copy_timeline_cue_graph',index:0,cueId:'existing',donor:f('donor.sktl'),donorSha256:hash('sha256',donor),donorCueId:'donor'};
 for(const full of [false,true]){
  const name=full?'showkontrol_compose_full_show_copy':'showkontrol_compose_program_edits_copy';
  const base={source:f('source.skshow'),destination:f(`${full}.skshow`),sha256:hash('sha256',show)};
  const wrap=operations=>full?{program:{operations}}:{operations};
  const operations=[copy,{action:'edit_copied_timeline_graph_setting',index:0,graphFromOperation:0,donorNodeId:'n1',key:'trigger.path',value:'changed'}];
  const response=await client.callTool({name,arguments:{...base,...wrap(operations)}});assert.notEqual(response.isError,true,JSON.stringify(response));
  const result=JSON.parse(response.content[0].text),out=full?result.program:result;
  assert.equal(out.copiedCueGraphs[0].cueId,'existing');assert.ok(out.copiedCueGraphs[0].idMap.n1);
  const saved=(await readShowPart({file:base.destination,name:'content/Program.skpr'})).text;assert.match(saved,/>changed<\/setting>/);
  for(const [label,badOps] of [['both',[{...copy,cueFromOperation:0}]],['neither',[(({cueId,...rest})=>rest)(copy)]],['later',[copy,{action:'edit',index:99,name:'bad'}]]]){
   const destination=f(`${full}-${label}.skshow`);
   const failure=await client.callTool({name,arguments:{...base,destination,...wrap(badOps)}});
   assert.equal(failure.isError,true,JSON.stringify(failure));await assert.rejects(readFile(destination),{code:'ENOENT'});
  }
 }
 assert.equal(await readFile(f('source.skshow'),'utf8'),show);assert.equal(await readFile(f('donor.sktl'),'utf8'),donor);
});
