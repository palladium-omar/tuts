import assert from 'node:assert/strict';
import test from 'node:test';
import {deflateSync} from 'node:zlib';
import {validateUpload} from '../src/uploads.js';
const upload=(name:string,bytes:Buffer)=>validateUpload({originalname:name,mimetype:'application/octet-stream',size:bytes.length,buffer:bytes});
function zip(entries:Record<string,string|Buffer>){
 const locals:Buffer[]=[],directory:Buffer[]=[];let offset=0;
 for(const [path,value] of Object.entries(entries)){
  const name=Buffer.from(path),data=Buffer.isBuffer(value)?value:Buffer.from(value),local=Buffer.alloc(30),central=Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
  locals.push(local,name,data);directory.push(central,name);offset+=local.length+name.length+data.length;
 }
 const dir=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(Object.keys(entries).length,8);end.writeUInt16LE(Object.keys(entries).length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,dir,end]);
}
const ordinary={'[Content_Types].xml':'<Types/>','_rels/.rels':'<Relationships/>','word/document.xml':'<document><p>Ordinary homework</p></document>'};
test('ordinary passive PDF, DOCX, PPTX and images remain accepted',()=>{
 assert.equal(upload('lesson.pdf',Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF')).mimeType,'application/pdf');
 assert.equal(upload('lesson.docx',zip(ordinary)).mimeType,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
 upload('slides.pptx',zip({'[Content_Types].xml':'<Types/>','_rels/.rels':'<Relationships/>','ppt/presentation.xml':'<presentation/>'}));
 const png=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);upload('image.png',png);
});
test('PDF active names, escaped names and compressed object actions are rejected',()=>{
 for(const name of ['JavaScript','JS','Launch','EmbeddedFile','EmbeddedFiles','RichMedia','XFA','Encrypt','Java#53cript','#4aS'])assert.throws(()=>upload('lesson.pdf',Buffer.from(`%PDF-1.7\n<< /${name} (payload) >>\n%%EOF`)));
 const content=deflateSync(Buffer.from('<< /S /JavaScript /JS (payload) >>'));
 assert.throws(()=>upload('lesson.pdf',Buffer.concat([Buffer.from(`%PDF-1.7\n<< /Type /ObjStm /Filter /FlateDecode /DecodeParms << /Predictor 1 >> /Length ${content.length} >>\nstream\n`),content,Buffer.from('\nendstream\n%%EOF')])));
 const passive=deflateSync(Buffer.from('<< /Type /Catalog >>'));
 upload('lesson.pdf',Buffer.concat([Buffer.from(`%PDF-1.7\n<< /Type /ObjStm /Filter /FlateDecode /Length ${passive.length} >>\nstream\n`),passive,Buffer.from('\nendstream\n%%EOF')]));
});
test('Office macros, embedded objects and external embeds reject while plain hyperlinks remain supported',()=>{
 for(const extra of [ {'word/vbaProject.bin':'macro'},{'word/embeddings/object.bin':'object'},{'[Content_Types].xml':'<Types ContentType="macroEnabled"/>'},{'word/document.xml':'<document><oleObject/></document>'},{'word/_rels/document.xml.rels':'<Relationships><Relationship Type="office/image" TargetMode="External" Target="https://example.test/image"/></Relationships>'},{'word/_rels/document.xml.rels':'<Relationships><Relationship Type="office/image" TargetMode="&#69;xternal"/></Relationships>'}])assert.throws(()=>upload('lesson.docx',zip({...ordinary,...extra})));
 upload('lesson.docx',zip({...ordinary,'word/_rels/document.xml.rels':'<Relationships><Relationship Type="office/hyperlink" TargetMode="External" Target="https://example.test"/></Relationships>'}));
});
