import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {survivingOpaqueWarnings} from './composition-warnings.js';

const hash=(alg,s)=>createHash(alg).update(s).digest('hex');
const part=(n,s)=>`<part name="${n}" md5="${hash('md5',s)}">${Buffer.from(s).toString('base64')}</part>`;
test('composition MCP preserves scoped opaque warnings without exposing text',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'opaque-show-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=n=>path.join(dir,n);
 const script='secret n123 content';
 const input=`<skshow>${part('Empty.sktl','<sktimeline version="1" name="Empty"><layers><layer name="L"/></layers></sktimeline>')}${part('patch.skf','<showkontrol version="2"><graph/><appSettings/></showkontrol>')}</skshow>`;
 const donor=`<skshow>${part('Donor.sktl',`<sktimeline version="1"><cue id="src"><graph><node id="n1" type="processor" kind=""><settings><setting key="proc.script">${script}</setting></settings></node></graph></cue></sktimeline>`)}</skshow>`;
 await Promise.all([writeFile(f('source.skshow'),input),writeFile(f('donor.skshow'),donor)]);
 const client=new Client({name:'opaque-show-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});assert.equal(r.isError,undefined,JSON.stringify(r));return JSON.parse(r.content[0].text);};
 const node={kind:'cue',template:f('donor.skshow'),templateSha256:hash('sha256',donor),templateName:'Donor.sktl',templateCueId:'src',nodeId:'n1',allowOpaqueNodeText:true};
 const cue={layer:0,startMs:0,lengthMs:40,label:'Cue',mixedGraph:{nodes:[node]}};
 const track={templateName:'Empty.sktl',trackName:'New',partName:'content/New.sktl',cues:[cue]};
 const base={source:f('source.skshow'),sha256:hash('sha256',input)};
 for(const [name,args] of [['showkontrol_compose_show_copy',track],['showkontrol_compose_multi_track_show_copy',{tracks:[track]}],['showkontrol_compose_full_show_copy',{tracks:[track]}]]){
  const r=await call(name,{...base,destination:f(`${name}.skshow`),...args});const c=r.cues?.[0]??r.tracks[0].cues[0];
  assert.equal(r.warnings.length,1);assert.deepEqual(r.warnings[0].scope,{part:'content/New.sktl',cueId:c.id,nodeId:c.nodeIds[0],key:'proc.script'});assert.equal(r.warnings[0].code,'opaque_node_references_unverified');assert.ok(!JSON.stringify(r).includes(script));assert.ok(!JSON.stringify(r).includes('.showkontrol-'));
 }
 const clean={...track,cues:[{...cue,settings:[{nodeIndex:0,key:'proc.script',value:'safe'}]}]};
 const r=await call('showkontrol_compose_multi_track_show_copy',{...base,destination:f('clean.skshow'),tracks:[clean]});assert.deepEqual(r.warnings,[]);
 // Cue IDs are generated at runtime, so a later track in the same request cannot
 // name a newly created cue. Exercise the final-state filter with a later MCP edit.
 const staged=await call('showkontrol_compose_show_copy',{...base,destination:f('staged.skshow'),...track});
 const c=staged.cues[0], later={source:f('staged.skshow'),sha256:staged.sha256};
 const edited=await call('showkontrol_compose_multi_track_show_copy',{...later,destination:f('edited.skshow'),tracks:[{existingPartName:track.partName,graphSettingEdits:[{cueId:c.id,nodeId:c.nodeIds[0],key:'proc.script',value:'safe'}]}]});
 assert.deepEqual(await survivingOpaqueWarnings(edited.destination,edited.sha256,staged.warnings),[]);
 const removed=await call('showkontrol_compose_multi_track_show_copy',{...later,destination:f('removed.skshow'),tracks:[{existingPartName:track.partName,cueRemovals:[{cueId:c.id,deleteGraph:true}]}]});
 assert.deepEqual(await survivingOpaqueWarnings(removed.destination,removed.sha256,staged.warnings),[]);
 const graphDonor={file:f('donor.skshow'),sha256:hash('sha256',donor),name:'Donor.sktl',cueId:'src'};
 const donorTrack={...track,donor:graphDonor,cues:[{layer:0,startMs:0,lengthMs:40,label:'Cue'}]};
 const rejected=await client.callTool({name:'showkontrol_compose_show_copy',arguments:{...base,destination:f('rejected.skshow'),...donorTrack}});assert.equal(rejected.isError,true);
 for(const [name,args] of [['showkontrol_compose_show_copy', {...donorTrack,donor:{...graphDonor,allowOpaqueNodeText:true}}],['showkontrol_compose_multi_track_show_copy',{tracks:[{...donorTrack,donor:{...graphDonor,allowOpaqueNodeText:true}}]}],['showkontrol_compose_full_show_copy',{tracks:[{...donorTrack,donor:{...graphDonor,allowOpaqueNodeText:true}}]}]]){
  const result=await call(name,{...base,destination:f(`donor-${name}.skshow`),...args});const c=result.cues?.[0]??result.tracks[0].cues[0];
  assert.deepEqual(result.warnings[0].scope,{part:'content/New.sktl',cueId:c.id,nodeId:c.idMap.n1,key:'proc.script'});assert.ok(!JSON.stringify(result).includes(script));
 }
});
