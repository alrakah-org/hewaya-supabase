/* Ranking exports run entirely on the supervisor's device, using the displayed snapshot.
 * XLSX contains editable native column charts; PDF preserves Arabic shaping via canvas.
 * No additional API calls, CDN libraries, student identifiers or credentials are exported.
 */
(function (root) {
  'use strict';
  const PER_PAGE = 10;
  const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const enc = new TextEncoder();
  const xml = value => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[c]));
  const num = value => { const n = Number(value ?? 0); if (!Number.isFinite(n)) throw new Error('توجد قيمة نقاط غير صالحة في الترتيب'); return n; };
  const sortRows = rows => rows.map(row => ({ name: String(row.name || 'بدون اسم'), value: num(row.value) })).sort((a,b) => b.value-a.value || a.name.localeCompare(b.name, 'ar'));
  const numberLabel = value => new Intl.NumberFormat('ar-SA', { maximumFractionDigits: 2 }).format(value);
  const colors = ['2F6FBF','7C5BA6','F178A8','352868'];

  function createReport(columns, selection) {
    const groups = columns.map(g => ({name: String(g.name || 'مجموعة'), value: num(g.totalPoints), members: sortRows((g.members || []).map(s => ({name:s.name, value:s.balance})))})).sort((a,b) => b.value-a.value || a.name.localeCompare(b.name, 'ar'));
    const sections = selection.mode === 'individuals'
      ? [{title:'ترتيب الطلاب', kind:'students', rows:sortRows(groups.flatMap(g => g.members))}]
      : [{title:'ترتيب المجموعات', kind:'groups', rows:sortRows(groups)}, ...groups.filter(g=>g.members.length).map(g=>({title:'طلاب مجموعة '+g.name, kind:'students', rows:g.members}))];
    return {stage:String(selection.stage), week:String(selection.weekLabel), mode:selection.mode,
      createdAt:new Date().toISOString(), sections:sections.filter(s=>s.rows.length)};
  }
  function bounds(rows) {
    let low = Math.min(0,...rows.map(r=>r.value)), high = Math.max(0,...rows.map(r=>r.value));
    if (low === high) return {low:0,high:5,step:1};
    const rough = (high-low)/5, power = 10 ** Math.floor(Math.log10(rough));
    const step = [1,2,5,10].find(n=>n*power>=rough)*power;
    low = Math.floor(low/step)*step; high = Math.ceil(high/step)*step;
    if (low < 0) low -= step; // Leave room below negative-value labels.
    return {low,high,step};
  }
  function pages(report) {
    return report.sections.flatMap(section => {
      const scale = bounds(section.rows), result = [];
      for (let offset=0; offset<section.rows.length; offset+=PER_PAGE) result.push({section, rows:section.rows.slice(offset,offset+PER_PAGE), offset, scale});
      return result;
    });
  }
  function filename(report, extension) {
    const name = `هواية-${report.mode==='groups'?'ترتيب-المجموعات':'ترتيب-الطلاب'}-${report.stage}-${report.week}-${report.createdAt.slice(0,10)}`;
    return name.replace(/[\\/:*?"<>|\u0000-\u001F]/g,'-')+'.'+extension;
  }

  // Stored ZIP entries keep the exporter small and work without compression libraries.
  const crcTable = new Uint32Array(256);
  for (let n=0;n<256;n++) { let c=n; for(let k=0;k<8;k++) c=(c&1)?0xedb88320^(c>>>1):c>>>1; crcTable[n]=c>>>0; }
  function crc32(bytes) { let crc=0xffffffff; for(const byte of bytes) crc=crcTable[(crc^byte)&255]^(crc>>>8); return (crc^0xffffffff)>>>0; }
  function zip(files) {
    const parts=[], directory=[]; let offset=0, directorySize=0;
    for (const [path,content] of Object.entries(files)) {
      const name=enc.encode(path), data=enc.encode(content), crc=crc32(data);
      const local=new Uint8Array(30+name.length), lv=new DataView(local.buffer);
      lv.setUint32(0,0x04034b50,true); lv.setUint16(4,20,true); lv.setUint16(6,0x800,true); lv.setUint16(12,33,true);
      lv.setUint32(14,crc,true); lv.setUint32(18,data.length,true); lv.setUint32(22,data.length,true); lv.setUint16(26,name.length,true); local.set(name,30);
      const central=new Uint8Array(46+name.length), cv=new DataView(central.buffer);
      cv.setUint32(0,0x02014b50,true); cv.setUint16(4,20,true); cv.setUint16(6,20,true); cv.setUint16(8,0x800,true); cv.setUint16(14,33,true);
      cv.setUint32(16,crc,true); cv.setUint32(20,data.length,true); cv.setUint32(24,data.length,true); cv.setUint16(28,name.length,true); cv.setUint32(42,offset,true); central.set(name,46);
      parts.push(local,data); directory.push(central); offset+=local.length+data.length; directorySize+=central.length;
    }
    const end=new Uint8Array(22), ev=new DataView(end.buffer), count=directory.length;
    ev.setUint32(0,0x06054b50,true); ev.setUint16(8,count,true); ev.setUint16(10,count,true); ev.setUint32(12,directorySize,true); ev.setUint32(16,offset,true);
    return new Blob([...parts,...directory,end],{type:MIME_XLSX});
  }
  const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const relationship = (id,type,target) => `<Relationship Id="${id}" Type="${rel}/${type}" Target="${xml(target)}"/>`;
  const relationships = entries => declaration+`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
  const textCell = (cell,value,style=0) => `<c r="${cell}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  const numberCell = (cell,value,style=0) => `<c r="${cell}" s="${style}"><v>${value}</v></c>`;
  const chartText = text => `<a:p><a:pPr rtl="1"/><a:r><a:rPr lang="ar-SA"/><a:t>${xml(text)}</a:t></a:r></a:p>`;
  function chartXml(section, sheetName, offset) {
    const rows=section.rows.slice(offset,offset+PER_PAGE), start=offset+6, end=start+rows.length-1;
    const ref=xml("'"+sheetName.replace(/'/g,"''")+"'!"), scale=bounds(section.rows);
    const title=section.title+(section.rows.length>PER_PAGE?` (${offset+1} - ${offset+rows.length})`:'');
    const cat=rows.map((r,i)=>`<c:pt idx="${i}"><c:v>${xml(r.name)}</c:v></c:pt>`).join('');
    const values=rows.map((r,i)=>`<c:pt idx="${i}"><c:v>${r.value}</c:v></c:pt>`).join('');
    const points=rows.map((r,i)=>`<c:dPt><c:idx val="${i}"/><c:spPr><a:solidFill><a:srgbClr val="${colors[(offset+i)%colors.length]}"/></a:solidFill></c:spPr></c:dPt>`).join('');
    return declaration+`<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${rel}">
      <c:lang val="ar-SA"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/>${chartText(title)}</c:rich></c:tx><c:overlay val="0"/></c:title>
      <c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>النقاط</c:v></c:tx>
      <c:spPr><a:solidFill><a:srgbClr val="2F6FBF"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>${points}
      <c:cat><c:strRef><c:f>${ref}$B$${start}:$B$${end}</c:f><c:strCache><c:ptCount val="${rows.length}"/>${cat}</c:strCache></c:strRef></c:cat>
      <c:val><c:numRef><c:f>${ref}$C$${start}:$C$${end}</c:f><c:numCache><c:formatCode>0.##</c:formatCode><c:ptCount val="${rows.length}"/>${values}</c:numCache></c:numRef></c:val></c:ser>
      <c:dLbls><c:dLblPos val="outEnd"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/></c:dLbls><c:gapWidth val="70"/><c:axId val="1"/><c:axId val="2"/></c:barChart>
      <c:catAx><c:axId val="1"/><c:scaling><c:orientation val="maxMin"/></c:scaling><c:axPos val="b"/><c:tickLblPos val="low"/><c:crossAx val="2"/><c:crosses val="autoZero"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:tickLblSkip val="1"/></c:catAx>
      <c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/><c:max val="${scale.high+scale.step}"/><c:min val="${scale.low}"/></c:scaling><c:axPos val="r"/><c:majorGridlines/><c:numFmt formatCode="0.##" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="1"/><c:crosses val="autoZero"/><c:crossBetween val="between"/><c:majorUnit val="${scale.step}"/></c:valAx></c:plotArea><c:plotVisOnly val="1"/></c:chart>
      <c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></c:spPr><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr rtl="1"><a:defRPr sz="1100"><a:solidFill><a:srgbClr val="352868"/></a:solidFill><a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:defRPr></a:pPr><a:endParaRPr lang="ar-SA"/></a:p></c:txPr></c:chartSpace>`;
  }
  function xlsx(report) {
    if (!report.sections.length) throw new Error('لا توجد نتائج لتحميلها');
    const files={}, sheets=[], workbookRels=[], types=[]; let chartId=0;
    const names=new Set();
    report.sections.forEach((section,index)=>{
      const id=index+1, base=section.title.replace(/[\\/?*\[\]:]/g,' ').replace(/^'+|'+$/g,'').slice(0,27)||'الترتيب';
      let name=base, suffix=1; while(names.has(name)) name=base+' '+(++suffix); names.add(name);
      sheets.push(`<sheet name="${xml(name)}" sheetId="${id}" r:id="rId${id}"/>`);
      workbookRels.push(relationship('rId'+id,'worksheet',`worksheets/sheet${id}.xml`));
      types.push(`<Override PartName="/xl/worksheets/sheet${id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
      const data=[`<row r="1" ht="32" customHeight="1">${textCell('A1','هواية - '+section.title,1)}</row>`,
        `<row r="2" ht="28" customHeight="1">${textCell('A2',report.stage+' - '+report.week,3)}</row>`,
        `<row r="3" ht="25" customHeight="1">${textCell('A3','تاريخ التصدير: '+new Date(report.createdAt).toLocaleDateString('ar-SA',{timeZone:'Asia/Riyadh',calendar:'gregory'}),3)}</row>`,
        `<row r="5" ht="28" customHeight="1">${textCell('A5','الترتيب',2)}${textCell('B5',section.kind==='groups'?'المجموعة':'الطالب',2)}${textCell('C5','النقاط',2)}</row>`];
      section.rows.forEach((r,i)=>data.push(`<row r="${i+6}" ht="30" customHeight="1">${numberCell('A'+(i+6),i+1)}${textCell('B'+(i+6),r.name)}${numberCell('C'+(i+6),r.value)}</row>`));
      files[`xl/worksheets/sheet${id}.xml`]=declaration+`<worksheet xmlns="${ns}" xmlns:r="${rel}"><sheetViews><sheetView workbookViewId="0" rightToLeft="1" showGridLines="0"><pane ySplit="5" topLeftCell="A6" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="24"/><cols><col min="1" max="1" width="12" customWidth="1"/><col min="2" max="2" width="46" customWidth="1"/><col min="3" max="3" width="16" customWidth="1"/><col min="4" max="22" width="10" customWidth="1"/></cols><sheetData>${data.join('')}</sheetData><autoFilter ref="A5:C${section.rows.length+5}"/><mergeCells count="3"><mergeCell ref="A1:C1"/><mergeCell ref="A2:C2"/><mergeCell ref="A3:C3"/></mergeCells><pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape"/><drawing r:id="rId1"/></worksheet>`;
      files[`xl/worksheets/_rels/sheet${id}.xml.rels`]=relationships(relationship('rId1','drawing',`../drawings/drawing${id}.xml`));
      const anchors=[], drawingRels=[];
      for(let offset=0,block=0;offset<section.rows.length;offset+=PER_PAGE,block++){
        chartId++; const row=4+block*24;
        files[`xl/charts/chart${chartId}.xml`]=chartXml(section,name,offset);
        drawingRels.push(relationship('rId'+(block+1),'chart',`../charts/chart${chartId}.xml`));
        types.push(`<Override PartName="/xl/charts/chart${chartId}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
        anchors.push(`<xdr:twoCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>21</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row+22}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${block+1}" name="Chart ${chartId}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${rel}" r:id="rId${block+1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`);
      }
      files[`xl/drawings/drawing${id}.xml`]=declaration+`<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors.join('')}</xdr:wsDr>`;
      files[`xl/drawings/_rels/drawing${id}.xml.rels`]=relationships(drawingRels.join(''));
      types.push(`<Override PartName="/xl/drawings/drawing${id}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
    });
    files['xl/workbook.xml']=declaration+`<workbook xmlns="${ns}" xmlns:r="${rel}"><bookViews><workbookView/></bookViews><sheets>${sheets.join('')}</sheets></workbook>`;
    files['xl/_rels/workbook.xml.rels']=relationships(workbookRels.join('')+relationship('rIdStyles','styles','styles.xml'));
    files['_rels/.rels']=relationships(relationship('rId1','officeDocument','xl/workbook.xml'));
    files['xl/styles.xml']=declaration+`<styleSheet xmlns="${ns}"><fonts count="3"><font><sz val="12"/><color rgb="FF2B2640"/><name val="Arial"/></font><font><b/><sz val="18"/><color rgb="FF352868"/><name val="Arial"/></font><font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF352868"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1" readingOrder="2"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center" readingOrder="2"/></xf><xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" readingOrder="2"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center" readingOrder="2"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
    files['[Content_Types].xml']=declaration+`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${types.join('')}</Types>`;
    return zip(files);
  }

  function wrapText(ctx,text,width) {
    const lines=[]; let line='';
    for(const word of String(text).split(/\s+/)){
      if(line && ctx.measureText(line+' '+word).width>width){ lines.push(line); line=''; }
      if(ctx.measureText(word).width>width){
        for(const char of Array.from(word)){ if(line && ctx.measureText(line+char).width>width){lines.push(line);line='';} line+=char; }
      } else line+=(line?' ':'')+word;
    }
    if(line)lines.push(line); return lines;
  }
  function renderPage(report,page,index,total,logo) {
    const canvas=document.createElement('canvas'); canvas.width=1680; canvas.height=1188;
    const ctx=canvas.getContext('2d'); if(!ctx)throw new Error('تعذر إنشاء الرسم البياني على هذا المتصفح');
    const font=(size,bold=false)=>{ctx.font=`${bold?'700':'400'} ${size}px Almarai, Arial, sans-serif`;};
    ctx.fillStyle='#FFFFFF';ctx.fillRect(0,0,1680,1188);ctx.fillStyle='#352868';ctx.fillRect(0,0,1680,14);
    ctx.direction='rtl';ctx.textAlign='right';ctx.textBaseline='middle';ctx.fillStyle='#352868';font(38,true);
    const titleLines=wrapText(ctx,page.section.title,1200); titleLines.forEach((s,i)=>ctx.fillText(s,1590,77+i*48));
    const headerBottom=108+titleLines.length*48;
    font(23);ctx.fillStyle='#79738F';ctx.fillText(report.stage+'   |   '+report.week,1590,headerBottom);
    font(21);ctx.fillText(`المراكز ${numberLabel(page.offset+1)} - ${numberLabel(page.offset+page.rows.length)} من ${numberLabel(page.section.rows.length)}`,1590,headerBottom+39);
    if(logo){const ratio=Math.min(160/logo.width,100/logo.height);ctx.drawImage(logo,80,55,logo.width*ratio,logo.height*ratio);}
    else {font(36,true);ctx.fillStyle='#7C5BA6';ctx.textAlign='left';ctx.fillText('هواية',80,90);}
    const left=105,right=1540,slot=(right-left)/page.rows.length;
    font(21);const labels=page.rows.map(r=>wrapText(ctx,r.name,Math.min(slot-12,230)));
    const labelHeight=Math.max(...labels.map(l=>l.length))*29+60;
    const top=Math.max(270,headerBottom+115),bottom=1080-labelHeight;
    const scale=page.scale, span=scale.high-scale.low, y=v=>bottom-(v-scale.low)/span*(bottom-top), baseline=y(0);
    ctx.textAlign='left';ctx.direction='ltr';font(19);
    for(let value=scale.low;value<=scale.high+scale.step/100;value+=scale.step){
      const pos=y(value);ctx.strokeStyle=Math.abs(value)<scale.step/100?'#B6AEC8':'#EEEAF4';ctx.lineWidth=2;
      ctx.beginPath();ctx.moveTo(left,pos);ctx.lineTo(right,pos);ctx.stroke();ctx.fillStyle='#79738F';ctx.fillText(numberLabel(value),right+18,pos);
    }
    ctx.direction='rtl';ctx.textAlign='right';font(20,true);ctx.fillStyle='#79738F';ctx.fillText('النقاط',1615,top-47);
    page.rows.forEach((r,i)=>{
      const x=right-slot*(i+0.5),barWidth=Math.min(105,slot*0.64),valueY=y(r.value);
      ctx.fillStyle='#'+colors[(page.offset+i)%colors.length];ctx.fillRect(x-barWidth/2,Math.min(valueY,baseline),barWidth,Math.max(2,Math.abs(baseline-valueY)));
      ctx.textAlign='center';font(23,true);ctx.fillStyle='#352868';ctx.fillText(numberLabel(r.value),x,r.value>=0?valueY-21:valueY+21);
      font(18,true);ctx.fillStyle='#7C5BA6';ctx.fillText(numberLabel(page.offset+i+1),x,bottom+38);
      font(21);ctx.fillStyle='#2B2640';labels[i].forEach((line,j)=>ctx.fillText(line,x,bottom+76+j*29));
    });
    ctx.strokeStyle='#E8E3F0';ctx.beginPath();ctx.moveTo(80,1110);ctx.lineTo(1600,1110);ctx.stroke();
    font(19);ctx.textAlign='right';ctx.fillStyle='#79738F';ctx.fillText('هواية - '+new Date(report.createdAt).toLocaleDateString('ar-SA',{timeZone:'Asia/Riyadh',calendar:'gregory'}),1590,1147);
    ctx.textAlign='left';ctx.fillText(`الصفحة ${numberLabel(index+1)} من ${numberLabel(total)}`,90,1147);
    return canvas;
  }
  // A compact PDF writer: one high-resolution JPEG per A4 landscape page.
  function jpegPdf(images) {
    const parts=[],offsets=[0];let size=0;
    const append=value=>{const bytes=typeof value==='string'?enc.encode(value):value;parts.push(bytes);size+=bytes.length;};
    const object=(id,body,stream)=>{offsets[id]=size;append(`${id} 0 obj\n${body}`);if(stream){append('\nstream\n');append(stream);append('\nendstream');}append('\nendobj\n');};
    append('%PDF-1.4\n');
    object(1,'<< /Type /Catalog /Pages 2 0 R >>');
    object(2,`<< /Type /Pages /Count ${images.length} /Kids [${images.map((_,i)=>`${3+i*3} 0 R`).join(' ')}] >>`);
    images.forEach((bytes,i)=>{
      const id=3+i*3,content=enc.encode('q\n841.89 0 0 595.28 0 0 cm\n/Im0 Do\nQ');
      object(id,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 841.89 595.28] /Resources << /XObject << /Im0 ${id+1} 0 R >> >> /Contents ${id+2} 0 R >>`);
      object(id+1,`<< /Type /XObject /Subtype /Image /Width 1680 /Height 1188 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>`,bytes);
      object(id+2,`<< /Length ${content.length} >>`,content);
    });
    const xref=size;append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
    offsets.slice(1).forEach(n=>append(String(n).padStart(10,'0')+' 00000 n \n'));
    append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(parts,{type:'application/pdf'});
  }
  async function pdf(report,{onProgress=()=>{},isCancelled=()=>false}={}) {
    const entries=pages(report);if(!entries.length)throw new Error('لا توجد نتائج لتحميلها');
    if(document.fonts)await Promise.race([Promise.all([document.fonts.load('400 21px Almarai'),document.fonts.load('700 38px Almarai')]).catch(()=>{}),new Promise(r=>setTimeout(r,3000))]);
    const logo=await new Promise(resolve=>{const img=new Image(),timer=setTimeout(()=>resolve(null),2000);img.onload=()=>{clearTimeout(timer);resolve(img);};img.onerror=()=>{clearTimeout(timer);resolve(null);};img.src='logo.png';});
    const images=[];
    for(let i=0;i<entries.length;i++){
      if(isCancelled())throw new Error('تم إلغاء التحميل لأن الترتيب تغير');
      onProgress(i+1,entries.length);
      const canvas=renderPage(report,entries[i],i,entries.length,logo);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.94));
      if(!blob||blob.type!=='image/jpeg')throw new Error('تعذر إنشاء ملف PDF على هذا المتصفح');
      images.push(new Uint8Array(await blob.arrayBuffer()));canvas.width=canvas.height=1;
      await new Promise(r=>setTimeout(r,0));
    }
    return jpegPdf(images);
  }
  function download(blob,name) {
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=name;a.textContent='تنزيل الملف';a.style.display='none';document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  }
  const api={createReport,pages,filename,xlsx,pdf,renderPage};
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.HawayaRankingExport={...api,download};
})(typeof window==='object'?window:globalThis);
