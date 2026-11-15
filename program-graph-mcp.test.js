import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const hash=(algorithm,b)=>createHash(algorithm).update(b).digest('hex');
test('MCP copies exact cue graph to Program and guards failures',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'program-graph-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const client=new Client({name:'program-graph-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:['server.js']}));t.after(()=>client.close());
 const call=args=>client.callTool({name:'showkontrol_copy_program_item_graph_copy',arguments:args});
 const file=n=>path.join(dir,n),source=file('in.skpr'),donor=file('donor.sktl'),show=file('donor.skshow'),out=file('out.skpr');
 const timeline='<sktimeline version="1"><layers/><cue id="c1"><graph><node id="n1" type="groupin"/><node id="n2" type="trigger"><settings><setting key="trigger.path" value="cue.active"/></settings></node><connection from="n1" to="n2"/></graph></cue></sktimeline>';
 const graph=timeline.slice(timeline.indexOf('<graph>'),timeline.indexOf('</graph>')+8);
 const program='<skprogram version="1"><item start="1" name="A &amp; B" notes="n"><sktimeline version="1"><layers/></sktimeline></item></skprogram>';
 const wrapper=`<skshow><part name="content/a.sktl" md5="${hash('md5',timeline)}">${Buffer.from(timeline).toString('base64')}</part></skshow>`;
 await Promise.all([writeFile(source,program),writeFile(donor,timeline),writeFile(show,wrapper)]);
 const args={source,destination:out,sha256:hash('sha256',program),index:0,donor,donorSha256:hash('sha256',timeline),donorCueId:'c1'};
 const result=await call(args);assert.equal(result.isError,undefined);assert.match(JSON.parse(result.content[0].text).warnings.join(' '),/cue.active to item.active/);
 assert.equal(await readFile(out,'utf8'),program.replace('</item>',graph+'</item>'));
 const fromShow=file('show.skpr');assert.equal((await call({...args,destination:fromShow,donor:show,donorSha256:hash('sha256',wrapper),donorName:'content/a.sktl'})).isError,undefined);assert.equal(await readFile(fromShow,'utf8'),await readFile(out,'utf8'));
 const existing=await readFile(out);const guarded={...args,source:out,sha256:hash('sha256',existing),destination:file('replace.skpr')};assert.equal((await call(guarded)).isError,true);assert.equal((await call({...guarded,replaceExisting:true})).isError,undefined);assert.deepEqual(await readFile(guarded.destination),existing);
 assert.equal((await call(args)).isError,true);assert.deepEqual(await readFile(out),existing);
 for(const override of [{sha256:'0'.repeat(64)},{donorSha256:'0'.repeat(64)},{donorCueId:'missing'},{index:9}]){const destination=file(`bad-${Object.keys(override)[0]}.skpr`);assert.equal((await call({...args,...override,destination})).isError,true);await assert.rejects(readFile(destination),{code:'ENOENT'});}
 for(const [name,content] of [['multiple',timeline.replace('</cue>',graph+'</cue>')],['missing',timeline.replace(graph,'')],['duplicate',timeline.replace('</sktimeline>',timeline.slice(timeline.indexOf('<cue'),timeline.indexOf('</cue>')+6)+'</sktimeline>')],['invalid','<sktimeline version="1"><cue>']]){const target=file(name+'.sktl');await writeFile(target,content);assert.equal((await call({...args,donor:target,donorSha256:hash('sha256',content),destination:file(name+'.skpr')})).isError,true);}
 const corrupt=wrapper.replace(/md5="[a-f0-9]+"/,'md5="00000000000000000000000000000000"');await writeFile(show,corrupt);assert.equal((await call({...args,donor:show,donorName:'content/a.sktl',donorSha256:hash('sha256',corrupt),destination:file('corrupt.skpr')})).isError,true);
});
