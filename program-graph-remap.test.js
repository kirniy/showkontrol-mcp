import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {remapProgramItemGraphCopy} from './program-graph-remap.js';
const digest=(alg,s)=>createHash(alg).update(s).digest('hex');
const program=(extra='')=>`<skprogram version="1"><item start="0" name="A" notes=""><graph><node id="n1" type="trigger"><settings><setting key="x">${extra}</setting></settings></node><node id="n2" type="action"/><connection fromNode="n1" fromPin="0" toNode="n2" toPin="0"/></graph></item></skprogram>`;
async function setup(xml=program(),bad=false){const dir=await mkdtemp(path.join(tmpdir(),'remap-'));const source=path.join(dir,'input.skpr'),target=path.join(dir,'target.skshow'),destination=path.join(dir,'output.skpr');const content=Buffer.from(xml),show=`<skshow><part name="content/Program.skpr" md5="${bad?'0'.repeat(32):digest('md5',content)}">${content.toString('base64')}</part></skshow>`;await writeFile(source,content);await writeFile(target,show);return {source,target,destination,sha256:digest('sha256',content),targetSha256:digest('sha256',show),index:0};}
test('remaps all graph IDs and wires against same-show collisions',async()=>{const a=await setup();const result=await remapProgramItemGraphCopy(a);assert.deepEqual(result.mapping,{n1:'n3',n2:'n4'});const out=await readFile(a.destination,'utf8');assert.equal(out,program().replace('id="n1"','id="n3"').replace('id="n2"','id="n4"').replace('fromNode="n1"','fromNode="n3"').replace('toNode="n2"','toNode="n4"'));await assert.rejects(remapProgramItemGraphCopy(a),/exist/i);});
test('rejects unsupported references without output',async()=>{const a=await setup(program('n1'));await assert.rejects(remapProgramItemGraphCopy(a),/unsupported internal references/);await assert.rejects(access(a.destination));});
test('rejects invalid checksums and stale hashes without output',async()=>{for(const kind of ['checksum','hash']){const a=await setup(program(),kind==='checksum');if(kind==='hash')a.targetSha256='0'.repeat(64);await assert.rejects(remapProgramItemGraphCopy(a));await assert.rejects(access(a.destination));}});
