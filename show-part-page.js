import {readShowSnapshot, readSnapshotPart} from './xml-copy.js';

// Offsets count UTF-16 code units, as used by JavaScript string indices.
export async function readShowPartPage({file, name, offset=0, limit=16384, sha256}) {
 if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 2 || limit > 32768) throw Error('Invalid page offset or limit');
 const snapshot=await readShowSnapshot({file});
 if (sha256 && snapshot.sha256!==sha256) throw Error('Source changed since inspection');
 const {text,md5}=readSnapshotPart({snapshot,name});
 if(offset>text.length)throw Error('Offset exceeds part length');
 const low=c=>c>=0xdc00&&c<=0xdfff, high=c=>c>=0xd800&&c<=0xdbff;
 if(offset>0&&offset<text.length&&high(text.charCodeAt(offset-1))&&low(text.charCodeAt(offset)))throw Error('Offset splits a Unicode character');
 let end=Math.min(text.length,offset+limit);
 if(end<text.length&&end>offset&&high(text.charCodeAt(end-1))&&low(text.charCodeAt(end)))end--;
 return {name,md5,sha256:snapshot.sha256,offset,nextOffset:end<text.length?end:null,totalLength:text.length,text:text.slice(offset,end)};
}
