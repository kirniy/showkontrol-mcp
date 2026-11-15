import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {inspectShow} from './xml-copy.js';
const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
test('MCP clone opt-in propagates through compositions and rolls back',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'opaque-clone-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=n=>path.join(dir,n);
 const xml='<sktimeline version="1" name="Original" media="a"><layers><layer name="A"/></layers><cue id="c1"><graph><node id="n1" type="processor" kind=""><settings><setting key="proc.script">return n2;</setting></settings></node><node id="n2" type="x"/></graph></cue></sktimeline>';
 await writeFile(f('in.skshow'),`<skshow>${part('content/Original.sktl',xml)}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}</skshow>`);const sha256=(await inspectShow({file:f('in.skshow')})).sha256;
 const client=new Client({name:'test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const tools=(await client.listTools()).tools;
 const base={source:f('in.skshow'),sha256};const track={mediaClone:{templateName:'content/Original.sktl',cueMode:'copy'},trackName:'Clone',partName:'content/Clone.sktl'};
 const cases=[['showkontrol_clone_media_track_copy',true],['showkontrol_compose_show_copy',false],['showkontrol_compose_multi_track_show_copy',false],['showkontrol_compose_full_show_copy',false]];
 for(const [name,direct] of cases){
  assert.match(JSON.stringify(tools.find(x=>x.name===name).inputSchema),/allowOpaqueNodeText/);
  const build=(dest,opt)=>({...base,destination:f(dest),...(direct?{templateName:track.mediaClone.templateName,cueMode:'copy',trackName:track.trackName,partName:track.partName,...(opt?{allowOpaqueNodeText:true}:{})}:name==='showkontrol_compose_show_copy'?{...track,mediaClone:{...track.mediaClone,...(opt?{allowOpaqueNodeText:true}:{})}}:{tracks:[{...track,mediaClone:{...track.mediaClone,...(opt?{allowOpaqueNodeText:true}:{})}}]})});
  const failed=build(`${name}-bad.skshow`,false);const bad=await client.callTool({name,arguments:failed});assert.equal(bad.isError,true,JSON.stringify(bad));await assert.rejects(readFile(failed.destination),{code:'ENOENT'});
  const response=await client.callTool({name,arguments:build(`${name}-ok.skshow`,true)});assert.equal(response.isError,undefined,JSON.stringify(response));const result=JSON.parse(response.content[0].text),receipt=direct?result:name==='showkontrol_compose_show_copy'?result.mediaClone:result.tracks[0].mediaClone;const warning=result.warnings.find(w=>w.code==='opaque_node_references_unverified');assert.deepEqual(warning.scope,{part:track.partName,cueId:receipt.cueMapping.c1,nodeId:receipt.nodeMapping.n1,key:'proc.script'});assert.ok(!JSON.stringify(result).includes('return n2;'));assert.ok(!JSON.stringify(result).includes('.showkontrol-'));
 }
 const args={...base,destination:f('edited.skshow'),...track,mediaClone:{...track.mediaClone,allowOpaqueNodeText:true},graphSettingEdits:[{sourceCueId:'c1',sourceNodeId:'n1',key:'proc.script',value:'safe'}]};const edited=await client.callTool({name:'showkontrol_compose_show_copy',arguments:args});assert.equal(edited.isError,undefined,JSON.stringify(edited));assert.equal(JSON.parse(edited.content[0].text).warnings.filter(w=>w.code==='opaque_node_references_unverified').length,0);
 const same=await client.callTool({name:'showkontrol_compose_show_copy',arguments:{...args,destination:f('same.skshow'),graphSettingEdits:[{...args.graphSettingEdits[0],value:'return n2;'}]}});assert.equal(same.isError,undefined,JSON.stringify(same));assert.equal(JSON.parse(same.content[0].text).warnings.filter(w=>w.code==='opaque_node_references_unverified').length,1);
 const removed=await client.callTool({name:'showkontrol_compose_show_copy',arguments:{...base,destination:f('removed.skshow'),...track,mediaClone:{...track.mediaClone,allowOpaqueNodeText:true},cueRemovals:[{sourceCueId:'c1',deleteGraph:true}]}});assert.equal(removed.isError,undefined,JSON.stringify(removed));assert.equal(JSON.parse(removed.content[0].text).warnings.filter(w=>w.code==='opaque_node_references_unverified').length,0);
});
