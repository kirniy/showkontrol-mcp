import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {renderMarkerCsv,writeMarkerCsv} from './marker-csv.js';

test('marker and region CSV follows REAPER columns, quoting and millisecond time',()=>{
 const csv=renderMarkerCsv({entries:[{kind:'marker',name:'Light, "GO"',seconds:3.5},{kind:'region',name:'Section',seconds:7,endSeconds:11},{kind:'marker',name:'Long',seconds:3661.001}]});
 assert.equal(csv,'#,Name,Start,End,Length\r\nM1,"Light, ""GO""",0:03.500,,\r\nR1,Section,0:07.000,0:11.000,0:04.000\r\nM2,Long,1:01:01.001,,\r\n');
 assert.throws(()=>renderMarkerCsv({entries:[{kind:'region',name:'x',seconds:1,endSeconds:1.0004}]}),/after start/);
 assert.throws(()=>renderMarkerCsv({entries:[{kind:'marker',name:'x\ny',seconds:1}]}),/single line/);
});
test('CSV creation does not overwrite existing files',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-csv-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'markers.csv');const entries=[{kind:'marker',name:'Start',seconds:0}];
 await writeMarkerCsv({file,entries});const data=await readFile(file,'utf8');await assert.rejects(writeMarkerCsv({file,entries}),/EEXIST/);assert.equal(await readFile(file,'utf8'),data);
});

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
test('MCP creates marker CSV and rejects an existing destination',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-csv-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const client=new Client({name:'test-csv',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const file=path.join(dir,'cues.csv');const args={file,entries:[{kind:'marker',name:'GO',seconds:3.5},{kind:'region',name:'Section',seconds:7,endSeconds:11}]};
 const result=await client.callTool({name:'showkontrol_create_marker_csv',arguments:args});assert.equal(result.isError,undefined);assert.equal(JSON.parse(result.content[0].text).entries,2);
 assert.match(await readFile(file,'utf8'),/R1,Section,0:07\.000,0:11\.000,0:04\.000/);
 const retry=await client.callTool({name:'showkontrol_create_marker_csv',arguments:args});assert.equal(retry.isError,true);
});
