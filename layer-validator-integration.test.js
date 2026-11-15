import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP registers layer editing and show validation',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-layers-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),appended=path.join(dir,'appended.skshow'),renamed=path.join(dir,'renamed.skshow');
 const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
 const timeline='<sktimeline version="1" name="Track"><layers><layer name="Layer 1" color="blue"/></layers><cue id="c1" layer="0"/></sktimeline>';
 const setlist='<sksetlist version="2"><set name="Main"><entry track="Track"/><entry track="Absent"/></set></sksetlist>';
 await writeFile(source,`<skshow>${part('content/Track.sktl',timeline)}${part('content/Setlist.skls',setlist)}</skshow>`);
 const client=new Client({name:'layer-validator-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const listed=await client.listTools();for(const name of ['showkontrol_edit_timeline_layer_copy','showkontrol_validate_show'])assert.ok(listed.tools.some(tool=>tool.name===name));
 const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined,JSON.stringify(result));return JSON.parse(result.content[0].text);};
 const partName='content/Track.sktl';
 const before=await call('showkontrol_inspect_show_timeline',{file:source,name:partName});
 await call('showkontrol_edit_timeline_layer_copy',{source,destination:appended,sha256:before.sha256,format:'skshow',name:partName,operation:'append',layerName:'Layer 1',newName:'Lights'});
 const after=await call('showkontrol_inspect_show_timeline',{file:appended,name:partName});
 assert.deepEqual(after.layers,[{name:'Layer 1',color:'blue'},{name:'Lights',color:'blue'}]);assert.deepEqual(after.cueElements,before.cueElements);
 await call('showkontrol_edit_timeline_layer_copy',{source:appended,destination:renamed,sha256:after.sha256,format:'skshow',name:partName,operation:'rename',layerName:'Lights',newName:'Effects'});
 const final=await call('showkontrol_inspect_show_timeline',{file:renamed,name:partName});assert.deepEqual(final.layers.map(layer=>layer.name),['Layer 1','Effects']);
 const validation=await call('showkontrol_validate_show',{file:renamed});
 assert.deepEqual(validation.diagnostics.map(d=>d.code),['missing_track']);assert.deepEqual(validation.diagnostics[0].scope,{part:'content/Setlist.skls',set:'Main',track:'Absent'});
});
