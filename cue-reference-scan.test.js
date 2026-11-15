import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {scanCueReferences} from './cue-reference-scan.js';

const part=(name,data,md5=createHash('md5').update(data).digest('hex'))=>`<part name="${name}" md5="${md5}">${Buffer.from(data).toString('base64')}</part>`;
async function fixture(t,parts){const dir=await mkdtemp(path.join(os.tmpdir(),'cue-scan-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'show.skshow');await writeFile(file,`<skshow>${parts.join('')}</skshow>`);return file;}

test('scans parsed values in all XML parts while excluding only the target subtree',async t=>{
 const timeline='<sktimeline><cue id="cue.1"><graph><node id="n7"><setting>cue.1 n7</setting></node></graph></cue><cue id="other"><setting><![CDATA[cue.1]]></setting><setting>n&#55;</setting><setting>cueX1 n70</setting></cue></sktimeline>';
 const file=await fixture(t,[part('content/a.sktl',timeline),part('extra.skcp','<x value="cue&#46;1"><y><![CDATA[n7]]></y></x>'),part('data.bin',Buffer.from([0xff,0x00]))]);
 const result=await scanCueReferences({file,name:'content/a.sktl',cueId:'cue.1'});
 assert.deepEqual(result.nodeIds,['n7']);
 assert.deepEqual(result.references,[{part:'content/a.sktl',type:'cue',id:'cue.1'},{part:'content/a.sktl',type:'node',id:'n7'},{part:'extra.skcp',type:'cue',id:'cue.1'},{part:'extra.skcp',type:'node',id:'n7'}]);
 assert.equal(result.complete,false);assert.equal(result.diagnostics[0].part,'data.bin');
});
test('does not count target definition or identifier substrings',async t=>{
 const file=await fixture(t,[part('a.sktl','<sktimeline><cue id="c.1"><graph><node id="n7"/></graph></cue><x>cX1 n70 ac.1</x></sktimeline>')]);
 const result=await scanCueReferences({file,name:'a.sktl',cueId:'c.1'});assert.deepEqual(result.references,[]);
});
test('rejects duplicate cue definitions, bad checksums and stale snapshots',async t=>{
 const duplicate=await fixture(t,[part('a.sktl','<sktimeline><cue id="a"/></sktimeline>'),part('b.sktl','<sktimeline><cue id="a"/></sktimeline>')]);
 await assert.rejects(scanCueReferences({file:duplicate,name:'a.sktl',cueId:'a'}),/Duplicate/);
 const bad=await fixture(t,[part('a.sktl','<sktimeline><cue id="a"/></sktimeline>','0'.repeat(32))]);
 await assert.rejects(scanCueReferences({file:bad,name:'a.sktl',cueId:'a'}),/MD5/);
 await assert.rejects(scanCueReferences({file:duplicate,name:'a.sktl',cueId:'a',sha256:'bad'}),/changed/);
});
test('reports invalid non-target XML and rejects an invalid target',async t=>{
 const file=await fixture(t,[part('a.sktl','<sktimeline><cue id="a"/></sktimeline>'),part('bad.skcp','<broken>')]);
 const result=await scanCueReferences({file,name:'a.sktl',cueId:'a'});assert.equal(result.complete,false);assert.match(result.diagnostics[0].reason,/XML/);
 const invalid=await fixture(t,[part('a.sktl','<sktimeline><cue id="a">')]);
 await assert.rejects(scanCueReferences({file:invalid,name:'a.sktl',cueId:'a'}),/target timeline/i);
});
test('caps records and reports their totals',async t=>{
 const entries=[part('a.sktl','<sktimeline><cue id="a"/></sktimeline>')];
 for(let i=0;i<501;i++)entries.push(part(`ref${i}.skcp`,'<x>a</x>'));
 for(let i=0;i<501;i++)entries.push(part(`bad${i}`,Buffer.from([0xff])));
 const file=await fixture(t,entries);const result=await scanCueReferences({file,name:'a.sktl',cueId:'a'});
 assert.equal(result.references.length,500);assert.equal(result.referencesTotal,501);assert.equal(result.referencesTruncated,true);
 assert.equal(result.diagnostics.length,500);assert.equal(result.diagnosticsTotal,501);assert.equal(result.diagnosticsTruncated,true);
});
test('rejects more than 1000 selected node IDs',async t=>{
 const nodes=Array.from({length:1001},(_,i)=>`<node id="n${i}"/>`).join('');
 const file=await fixture(t,[part('a.sktl',`<sktimeline><cue id="a"><graph>${nodes}</graph></cue></sktimeline>`)]);
 await assert.rejects(scanCueReferences({file,name:'a.sktl',cueId:'a'}),/node ID scan limit/);
});
test('finds multiple IDs and overlapping prefixes in parsed mixed content',async t=>{
 const file=await fixture(t,[part('a.sktl','<sktimeline><cue id="c"><graph><node id="n1"/><node id="n1-x"/><node id="n2"/></graph></cue><setting>n<![CDATA[1]]>-x and n&#50; and c</setting><other><a>n</a><b>1</b></other></sktimeline>')]);
 const result=await scanCueReferences({file,name:'a.sktl',cueId:'c'});
 assert.deepEqual(result.references.map(r=>r.id),['c','n1','n1-x','n2']);
});
test('does not join separate sibling text outside settings',async t=>{
 const file=await fixture(t,[part('a.sktl','<sktimeline><cue id="abc"/><other><a>ab</a><b>c</b></other></sktimeline>')]);
 const result=await scanCueReferences({file,name:'a.sktl',cueId:'abc'});assert.deepEqual(result.references,[]);
});
