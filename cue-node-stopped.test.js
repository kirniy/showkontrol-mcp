import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {setCueGraphNodeStoppedCopy} from './timeline.js';
import {inspectXml,inspectShow,readShowPart} from './xml-copy.js';

const hash=(algorithm,text)=>createHash(algorithm).update(text).digest('hex');
const timeline=(node)=>`<sktimeline version="1"><cue id="c"><graph>${node}</graph></cue></sktimeline>`;
const node=`<node type="trigger" stopped='1' id="n"><settings><setting key="node.stopped">true</setting><setting key="other">keep</setting></settings></node>`;
const part=(name,text)=>`<part name="${name}" md5="${hash('md5',text)}">${Buffer.from(text).toString('base64')}</part>`;

test('updates both app-like representations in show and is idempotent in timeline',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-stop-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'in.skshow'),destination=path.join(dir,'out.skshow'),original=timeline(node),other='<showkontrol version="2"/>';
 await writeFile(source,`<skshow>${part('content/t.sktl',original)}${part('patch.skf',other)}</skshow>`);
 const sha256=(await inspectShow({file:source})).sha256;
 await setCueGraphNodeStoppedCopy({source,destination,format:'skshow',sha256,name:'content/t.sktl',cueId:'c',nodeId:'n',stopped:false});
 const expected=original.replace("stopped='1'","stopped='0'").replace('>true</setting>','>false</setting>');
 assert.equal((await readShowPart({file:destination,name:'content/t.sktl'})).text,expected);
 assert.equal((await readShowPart({file:destination,name:'patch.skf'})).text,other);
 assert.ok((await inspectShow({file:destination})).parts.every(p=>p.valid));
 const standalone=path.join(dir,'in.sktl'),out=path.join(dir,'out.sktl');await writeFile(standalone,expected);
 await setCueGraphNodeStoppedCopy({source:standalone,destination:out,format:'sktl',sha256:(await inspectXml({file:standalone})).sha256,cueId:'c',nodeId:'n',stopped:false});
 assert.equal(await readFile(out,'utf8'),expected);
});

test('rejects ambiguous or unsupported states without creating output',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'sk-stop-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 for(const [i,bad] of [node.replace('>true</setting>','>yes</setting>'),node.replace('</settings>','<setting key="node.stopped">false</setting></settings>'),'<node id="n"/>'].entries()){
  const source=path.join(dir,`${i}.sktl`),destination=path.join(dir,`${i}-out.sktl`);await writeFile(source,timeline(bad));
  await assert.rejects(setCueGraphNodeStoppedCopy({source,destination,format:'sktl',sha256:(await inspectXml({file:source})).sha256,cueId:'c',nodeId:'n',stopped:true}));
  await assert.rejects(readFile(destination));
 }
});
