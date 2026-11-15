import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';import os from 'node:os';
import {inspectSessionMedia} from './session-media.js';
const part=(name,text)=>`<part name="${name}" md5="${createHash('md5').update(text).digest('hex')}">${Buffer.from(text).toString('base64')}</part>`;
test('reports mapped sidecars, missing files, traversal and symlinks without opening them',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-session-'));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(path.join(dir,'MEDIA'));await writeFile(path.join(dir,'MEDIA','a.wav'),'audio');await symlink('/tmp',path.join(dir,'MEDIA','link'));
 const map=['/a\tMEDIA/a.wav','/b\tMEDIA/missing.wav','/c\tMEDIA/../outside','/d\tMEDIA/link/file.wav'].join('\n');await writeFile(path.join(dir,'session.skshow'),`<skshow>${part('media.map',map)}</skshow>`);
 const r=await inspectSessionMedia({directory:dir});assert.deepEqual(r.findings.map(x=>x.status),['regular_file','missing','unsafe_path','symlink']);assert.equal(r.findings[0].size,5);await assert.rejects(inspectSessionMedia({directory:'relative'}),/absolute/);
});
test('MCP exposes session sidecar inventory',async t=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-session-mcp-'));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(path.join(dir,'MEDIA'));await writeFile(path.join(dir,'MEDIA','test.wav'),'x');await writeFile(path.join(dir,'session.skshow'),`<skshow>${part('media.map','/source\tMEDIA/test.wav')}</skshow>`);
 const client=new Client({name:'session-media-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js'],env:process.env}));t.after(()=>client.close());
 const response=await client.callTool({name:'showkontrol_inspect_session_media',arguments:{directory:dir}});assert.equal(response.isError,undefined);assert.equal(JSON.parse(response.content[0].text).findings[0].status,'regular_file');
});
