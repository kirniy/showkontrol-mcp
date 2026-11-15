import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP discovers and applies offline cue deletion and set list editing',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-authoring-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),afterCue=path.join(dir,'cue.skshow'),afterSet=path.join(dir,'set.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const timeline='<sktimeline version="1"><layers><layer name="Layer 1"/></layers><cue id="c1" layer="0" startMs="0.0" lenMs="40.0" label="Cue"><graph><node id="n154" type="groupin"><settings/></node></graph></cue><cue id="c2" layer="0" startMs="1000.0" lenMs="40.0" label="Other"/></sktimeline>';
 const setlist='<sksetlist version="2" active="0"><set name="Set 1"><entry track="Track"/><entry track="Track 2"/></set></sksetlist>';
 await writeFile(source,`<skshow>${part('content/Track.sktl',timeline)}${part('content/Setlist.skls',setlist)}${part('patch.skf','<showkontrol version="2"/>')}</skshow>`);
 const client=new Client({name:'authoring-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const listed=await client.listTools();for(const name of ['showkontrol_delete_timeline_cue_copy','showkontrol_edit_show_setlist_copy'])assert.ok(listed.tools.some(tool=>tool.name===name));
 const call=async(name,args)=>client.callTool({name,arguments:args});const parse=r=>JSON.parse(r.content[0].text);
 const inspected=await call('showkontrol_inspect_show_timeline',{file:source,name:'content/Track.sktl'});assert.equal(inspected.isError,undefined);
 const args={source,destination:afterCue,format:'skshow',sha256:parse(inspected).sha256,name:'content/Track.sktl',cueId:'c1'};
 const blocked=await call('showkontrol_delete_timeline_cue_copy',args);assert.equal(blocked.isError,true);
 const deleted=await call('showkontrol_delete_timeline_cue_copy',{...args,deleteGraph:true});assert.equal(deleted.isError,undefined);
 const readCue=await call('showkontrol_inspect_show_timeline',{file:afterCue,name:'content/Track.sktl'});assert.deepEqual(parse(readCue).cueElements.map(c=>c.attributes.id),['c2']);
 const set=await call('showkontrol_inspect_show_setlist',{file:afterCue,name:'content/Setlist.skls'});
 const edited=await call('showkontrol_edit_show_setlist_copy',{source:afterCue,destination:afterSet,sha256:parse(set).sha256,name:'content/Setlist.skls',operation:'move_track',setName:'Set 1',index:0,toIndex:1});assert.equal(edited.isError,undefined);
 const readSet=await call('showkontrol_inspect_show_setlist',{file:afterSet,name:'content/Setlist.skls'});assert.deepEqual(parse(readSet).sets[0].tracks,['Track 2','Track']);
});
