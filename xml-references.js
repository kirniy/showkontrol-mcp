import {SaxesParser} from 'saxes';
// Join mixed content within a setting; keep separate sibling fields distinct.
export function hasXmlReference(xml,pattern,{ignoreRootId=false,ignoreRootAttributes=[]}={}){
 const parser=new SaxesParser(),stack=[];let found=false;
 parser.on('opentag',tag=>{
  for(const [key,value] of Object.entries(tag.attributes))if(!(stack.length===0&&((ignoreRootId&&key==='id')||ignoreRootAttributes.includes(key)))&&pattern.test(value))found=true;
  stack.push({text:'',inSetting:tag.name==='setting'||(stack.at(-1)?.inSetting??false),children:0});
 });
 parser.on('text',text=>{if(stack.length)stack.at(-1).text+=text;});parser.on('cdata',text=>{if(stack.length)stack.at(-1).text+=text;});
 parser.on('closetag',()=>{const node=stack.pop();if(pattern.test(node.text))found=true;if(stack.length){const parent=stack.at(-1);if(parent.children&&!parent.inSetting)parent.text+='\0';parent.text+=node.text;parent.children++;}});
 parser.write(xml).close();return found;
}
