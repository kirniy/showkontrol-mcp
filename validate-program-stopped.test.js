import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {validateShow} from './validate-show.js';

const part=(name,xml)=>`<part name="${name}" md5="${createHash('md5').update(xml).digest('hex')}">${Buffer.from(xml).toString('base64')}</part>`;
const item=body=>`<item start="0" name="A" notes="">${body}</item>`;
const warnings=result=>result.diagnostics.filter(d=>d.code==='stored_stopped_cue_node');

test('checks stored stopped values in Program item and embedded cue graphs with scopes',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-stopped-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'show.skshow');
 const program=`<skprogram version="1">${item('<graph><node id="both" stopped="1"><settings><setting key="node.stopped">true</setting></settings></node><node id="false" stopped="0"><settings><setting key="node.stopped">false</setting></settings></node><node id="unknown" stopped="true"><settings><setting key="node.stopped"> true </setting></settings></node></graph>')}${item('<sktimeline version="1"><layers><layer/></layers><cue id="first" layer="0" startMs="0" lenMs="1"/><cue id="second" layer="0" startMs="1" lenMs="1"><graph><node id="setting"><settings><setting key="node.stopped"><![CDATA[true]]></setting></settings></node><node id="conflict" stopped="1"><settings><setting key="node.stopped">false</setting></settings></node><node id="off" stopped="0"/></graph><extension><graph><node id="nested" stopped="1"/></graph></extension></cue></sktimeline>')}</skprogram>`;
 await writeFile(file,`<skshow>${part('content/Program.skpr',program)}</skshow>`);
 const result=await validateShow({file});
 assert.deepEqual(warnings(result).map(d=>d.scope),[
  {part:'content/Program.skpr',path:'skprogram/item/graph',itemIndex:0,nodeId:'both'},
  {part:'content/Program.skpr',itemIndex:1,path:'skprogram/item/sktimeline/cue/graph',cueIndex:1,cueId:'second',nodeId:'setting'},
  {part:'content/Program.skpr',itemIndex:1,path:'skprogram/item/sktimeline/cue/graph',cueIndex:1,cueId:'second',nodeId:'conflict'}
 ]);
 assert.ok(warnings(result).every(d=>d.severity==='warning'));
 assert.equal(result.coverage[0].status,'partial');
 assert.ok(result.diagnostics.some(d=>d.code==='unsupported_graph'&&d.scope.path.endsWith('/extension/graph')));
 const client=new Client({name:'program-stopped-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const response=await client.callTool({name:'showkontrol_validate_show',arguments:{file}});assert.equal(response.isError,undefined,JSON.stringify(response));
 assert.deepEqual(warnings(JSON.parse(response.content[0].text)),warnings(result));
});
