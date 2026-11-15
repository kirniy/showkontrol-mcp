import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const digest=(alg,s)=>createHash(alg).update(s).digest('hex');
const part=(name,s,md5=digest('md5',s))=>`<part name="${name}" md5="${md5}">${Buffer.from(s).toString('base64')}</part>`;
const program=timeline=>`<skprogram version="1"><item start="0" name="A" notes="">${timeline}</item><item start="1" name="B" notes=""/></skprogram>`;

test('MCP inspects embedded Program timelines with checks and bounded output',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-timeline-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const client=new Client({name:'program-timeline-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js']}));t.after(()=>client.close());
 const file=path.join(dir,'a.skpr'),show=path.join(dir,'a.skshow');
 const timeline='<sktimeline version="1" name="T"><layers><layer name="L"/></layers><audio preview="big"><clip path="x.wav" gain="1" waveformPreview="large"/></audio><cue id="c1" label="Intro" startMs="12" lenMs="30" layer="0"/></sktimeline>';
 const p=program(timeline),archive=`<skshow>${part('content/Program.skpr',p)}</skshow>`;await writeFile(file,p);await writeFile(show,archive);
 const call=(f,s,index=0)=>client.callTool({name:'showkontrol_inspect_program_timeline',arguments:{file:f,sha256:digest('sha256',s),index}});
 for(const [f,s] of [[file,p],[show,archive]]){const r=await call(f,s);assert.equal(r.isError,undefined,JSON.stringify(r));const data=JSON.parse(r.content[0].text);assert.equal(data.cueElements[0].attributes.id,'c1');assert.equal(data.layers[0].name,'L');assert.deepEqual(data.audioClips[0].attributes,{path:'x.wav',gain:'1'});assert.deepEqual(data.audio,[{}]);assert.match(data.note,/unverified/);}
 assert.equal((await call(file,p,1)).isError,true);assert.equal((await call(file,p,2)).isError,true);
 assert.equal((await call(file,'wrong')).isError,true);
 assert.equal((await client.callTool({name:'showkontrol_inspect_program_timeline',arguments:{file,sha256:'z'.repeat(64),index:0}})).isError,true);
 for(const invalid of [program('<sktimeline version="2"/>'),program('<sktimeline version="1"><cue></sktimeline>'),program('<sktimeline version="1"/><sktimeline version="1"/>')]){await writeFile(file,invalid);assert.equal((await call(file,invalid)).isError,true);}
 for(const bad of [`<skshow>${part('x','ok')}</skshow>`,`<skshow>${part('content/Program.skpr',p,'0'.repeat(32))}</skshow>`,`<skshow>${part('content/Program.skpr',p)}${part('content/Program.skpr',p)}</skshow>`]){await writeFile(show,bad);assert.equal((await call(show,bad)).isError,true);}
 const big=program(`<sktimeline version="1">${'<cue label="1234567890"/>'.repeat(20000)}</sktimeline>`);await writeFile(file,big);const limited=await call(file,big);assert.equal(limited.isError,true);assert.match(limited.content[0].text,/1 MiB/);
});
