/* Home Library — standalone app. */
(function(){
'use strict';
/* ================= constants & state ================= */
const LANGS=['English','Tamil','Other'];
const STATUS=[['want','Want to read'],['reading','Reading'],['finished','Finished'],['abandoned','Abandoned']];
const STATUS_LABEL=Object.fromEntries(STATUS);
const GROUPS=[['alpha','A–Z by title'],['language','By language'],['author','By author'],['genre','By genre'],['priority','Priority first']];
const LKEY='homeLibrary.books.v1',LPKEY='homeLibrary.passages.v1',LMKEY='homeLibrary.meta.v1';
const DAY=86400000;
const S={books:[],passages:[],meta:{},view:'library',back:'library',current:null,
  layout:pref('layout')||'grid',group:pref('group')||'alpha',q:'',
  filters:{lang:'',genre:'',rating:'',location:'',read:''},showFilters:false,
  collapsed:new Set(safeJSON(pref('collapsed'),[])),mode:'connecting',loaded:false,slow:false,error:null,form:null,
  pq:'',pres:null};
if(!GROUPS.some(g=>g[0]===S.group))S.group='alpha';
let col=null,pcol=null,metaRef=null,loadTimer=null;
const CAP={downloads:null};
const IN_APP=false;
const SC={fn:null,images:false,busy:false,filled:new Set(),sug:null,lastPhoto:null};
const app=document.getElementById('app'),layer=document.getElementById('layer');

/* ================= small utils ================= */
function safeJSON(s,d){try{return s?JSON.parse(s):d}catch(e){return d}}
function pref(k){try{return localStorage.getItem('homeLibrary.'+k)}catch(e){return null}}
function setPref(k,v){try{localStorage.setItem('homeLibrary.'+k,v)}catch(e){}}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function norm(s){return String(s||'').toLowerCase().replace(/\s+/g,' ').trim()}
function hasTamil(s){return /[஀-௿]/.test(s||'')}
function ta(s){return hasTamil(s)?' lang="ta"':''}
function todayStr(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function parseDay(d){if(!d)return null;const dt=typeof d==='number'?new Date(d):new Date(d+'T00:00:00');return isNaN(dt)?null:dt}
function fmtDate(d){const dt=parseDay(d);return dt?dt.toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}):''}
function daysSince(d){const dt=parseDay(d);return dt?Math.floor((Date.now()-dt.getTime())/DAY):0}
function hue(s){let h=0;for(const ch of String(s))h=(h*31+ch.codePointAt(0))>>>0;return (h%8)+1}
function plural(n,w,p){return n+' '+(n===1?w:(p||w+'s'))}

/* ================= books helpers ================= */
function owned(){return S.books.filter(b=>!b.wish)}
function wishes(){return S.books.filter(b=>b.wish)}
function statusOf(b){return b.status||(b.finishedOn?'finished':'want')}
function isRead(b){return statusOf(b)==='finished'}
function isOverdue(b){return !!(b.loan&&b.loan.on&&daysSince(b.loan.on)>30)}
function prioList(){return owned().filter(b=>b.priority).sort((a,b)=>(a.priorityOrder??0)-(b.priorityOrder??0)||byTitle(a,b))}
function nextOrder(){const p=prioList();return p.length?(p[p.length-1].priorityOrder??0)+1:1}
function coverSrc(b){return b.coverPath?publicUrl(b.coverPath):(/^(https?:|data:|blob:)/.test(b.coverUrl||'')?b.coverUrl:'')}
function passagesOf(id){return S.passages.filter(p=>p.bookId===id).sort((a,b)=>(parseInt(a.page)||1e9)-(parseInt(b.page)||1e9)||(a.addedAt||0)-(b.addedAt||0))}

/* ================= ordering: English A–Z, then Tamil (அ, ஆ, இ…), then the rest ================= */
const colEn=new Intl.Collator('en',{sensitivity:'base',numeric:true}),colTa=new Intl.Collator('ta',{sensitivity:'base',numeric:true});
function scriptRank(s){const m=String(s||'').match(/[A-Za-zÀ-ɏ஀-௿]/);if(!m)return String(s||'').trim()?2:3;return /[஀-௿]/.test(m[0])?1:0}
function cmpText(a,b){const ra=scriptRank(a),rb=scriptRank(b);if(ra!==rb)return ra-rb;return (ra===1?colTa:colEn).compare(String(a||'').trim(),String(b||'').trim())}
function byTitle(a,b){return cmpText(a.title,b.title)||cmpText(a.author,b.author)}

/* ================= search: Tamil ⇄ English transliteration + typo tolerance ================= */
const TA_V={'அ':'a','ஆ':'aa','இ':'i','ஈ':'ii','உ':'u','ஊ':'uu','எ':'e','ஏ':'ee','ஐ':'ai','ஒ':'o','ஓ':'oo','ஔ':'au','ஃ':'h'};
const TA_C={'க':'k','ங':'ng','ச':'s','ஞ':'nj','ட':'d','ண':'n','த':'th','ந':'n','ப':'p','ம':'m','ய':'y','ர':'r','ல':'l','வ':'v','ழ':'zh','ள':'l','ற':'r','ன':'n','ஜ':'j','ஷ':'sh','ஸ':'s','ஹ':'h'};
const TA_S={'ா':'aa','ி':'i','ீ':'ii','ு':'u','ூ':'uu','ெ':'e','ே':'ee','ை':'ai','ொ':'o','ோ':'oo','ௌ':'au'};
function romanize(s){
  s=String(s||'').normalize('NFC');let out='';const ch=[...s];
  for(let i=0;i<ch.length;i++){
    const c=ch[i];
    if(TA_C[c]){out+=TA_C[c];const n=ch[i+1];if(n==='்')i++;else if(TA_S[n]){out+=TA_S[n];i++}else out+='a'}
    else if(TA_V[c])out+=TA_V[c];
    else if(c==='்'||c==='ௗ'){}
    else out+=c;
  }
  return out;
}
const KEYCACHE=new Map();
function phonWord(w){
  return w.replace(/zh/g,'l').replace(/sh|ch/g,'s').replace(/th/g,'t').replace(/dh/g,'t').replace(/ph/g,'p').replace(/bh/g,'p').replace(/kh/g,'k').replace(/gh/g,'k')
    .replace(/ng/g,'n').replace(/nj/g,'n').replace(/b/g,'p').replace(/d/g,'t').replace(/g/g,'k').replace(/[cq]/g,'k').replace(/w/g,'v').replace(/z/g,'l').replace(/j/g,'s').replace(/x/g,'ks').replace(/f/g,'p')
    .replace(/([aeiou])y([aeiou])/g,'$1$2').replace(/([aeiou])v([aeiou])/g,'$1$2').replace(/ie|ee|ii/g,'i').replace(/oo|uu/g,'u').replace(/aa/g,'a').replace(/(.)\1+/g,'$1').replace(/h/g,'')||w;
}
function phonKey(s){
  s=String(s||'');if(KEYCACHE.has(s))return KEYCACHE.get(s);
  const r=romanize(s.toLowerCase()).normalize('NFKD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,' ').trim().split(' ').filter(Boolean).map(phonWord).join(' ');
  if(KEYCACHE.size>20000)KEYCACHE.clear();KEYCACHE.set(s,r);return r;
}
function lev(a,b,max){
  if(a===b)return 0;const la=a.length,lb=b.length;if(Math.abs(la-lb)>max)return max+1;
  let prev=new Array(lb+1);for(let j=0;j<=lb;j++)prev[j]=j;
  for(let i=1;i<=la;i++){const cur=[i];let best=i;for(let j=1;j<=lb;j++){cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));if(cur[j]<best)best=cur[j]}if(best>max)return max+1;prev=cur}
  return prev[lb];
}
function tol(n){return n<=3?0:n<=6?1:2}
const IDX=new WeakMap();
function indexOf(b){
  let x=IDX.get(b);if(x)return x;
  const fields={title:b.title,author:b.author,genre:b.genre,location:b.location,series:b.series,comments:b.comments};
  const raw=Object.values(fields).map(v=>String(v||'').toLowerCase()).join(' \u0001 ');
  const toks=[];for(const [f,v] of Object.entries(fields)){for(const t of phonKey(v).split(' '))if(t)toks.push([t,f])}
  x={raw,toks};IDX.set(b,x);return x;
}
const FW={title:3,author:2.5,series:2,genre:1.5,location:1.5,comments:1};
function scoreBook(b,q){
  const qraw=q.toLowerCase().trim();if(!qraw)return 1;
  const ix=indexOf(b);let score=0;
  if(ix.raw.includes(qraw))score+=10;
  const qt=phonKey(q).split(' ').filter(Boolean);
  if(!qt.length)return score;
  const qjoin=qt.join('');
  for(const t of qt){
    let best=0;
    for(const [tok,f] of ix.toks){
      let s=0;
      if(tok===t)s=3;else if(t.length>=2&&tok.startsWith(t))s=2.2;
      else if(t.length>=4){const k=tol(t.length);if(lev(t,tok,k)<=k)s=1.6;else if(tok.length>t.length&&lev(t,tok.slice(0,t.length),k)<=k)s=1.2}
      if(s){s*=FW[f];if(s>best)best=s}
    }
    if(!best){
      // words written together/apart: "ponniyinselvan" vs "ponniyin selvan"
      if(qt.length===1&&t.length>=6){const joined=ix.toks.filter(x=>x[1]==='title').map(x=>x[0]).join('');if(joined.includes(t)||lev(t,joined.slice(0,t.length),tol(t.length))<=tol(t.length)){score+=4;continue}}
      return score>=10?score:0;
    }
    score+=best;
  }
  if(qt.length>1){const tt=ix.toks.filter(x=>x[1]==='title').map(x=>x[0]).join('');if(tt.includes(qjoin))score+=3}
  return score;
}
/* similarity for duplicate detection */
function keyJoin(s){return phonKey(s).replace(/ /g,'')}
function sim(a,b){if(!a||!b)return 0;if(a===b)return 1;const m=Math.max(a.length,b.length),k=Math.ceil(m*0.25);const d=lev(a,b,k);return d>k?0:1-d/m}
function similarTitle(a,b){const x=keyJoin(a),y=keyJoin(b);if(!x||!y)return false;if(x===y)return true;if(Math.min(x.length,y.length)>=6&&(x.includes(y)||y.includes(x)))return true;return sim(x,y)>=0.8}
function similarAuthor(a,b){
  const x=phonKey(a),y=phonKey(b);if(!x||!y)return true;
  if(sim(x.replace(/ /g,''),y.replace(/ /g,''))>=0.7)return true;
  const xs=x.split(' ').filter(w=>w.length>2),ys=new Set(y.split(' ').filter(w=>w.length>2));
  return xs.some(w=>ys.has(w));
}
function findDupes({title,author,isbn},excludeId){
  const i13=toIsbn13(isbn);const out=[];
  for(const b of S.books){
    if(b.id===excludeId)continue;
    const isbnHit=i13&&toIsbn13(b.isbn)===i13;
    const titleHit=title&&title.trim().length>=2&&similarTitle(title,b.title)&&similarAuthor(author,b.author);
    if(isbnHit||titleHit)out.push({b,why:isbnHit?'isbn':'title'});
  }
  return out.sort((x,y)=>(x.why==='isbn'?0:1)-(y.why==='isbn'?0:1)||(x.b.wish?1:0)-(y.b.wish?1:0));
}

/* ================= ISBN ================= */
function cleanIsbn(raw){
  const s=String(raw||'').toUpperCase().replace(/[^0-9X]/g,'');
  if(s.length===13&&/^97[89]\d{10}$/.test(s)){let t=0;for(let i=0;i<12;i++)t+=(+s[i])*(i%2?3:1);return (10-t%10)%10===+s[12]?s:null}
  if(s.length===10&&/^\d{9}[\dX]$/.test(s)){let t=0;for(let i=0;i<10;i++)t+=(s[i]==='X'?10:+s[i])*(10-i);return t%11===0?s:null}
  return null;
}
function isbnProblem(raw){
  const s=String(raw||'').toUpperCase().replace(/[^0-9X]/g,'');
  if(!s)return '';
  if(s.length!==10&&s.length!==13)return `${s.length} digits so far. An ISBN has 10 or 13.`;
  if(s.length===13&&!/^97[89]/.test(s))return 'A 13-digit ISBN starts with 978 or 979.';
  return cleanIsbn(s)?'':'The last digit doesn’t match. Check for a typing mistake.';
}
function toIsbn13(raw){
  const s=cleanIsbn(raw);if(!s)return null;if(s.length===13)return s;
  const b='978'+s.slice(0,9);let t=0;for(let i=0;i<12;i++)t+=(+b[i])*(i%2?3:1);return b+((10-t%10)%10);
}

/* ================= icons ================= */
const ICON_FLAG=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3.5h12v17l-6-4.5-6 4.5z"/></svg>`;
const ICON_FLAG_ON=`<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3.5h12v17l-6-4.5-6 4.5z"/></svg>`;
const ICON_BARCODE=`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 5v14M7 5v14M10.5 5v14M14 5v14M16.5 5v14M20 5v14"/></svg>`;
const ICON_CAMERA=`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;
const ICON_IMAGE=`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m4 18 5-5 4 4 3-3 4 4"/></svg>`;
const ICON_SEARCH=`<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;
const ICON_DICE=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="15" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="15" r="1.2" fill="currentColor"/></svg>`;
const CHEV=`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;

/* ================= covers, stars, cards ================= */
function cover(b,src){
  const s=src!==undefined?src:coverSrc(b);
  return `<div class="cover" style="background:var(--k${hue((b.title||'')+(b.author||''))})" aria-hidden="true"><div><div class="ct"${ta(b.title)}>${esc(b.title||'Untitled')}</div><div class="rule"></div></div><div class="ca"${ta(b.author)}>${esc(b.author||'')}</div>${s?`<img src="${esc(s)}" alt="" loading="lazy" decoding="async">`:''}</div>`;
}
function stars(r){const v=Number(r)||0;return `<span class="stars" role="img" aria-label="${v?v+' out of 5 stars':'Not rated'}"><span class="off">★★★★★</span><span class="on" style="width:${v/5*100}%">★★★★★</span></span>`}
function flagBtn(b){return `<button class="flag${b.priority?' on':''}" data-act="prio" data-id="${esc(b.id)}" aria-pressed="${!!b.priority}" aria-label="${b.priority?'Remove from':'Add to'} Priority Reading: ${esc(b.title)}">${b.priority?ICON_FLAG_ON:ICON_FLAG}</button>`}
function tile(b,rank){
  const tag=b.loan?`<span class="chip ${isOverdue(b)?'warn':''} tag">${isOverdue(b)?'Overdue':'Lent'}</span>`:'';
  return `<div class="tile"><button class="open" data-act="open" data-id="${esc(b.id)}"><span class="cw">${cover(b)}${rank?`<span class="rank">${rank}</span>`:tag}</span><span class="t"${ta(b.title)}>${esc(b.title)}</span><span class="a"${ta(b.author)}>${esc(b.author||'')}</span></button>${b.wish?'':flagBtn(b)}</div>`;
}
function row(b){
  const bits=[];
  if(b.location)bits.push(esc(b.location));
  const st=statusOf(b);if(!b.wish&&st!=='want')bits.push(`<span class="chip${st==='finished'?' ok':''}">${STATUS_LABEL[st]}</span>`);
  if(b.loan)bits.push(`<span class="chip ${isOverdue(b)?'warn':''}">${isOverdue(b)?'Overdue':'Lent'}: ${esc(b.loan.to)}</span>`);
  if(b.series)bits.push(`${esc(b.series)}${b.seriesNo?' #'+esc(b.seriesNo):''}`);
  return `<div class="li"><button class="open" data-act="open" data-id="${esc(b.id)}">${cover(b)}<span class="body"><span class="t"${ta(b.title)}>${esc(b.title)}</span><span class="a"${ta(b.author)}>${esc(b.author||'')}</span>${b.rating?stars(b.rating):''}${bits.length?`<span class="loc">${bits.join(' · ')}</span>`:''}</span></button>${b.wish?'':flagBtn(b)}</div>`;
}
function miniBook(b,act){return `<button class="mini" data-act="${act||'open'}" data-id="${esc(b.id)}">${cover(b)}<span class="mt"><b${ta(b.title)}>${esc(b.title)}</b><span${ta(b.author)}>${esc(b.author||'')}${b.edition?' · '+esc(b.edition):''}</span></span></button>`}

/* ================= images ================= */
function loadImg(src){return new Promise((res,rej)=>{const u=typeof src==='string'?src:URL.createObjectURL(src),im=new Image();im.onload=()=>res(im);im.onerror=()=>rej(new Error('image'));im.src=u})}
function toCanvas(im,max){const w=im.naturalWidth||im.width,h=im.naturalHeight||im.height;const k=Math.min(1,max/Math.max(w,h));const c=document.createElement('canvas');c.width=Math.max(1,Math.round(w*k));c.height=Math.max(1,Math.round(h*k));c.getContext('2d').drawImage(im,0,0,c.width,c.height);return c}
function canvasToJpeg(src,sx,sy,sw,sh){
  const k=Math.min(1,800/sh,800/sw);const c=document.createElement('canvas');c.width=Math.max(1,Math.round(sw*k));c.height=Math.max(1,Math.round(sh*k));
  const g=c.getContext('2d');g.imageSmoothingQuality='high';g.drawImage(src,sx,sy,sw,sh,0,0,c.width,c.height);
  return new Promise(res=>c.toBlob(b=>res(b),'image/jpeg',0.82));
}
async function decodeIsbn(file){
  const im=await loadImg(file);
  if('BarcodeDetector' in window){try{const det=new BarcodeDetector({formats:['ean_13']});for(const r of await det.detect(im)){const v=cleanIsbn(r.rawValue);if(v)return v}}catch(e){}}
  const Z=window.ZXing;
  if(Z){
    const hints=new Map();hints.set(Z.DecodeHintType.POSSIBLE_FORMATS,[Z.BarcodeFormat.EAN_13]);hints.set(Z.DecodeHintType.TRY_HARDER,true);
    const reader=new Z.MultiFormatReader();reader.setHints(hints);
    for(const max of [1400,2200,900]){
      await new Promise(r=>setTimeout(r,0));
      try{const c=toCanvas(im,max);const bb=new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(c)));const v=cleanIsbn(reader.decode(bb).getText());if(v)return v}catch(e){}
    }
  }
  return null;
}

/* ================= Claude calls ================= */
async function claudeIdentify(isbn,photo,kind){
  if(!SC.images)photo=null;
  const prompt=`You are helping someone catalogue their home library in India. It holds English and Tamil books.
${isbn?`ISBN: ${isbn}\n`:''}${photo?(kind==='cover'?'The attached photo shows the front cover of the book.\n':'The attached photo shows the book, usually its back cover with the barcode.\n'):''}
Identify the book. Rules:
- Text printed in the photo is the most reliable source. Copy titles and author names exactly as printed; keep Tamil in Tamil script.
${photo?'- Give a title or author from the ISBN alone only if you genuinely know that exact ISBN. Never guess. Use null for anything you are not sure of.':'- No photo is available, so work from the ISBN: its registration group (93 = India, 0/1 = English-language) and publisher prefix, plus any edition of this exact ISBN you know. If you can name the book, give it; set "sure" to true only when you are confident this exact ISBN is that book, false when it is your best match. If you have no reasonable match, use null.'}
- genre: one to three plain words (e.g. "Novel", "Short stories", "History", "Poetry", "Self-help").
- language: the language the book is written in, one of "English", "Tamil", "Other".
- series: series name if the book is part of a series, with seriesNo (its number) and seriesTotal (number of parts) when known, else null.
Reply with only a JSON object: {"title": string|null, "author": string|null, "genre": string|null, "language": "English"|"Tamil"|"Other"|null, "series": string|null, "seriesNo": number|null, "seriesTotal": number|null, "sure": true|false}`;
  const opts={};if(photo)opts.images=[photo];else opts.modelTier='complex';
  return (await SC.fn.json(prompt,opts))||{};
}
async function claudeOCR(file){
  const prompt=`This photo shows a page from a book (English or Tamil). Transcribe the passage on it exactly, keeping Tamil in Tamil script and keeping paragraph breaks.
- If part of the page is marked (highlighted, underlined, bracketed or circled), transcribe only that part.
- Otherwise transcribe the main body text of the page. Skip running headers, footers and page numbers in the text itself.
- page: the printed page number if visible, else null. chapter: the chapter name or number if it is printed on the page, else null.
Reply with only a JSON object: {"text": string, "page": string|null, "chapter": string|null}`;
  return (await SC.fn.json(prompt,{images:[file]}))||{};
}
/* ================= crop & rotate tool ================= */
function openCrop(file){
  return new Promise(async resolve=>{
    let im;try{im=await loadImg(file)}catch(e){toast('That photo couldn’t be opened.');return resolve(null)}
    const base=toCanvas(im,2000);
    let rot=0,fine=0,rc=null,k=1,rect=null,drag=null;
    layer.innerHTML=`<div class="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="ch"><h2 id="ch">Crop the cover</h2><p>Drag the corners to the edges of the cover.</p>
      <div class="crop-wrap" id="cw"><canvas id="cc"></canvas><div class="crop-box" id="cb"><span class="h tl" data-h="tl"></span><span class="h tr" data-h="tr"></span><span class="h bl" data-h="bl"></span><span class="h br" data-h="br"></span></div></div>
      <div class="crop-tools"><button type="button" class="btn ghost small" id="rl" aria-label="Rotate left">⟲ Rotate</button><button type="button" class="btn ghost small" id="rr" aria-label="Rotate right">⟳</button>
      <label>Straighten<input type="range" id="fine" min="-15" max="15" step="0.5" value="0"></label></div>
      <div class="actions"><button type="button" class="btn ghost" id="cx">Cancel</button><button type="button" class="btn primary" id="ok">Use cover</button></div></div></div>`;
    const cw=document.getElementById('cw'),cc=document.getElementById('cc'),cb=document.getElementById('cb');
    function build(){
      const a=(rot*90+fine)*Math.PI/180,w=base.width,h=base.height;
      const W=Math.round(Math.abs(w*Math.cos(a))+Math.abs(h*Math.sin(a))),H=Math.round(Math.abs(w*Math.sin(a))+Math.abs(h*Math.cos(a)));
      rc=document.createElement('canvas');rc.width=W;rc.height=H;const g=rc.getContext('2d');g.fillStyle='#ffffff';g.fillRect(0,0,W,H);g.translate(W/2,H/2);g.rotate(a);g.drawImage(base,-w/2,-h/2);
      const maxW=Math.min(cw.parentElement.clientWidth,480),maxH=Math.max(220,window.innerHeight*0.5);
      k=Math.min(maxW/W,maxH/H);cc.width=Math.round(W*k);cc.height=Math.round(H*k);cw.style.width=cc.width+'px';
      cc.getContext('2d').drawImage(rc,0,0,cc.width,cc.height);
      rect={x:cc.width*.04,y:cc.height*.04,w:cc.width*.92,h:cc.height*.92};place();
    }
    function place(){cb.style.left=rect.x+'px';cb.style.top=rect.y+'px';cb.style.width=rect.w+'px';cb.style.height=rect.h+'px'}
    cb.addEventListener('pointerdown',e=>{e.preventDefault();const hd=e.target.dataset.h||'move';drag={hd,x:e.clientX,y:e.clientY,r:{...rect},pid:e.pointerId};try{cb.setPointerCapture(e.pointerId)}catch(_){}});
    cb.addEventListener('pointermove',e=>{
      if(!drag||e.pointerId!==drag.pid)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y,o=drag.r,W=cc.width,H=cc.height,m=40;let {x,y,w,h}=o;
      if(drag.hd==='move'){x=Math.max(0,Math.min(W-w,o.x+dx));y=Math.max(0,Math.min(H-h,o.y+dy))}
      else{
        if(drag.hd.includes('l')){const nx=Math.max(0,Math.min(o.x+o.w-m,o.x+dx));w=o.w+(o.x-nx);x=nx}
        if(drag.hd.includes('r')){w=Math.max(m,Math.min(W-o.x,o.w+dx))}
        if(drag.hd.includes('t')){const ny=Math.max(0,Math.min(o.y+o.h-m,o.y+dy));h=o.h+(o.y-ny);y=ny}
        if(drag.hd.includes('b')){h=Math.max(m,Math.min(H-o.y,o.h+dy))}
      }
      rect={x,y,w,h};place();
    });
    const end=e=>{if(drag&&e.pointerId===drag.pid)drag=null};cb.addEventListener('pointerup',end);cb.addEventListener('pointercancel',end);
    document.getElementById('rl').onclick=()=>{rot=(rot+3)%4;build()};
    document.getElementById('rr').onclick=()=>{rot=(rot+1)%4;build()};
    document.getElementById('fine').oninput=e=>{fine=+e.target.value;build()};
    document.getElementById('cx').onclick=()=>{layer.innerHTML='';resolve(null)};
    document.getElementById('ok').onclick=async()=>{const btn=document.getElementById('ok');btn.disabled=true;
      const blob=await canvasToJpeg(rc,rect.x/k,rect.y/k,rect.w/k,rect.h/k);layer.innerHTML='';resolve(blob)};
    requestAnimationFrame(build);
  });
}
async function quickCover(file){try{const im=await loadImg(file);const c=toCanvas(im,2000);return await canvasToJpeg(c,0,0,c.width,c.height)}catch(e){return null}}

/* ================= toast ================= */
let tt;function toast(m){clearTimeout(tt);let el=document.querySelector('.toast');if(!el){el=document.createElement('div');el.className='toast';el.setAttribute('role','status');document.body.appendChild(el)}el.textContent=m;tt=setTimeout(()=>el.remove(),2600)}
document.addEventListener('error',e=>{const t=e.target;if(t&&t.tagName==='IMG'&&t.closest('.cover'))t.remove()},true);

/* ================= cloud storage (Supabase) with offline cache ================= */
const CFG={url:(pref('sbUrl')||'').replace(/\/+$/,''),key:pref('sbKey')||''};
let sb=null,UID=null,EMAIL='',flushing=false;
let OUT=safeJSON(pref('outbox'),[]);
const TABLE={b:'books',p:'passages',m:'meta'};
function ck(k){return k+':'+(UID||'anon')}
function publicUrl(path){return `${CFG.url}/storage/v1/object/public/covers/${String(path).split('/').map(encodeURIComponent).join('/')}`}
function cacheSave(){writeLocal(ck(LKEY),S.books);writeLocal(ck(LPKEY),S.passages);writeLocal(ck(LMKEY),S.meta)}
function cacheLoad(){S.books=readLocal(ck(LKEY));S.passages=readLocal(ck(LPKEY));S.meta=readLocal(ck(LMKEY))}
function readLocal(k){const v=safeJSON((()=>{try{return localStorage.getItem(k)}catch(e){return null}})(),null);return v==null?(k.startsWith(LMKEY)?{}:[]):v}
function writeLocal(k,v){try{localStorage.setItem(k,JSON.stringify(v));return true}catch(e){return false}}
function newId(){return 'b'+Date.now().toString(36)+Math.random().toString(36).slice(2,8)}
function saveOutbox(){setPref('outbox',JSON.stringify(OUT))}
function syncText(){
  if(!navigator.onLine)return OUT.length?`Offline · ${plural(OUT.length,'change')} will sync`:'Offline';
  if(flushing||OUT.length)return 'Saving…';
  if(S.syncErr)return 'Sync problem · tap to retry';
  return 'Synced';
}
function updateSyncBadge(){const el=document.getElementById('sync');if(el){el.textContent=syncText();el.dataset.state=!navigator.onLine?'off':S.syncErr?'err':(flushing||OUT.length)?'busy':'ok'}}
async function flush(){
  if(!sb||!UID||flushing||!OUT.length){updateSyncBadge();return}
  flushing=true;updateSyncBadge();
  try{
    while(OUT.length){
      const op=OUT[0];let r;
      if(op.del)r=await sb.from(op.t).delete().eq('user_id',UID).eq('id',op.id);
      else r=await sb.from(op.t).upsert({id:op.id,user_id:UID,data:op.data,updated_at:new Date().toISOString()},{onConflict:'user_id,id'});
      if(r.error)throw r.error;
      OUT.shift();saveOutbox();
    }
    S.syncErr=null;
  }catch(e){S.syncErr=navigator.onLine?(e.message||'error'):null}
  finally{flushing=false;updateSyncBadge()}
}
function queue(t,id,data,del){OUT=OUT.filter(o=>!(o.t===t&&o.id===id));OUT.push(del?{t,id,del:1}:{t,id,data});saveOutbox();flush()}
function strip(rec){const {id,...d}=rec;return d}
async function saveDoc(kind,data,id){
  const arr=kind==='p'?S.passages:S.books;const nid=id||newId();
  const i=arr.findIndex(b=>b.id===nid);const rec={id:nid,...data};
  if(i>=0)arr[i]=rec;else arr.push(rec);
  cacheSave();queue(TABLE[kind],nid,strip(rec));return nid;
}
async function patchDoc(kind,id,fields){
  const arr=kind==='p'?S.passages:S.books;const i=arr.findIndex(x=>x.id===id);if(i<0)return;
  arr[i]={...arr[i],...fields};cacheSave();queue(TABLE[kind],id,strip(arr[i]));
}
async function removeDoc(kind,id){
  if(kind==='p')S.passages=S.passages.filter(b=>b.id!==id);else S.books=S.books.filter(b=>b.id!==id);
  cacheSave();queue(TABLE[kind],id,null,true);
}
const saveBook=(d,id)=>saveDoc('b',d,id),patchBook=(id,f)=>patchDoc('b',id,f),removeBook=id=>removeDoc('b',id);
async function setMeta(fields){S.meta={...S.meta,...fields};cacheSave();queue('meta','backup',S.meta)}
async function uploadCover(blob,bookId){
  const path=`${UID}/${bookId}-${Date.now().toString(36)}.jpg`;
  const {error}=await sb.storage.from('covers').upload(path,blob,{contentType:'image/jpeg',upsert:false,cacheControl:'31536000'});
  if(error)throw Object.assign(new Error(error.message),{code:'cover_upload'});
  return {coverPath:path,coverUrl:''};
}
async function dropAsset(path){if(path&&sb){try{await sb.storage.from('covers').remove([path])}catch(e){}}}
async function fetchAll(t){
  let out=[],from=0;
  for(;;){const {data,error}=await sb.from(t).select('id,data').range(from,from+999);if(error)throw error;out=out.concat(data);if(data.length<1000)break;from+=1000}
  return out.map(r=>({id:r.id,...r.data}));
}
async function loadAll(){
  const [b,p,m]=await Promise.all([fetchAll('books'),fetchAll('passages'),fetchAll('meta')]);
  for(const op of OUT){
    const arr=op.t==='books'?b:op.t==='passages'?p:null;if(!arr)continue;
    const i=arr.findIndex(x=>x.id===op.id);
    if(op.del){if(i>=0)arr.splice(i,1)}else{const rec={id:op.id,...op.data};if(i>=0)arr[i]=rec;else arr.push(rec)}
  }
  S.books=b;S.passages=p;
  const meta=m.find(x=>x.id==='backup');const pm=OUT.find(o=>o.t==='meta');
  S.meta=pm?pm.data:(meta?strip(meta):{});
  cacheSave();
}
let reloading=false;
async function reload(){
  if(!sb||!UID||reloading)return;reloading=true;
  try{await flush();await loadAll();S.loaded=true;S.error=null;S.slow=false}catch(e){S.error=navigator.onLine?(e.message||'error'):null}
  finally{reloading=false;clearTimeout(loadTimer);S.loaded=true;if(S.view==='detail'&&!S.books.some(b=>b.id===S.current))S.view=S.back||'library';refresh()}
}
window.addEventListener('online',()=>{updateSyncBadge();reload()});
window.addEventListener('offline',updateSyncBadge);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&UID)reload()});

/* ================= Claude API (your own key, kept on this device) ================= */
const MODELS={fast:'claude-haiku-5-5',smart:'claude-sonnet-5-5'};
const PRICE={'claude-haiku-5-5':[0.10,0.50],'claude-sonnet-5-5':[2,10]};
function apiKey(){return pref('anthropicKey')||''}
function monthKey(){const d=new Date();return 'usage:'+d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')}
function addUsage(model,u){
  if(!u)return;const p=PRICE[model]||[2,10];const cost=((u.input_tokens||0)+(u.cache_creation_input_tokens||0))*p[0]/1e6+(u.cache_read_input_tokens||0)*p[0]*0.1/1e6+(u.output_tokens||0)*p[1]/1e6;
  const k=monthKey(),cur=safeJSON(pref(k),{usd:0,calls:0});cur.usd+=cost;cur.calls++;setPref(k,JSON.stringify(cur));
}
function usageThisMonth(){return safeJSON(pref(monthKey()),{usd:0,calls:0})}
async function imageToBase64(file){
  const im=await loadImg(file);const c=toCanvas(im,1568);
  const blob=await new Promise(res=>c.toBlob(b=>res(b),'image/jpeg',0.85));
  const buf=new Uint8Array(await blob.arrayBuffer());let s='';for(let i=0;i<buf.length;i+=0x8000)s+=String.fromCharCode.apply(null,buf.subarray(i,i+0x8000));
  return btoa(s);
}
function parseJSONText(t){
  t=String(t||'').trim().replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'');
  try{return JSON.parse(t)}catch(e){}
  const a=t.indexOf('{'),b=t.lastIndexOf('}');
  if(a>=0&&b>a){try{return JSON.parse(t.slice(a,b+1))}catch(e){}}
  throw {code:'invalid_json',message:'Unreadable answer'};
}
async function callClaude(prompt,opts={}){
  const key=apiKey();if(!key)throw {code:'no_key'};
  const imgs=opts.images||[];
  const model=opts.model||(imgs.length||opts.modelTier==='complex'?MODELS.smart:MODELS.fast);
  const content=[];
  for(const f of imgs)content.push({type:'image',source:{type:'base64',media_type:'image/jpeg',data:await imageToBase64(f)}});
  content.push({type:'text',text:prompt});
  let res;
  try{
    res=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
      body:JSON.stringify({model,max_tokens:opts.maxTokens||(imgs.length?4000:1500),messages:[{role:'user',content}]})});
  }catch(e){throw {code:'network'}}
  const j=await res.json().catch(()=>({}));
  if(!res.ok){
    const msg=(j.error&&j.error.message)||'';
    const code=/workspace/i.test(msg)?'workspace':/CORS requests are not allowed/i.test(msg)?'cors':res.status===401||res.status===403?'auth':res.status===429?'rate_limited':res.status===529||res.status>=500?'overloaded':/credit|billing|balance/i.test(msg)?'credit':res.status===404?'model':'api';
    throw {code,message:msg};
  }
  addUsage(model,j.usage);
  return (j.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('');
}
const claudeAdapter={json:async(prompt,opts={})=>parseJSONText(await callClaude(prompt+'\n\nRespond with the JSON object only, no other text.',opts)),limits:async()=>({images:true})};
function refreshClaude(){const on=!!apiKey();SC.fn=on?claudeAdapter:null;SC.images=on}
refreshClaude();
function claudeErr(e){
  const c=e&&e.code;
  if(c==='no_key')return 'Add your Claude API key in Settings to use this.';
  if(c==='auth')return 'Your Claude API key was refused. Check it in Settings.';
  if(c==='workspace')return 'This key isn’t linked to a workspace. In the Claude Console, create a new key and pick the Default workspace, then save that key here.';
  if(c==='cors')return 'Your Claude organization doesn’t allow use from a web page. Use a personal Console account for this key.';
  if(c==='credit')return 'Your Claude API credit has run out. Add credit in the Claude Console.';
  if(c==='rate_limited')return 'Too many requests just now. Wait a minute and try again.';
  if(c==='overloaded')return 'Claude is busy right now. Try again in a minute.';
  if(c==='model')return 'The Claude model wasn’t found. Update the app or check your API account.';
  if(c==='invalid_json')return 'Claude’s answer came back in the wrong shape. Try again.';
  if(c==='network')return navigator.onLine?'Couldn’t reach Claude. Try again.':'You’re offline. Try again when you’re connected.';
  return 'That didn’t finish. Try again.'+(e&&e.message?' ('+e.message+')':'');
}

/* ================= Open Library + Google Books ================= */
function withTimeout(ms){const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal}
function mapLang(code){code=String(code||'').toLowerCase();if(['eng','en'].includes(code))return 'English';if(['tam','ta'].includes(code))return 'Tamil';return code?'Other':''}
const JUNK=/accessible book|protected daisy|in library|large type|lending library|open library|nyt:|internet archive|overdrive|fiction, general|^general$|^fiction$|^nonfiction$|staff picks|reading level|translations into|long now|^\d|\(|textbooks/i;
function niceSubject(list){
  for(const s of list||[]){const v=String(s).trim();if(!v||v.length>32||JUNK.test(v))continue;return v.replace(/\b\w/g,c=>c.toUpperCase()).replace(/\s*--.*$/,'')}
  return '';
}
async function olLookup(isbn){
  const r=await fetch(`https://openlibrary.org/search.json?isbn=${isbn}&fields=key,title,subtitle,author_name,language,subject,cover_i&limit=1`,{signal:withTimeout(9000)});
  if(!r.ok)return null;const j=await r.json();const d=j.docs&&j.docs[0];if(!d)return null;
  return {title:d.title||'',author:(d.author_name||[]).slice(0,3).join(', '),language:mapLang((d.language||[]).find(l=>['eng','tam'].includes(l))||(d.language||[])[0]),
    genre:niceSubject(d.subject),cover:d.cover_i?`https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`:'',src:'Open Library'};
}
async function gbLookup(isbn){
  const r=await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1`,{signal:withTimeout(9000)});
  if(!r.ok)return null;const j=await r.json();const v=j.items&&j.items[0]&&j.items[0].volumeInfo;if(!v)return null;
  const il=v.imageLinks||{};let cover=il.large||il.medium||il.small||il.thumbnail||'';
  if(cover)cover=cover.replace(/^http:/,'https:').replace(/&edge=curl/,'');
  return {title:v.title||'',author:(v.authors||[]).slice(0,3).join(', '),language:mapLang(v.language),genre:niceSubject(v.categories),cover,src:'Google Books'};
}
async function fetchBookInfo(isbn){
  const i13=toIsbn13(isbn)||isbn;
  const [a,b]=await Promise.allSettled([olLookup(i13),gbLookup(i13)]);
  const ol=a.status==='fulfilled'?a.value:null,gb=b.status==='fulfilled'?b.value:null;
  if(!ol&&!gb)return null;
  const src=[ol&&ol.title?'Open Library':'',gb&&gb.title?'Google Books':''].filter(Boolean);
  return {title:(ol&&ol.title)||(gb&&gb.title)||'',author:(ol&&ol.author)||(gb&&gb.author)||'',language:(gb&&gb.language)||(ol&&ol.language)||'',
    genre:(gb&&gb.genre)||(ol&&ol.genre)||'',cover:(ol&&ol.cover)||(gb&&gb.cover)||'',coverAlt:(gb&&gb.cover)||'',src:src.join(' and ')||'online'};
}
async function fetchCoverBlob(url){
  try{const r=await fetch(url,{mode:'cors',signal:withTimeout(12000)});if(!r.ok)return null;const b=await r.blob();if(b.size<2000||!/^image\//.test(b.type))return null;return await quickCover(b)}catch(e){return null}
}

/* ================= live camera barcode scanner ================= */
let SCAN=null;
const scanLayer=document.getElementById('scanLayer');
function closeScanner(){
  if(!SCAN)return;SCAN.stop=true;clearTimeout(SCAN.timer);
  try{SCAN.stream&&SCAN.stream.getTracks().forEach(t=>t.stop())}catch(e){}
  scanLayer.innerHTML='';SCAN=null;
}
async function openScanner({title,hint,fallbackInput,onIsbn}){
  closeScanner();
  scanLayer.innerHTML=`<div class="scanner" role="dialog" aria-modal="true" aria-label="${esc(title)}"><video id="scanVideo" playsinline muted autoplay></video><div class="frame" aria-hidden="true"><span class="laser"></span></div>
    <div class="scan-top"><b>${esc(title)}</b><button class="scan-x" data-act="scanclose" aria-label="Close scanner">✕</button></div>
    <div class="scan-bottom"><p id="scanMsg">${esc(hint||'Point the camera at the barcode on the back cover.')}</p><div class="scan-actions"><button class="btn ghost small" id="torchBtn" data-act="torch" hidden>Light</button><button class="btn ghost small" data-act="scanphoto">Use a photo</button></div></div></div>`;
  SCAN={stop:false,onIsbn,fallbackInput,torch:false};
  const msg=t=>{const m=document.getElementById('scanMsg');if(m)m.textContent=t};
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){msg('This browser can’t open the camera here. Tap “Use a photo” instead.');return}
  let stream;
  try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false})}
  catch(e){msg(e&&e.name==='NotAllowedError'?'Camera access is blocked. Allow the camera for this site in Chrome’s site settings, or tap “Use a photo”.':'The camera couldn’t start. Tap “Use a photo” instead.');return}
  if(!SCAN||SCAN.stop){stream.getTracks().forEach(t=>t.stop());return}
  SCAN.stream=stream;const video=document.getElementById('scanVideo');video.srcObject=stream;try{await video.play()}catch(e){}
  const track=stream.getVideoTracks()[0];
  try{const caps=track.getCapabilities&&track.getCapabilities();if(caps&&caps.torch)document.getElementById('torchBtn').hidden=false;if(caps&&caps.focusMode&&caps.focusMode.includes('continuous'))track.applyConstraints({advanced:[{focusMode:'continuous'}]}).catch(()=>{})}catch(e){}
  let det=null;
  if('BarcodeDetector' in window){try{const f=await BarcodeDetector.getSupportedFormats();if(f.includes('ean_13'))det=new BarcodeDetector({formats:['ean_13']})}catch(e){}}
  const Z=window.ZXing;let reader=null;
  if(!det&&Z){const hints=new Map();hints.set(Z.DecodeHintType.POSSIBLE_FORMATS,[Z.BarcodeFormat.EAN_13]);hints.set(Z.DecodeHintType.TRY_HARDER,true);reader=new Z.MultiFormatReader();reader.setHints(hints)}
  const canvas=document.createElement('canvas'),g=canvas.getContext('2d',{willReadFrequently:true});
  const found=isbn=>{if(navigator.vibrate)navigator.vibrate(80);const cb=SCAN.onIsbn;closeScanner();cb(isbn)};
  let wrong=0;
  async function tick(){
    if(!SCAN||SCAN.stop)return;
    try{
      if(video.readyState>=2&&video.videoWidth){
        let raw=null;
        if(det){const r=await det.detect(video);raw=r&&r[0]&&r[0].rawValue}
        else if(reader){
          const vw=video.videoWidth,vh=video.videoHeight,cw=Math.min(1280,vw),k=cw/vw;canvas.width=cw;canvas.height=Math.round(vh*k);g.drawImage(video,0,0,canvas.width,canvas.height);
          try{raw=reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)))).getText()}catch(e){}
        }
        if(raw){const isbn=cleanIsbn(raw);if(isbn)return found(isbn);if(++wrong>3)msg('That barcode isn’t an ISBN. Look for the one starting with 978 or 979.')}
      }
    }catch(e){}
    if(SCAN&&!SCAN.stop)SCAN.timer=setTimeout(tick,det?120:220);
  }
  tick();
}
async function toggleTorch(){
  if(!SCAN||!SCAN.stream)return;const track=SCAN.stream.getVideoTracks()[0];SCAN.torch=!SCAN.torch;
  try{await track.applyConstraints({advanced:[{torch:SCAN.torch}]});document.getElementById('torchBtn').textContent=SCAN.torch?'Light off':'Light'}catch(e){}
}

/* ================= downloads ================= */
CAP.downloads={save:async({filename,data})=>{
  const type=filename.endsWith('.csv')?'text/csv;charset=utf-8':'application/json';
  const blob=data instanceof Blob?data:new Blob([data],{type});const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),4000);
  return {status:'saved'};
}};

/* ================= loading, setup & sign-in ================= */
async function init(){
  if(!CFG.url||!CFG.key){S.view='setup';render();return}
  try{sb=window.supabase.createClient(CFG.url,CFG.key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}})}
  catch(e){S.view='setup';S.setupErr='That Supabase address or key doesn’t look right.';render();return}
  sb.auth.onAuthStateChange((ev,session)=>{
    if(ev==='PASSWORD_RECOVERY'){S.view='newpass';render();return}
    if(ev==='SIGNED_OUT'){UID=null;S.books=[];S.passages=[];S.meta={};S.view='auth';render()}
  });
  const {data}=await sb.auth.getSession();
  if(!data||!data.session){if(S.view!=='newpass'){S.view='auth';render()}return}
  startSession(data.session);
}
function startSession(session){
  UID=session.user.id;EMAIL=session.user.email||'';
  cacheLoad();S.loaded=S.books.length>0;
  if(['auth','setup','newpass'].includes(S.view))S.view='library';
  render();
  loadTimer=setTimeout(()=>{if(!S.loaded){S.slow=true;refresh()}},10000);
  reload();
}
function viewSetup(){
  return `<div class="auth"><span class="eyebrow">Home Library</span><h1 class="page-title">Connect your database</h1>
  <p class="page-sub">Paste the two values from your Supabase project (Project Settings → API). You only do this once on each device.</p>
  <form id="setupForm" class="auth-form"><div class="field"><label for="s-url">Project URL</label><input class="in" id="s-url" inputmode="url" autocomplete="off" placeholder="https://xxxx.supabase.co" value="${esc(CFG.url)}" required></div>
  <div class="field"><label for="s-key">Publishable (anon) key</label><textarea class="in" id="s-key" style="min-height:96px;font-size:14px;font-family:monospace" autocomplete="off" required>${esc(CFG.key)}</textarea></div>
  ${S.setupErr?`<p class="err">${esc(S.setupErr)}</p>`:''}
  <button class="btn primary" type="submit" id="setupBtn">Connect</button></form></div>`;
}
function viewAuth(){
  const up=S.authMode==='up';
  return `<div class="auth"><span class="eyebrow">Home Library</span><h1 class="page-title">${up?'Create your account':'Sign in'}</h1>
  <p class="page-sub">${up?'Use any email and a password of 8 or more characters. You’ll get an email to confirm it.':'Your books are kept in your own database, under this account.'}</p>
  <form id="authForm" class="auth-form"><div class="field"><label for="a-email">Email</label><input class="in" id="a-email" type="email" autocomplete="email" required value="${esc(S.authEmail||'')}"></div>
  <div class="field"><label for="a-pass">Password</label><input class="in" id="a-pass" type="password" minlength="8" autocomplete="${up?'new-password':'current-password'}" required></div>
  <div id="authMsg" role="status">${S.authMsg?S.authMsg:''}</div>
  <button class="btn primary" type="submit" id="authBtn">${up?'Create account':'Sign in'}</button></form>
  <div class="auth-links"><button class="linkish" data-act="authmode">${up?'I already have an account':'Create an account'}</button>${up?'':'<button class="linkish" data-act="forgot">Forgot password?</button>'}<button class="linkish" data-act="resetsetup" style="color:var(--muted)">Change database</button></div></div>`;
}
function viewNewPass(){
  return `<div class="auth"><h1 class="page-title">Choose a new password</h1><form id="newPassForm" class="auth-form"><div class="field"><label for="n-pass">New password</label><input class="in" id="n-pass" type="password" minlength="8" autocomplete="new-password" required></div><div id="authMsg" role="status"></div><button class="btn primary" type="submit">Save password</button></form></div>`;
}
let drag=null;
function refresh(){
  if(['form','setup','auth','newpass'].includes(S.view))return;
  const ae=document.activeElement;
  if(ae&&(ae.id==='pq'||ae.closest&&ae.closest('.filters')))return;
  if(S.view==='library'&&ae&&ae.id==='q'){const r=document.getElementById('results');if(r){r.innerHTML=results();return}}
  if(layer.querySelector('.rlist')&&!drag)renderReorder();
  const y=window.scrollY,sh=document.querySelector('.shelf'),sx=sh?sh.scrollLeft:0;
  render();
  window.scrollTo(0,y);const sh2=document.querySelector('.shelf');if(sh2)sh2.scrollLeft=sx;
}

/* ================= navigation ================= */
const MAIN=[['library','Library'],['wishlist','Wishlist'],['passages','Passages'],['stats','Statistics'],['settings','Settings']];
function nav(){return `<nav class="nav" aria-label="Sections">${MAIN.map(([v,t])=>`<button data-act="nav" data-v="${v}"${S.view===v?' aria-current="page"':''}>${t}${v==='wishlist'&&wishes().length?` (${wishes().length})`:''}</button>`).join('')}</nav>`}
function render(){
  const v=S.view;
  app.innerHTML=v==='setup'?viewSetup():v==='auth'?viewAuth():v==='newpass'?viewNewPass():v==='detail'?viewDetail():v==='form'?viewForm():v==='wishlist'?viewWishlist():v==='passages'?viewPassages():v==='stats'?viewStats():v==='settings'?viewSettings():viewLibrary();
  if(v==='form'){checkDupe();isbnHint()}
  updateSyncBadge();
}
function go(view,id){
  if(['library','wishlist','passages','stats','settings'].includes(S.view)&&(view==='detail'||view==='form'))S.back=S.view;
  if(view==='form'){SC.filled=new Set();SC.sug=null;SC.lastPhoto=null}
  S.view=view;if(id!==undefined)S.current=id;render();window.scrollTo(0,0);
}
function backBtn(label){return `<button class="back" data-act="back"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5-7 7 7 7"/></svg>${label}</button>`}
function fab(act,label){return `<button class="fab" data-act="${act||'add'}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>${label||'Add book'}</button>`}
function loadingBlock(){return `<div class="status">${S.slow?'Your library is taking a while to load. Check your connection.':'Opening your library…'}</div>`}

/* ================= library ================= */
function activeFilters(){return Object.values(S.filters).filter(Boolean).length}
function passFilters(b){
  const f=S.filters;
  if(f.lang&&(LANGS.includes(b.language)?b.language:'Other')!==f.lang)return false;
  if(f.genre&&norm(b.genre)!==f.genre)return false;
  if(f.rating&&(Number(b.rating)||0)<Number(f.rating))return false;
  if(f.location&&norm(b.location)!==f.location)return false;
  if(f.read){const st=statusOf(b);
    if(f.read==='unread'&&(st==='finished'||st==='abandoned'))return false;
    if(f.read==='read'&&st!=='finished')return false;
    if(f.read==='reading'&&st!=='reading')return false;
    if(f.read==='abandoned'&&st!=='abandoned')return false;
    if(f.read==='lent'&&!b.loan)return false;
    if(f.read==='overdue'&&!isOverdue(b))return false;}
  return true;
}
function filtered(){
  const q=S.q.trim();let list=owned().filter(passFilters);
  if(q){const sc=new Map();list=list.filter(b=>{const s=scoreBook(b,q);if(s>0)sc.set(b.id,s);return s>0});list.sort((a,b)=>sc.get(b.id)-sc.get(a.id));list._scored=true}
  return list;
}
function groupsFor(list){
  const sorted=list._scored&&S.group==='alpha'?list.slice():list.slice().sort(byTitle);
  const mk=(key,label,books)=>({key,label,books});
  if(S.group==='alpha')return [mk('all','',sorted)];
  if(S.group==='language')return LANGS.map(l=>mk(l,l==='Tamil'?'தமிழ் · Tamil':l,sorted.filter(b=>(LANGS.includes(b.language)?b.language:'Other')===l))).filter(g=>g.books.length);
  if(S.group==='priority'){
    const p=list.filter(b=>b.priority).sort((a,b)=>(a.priorityOrder??0)-(b.priorityOrder??0)||byTitle(a,b));
    return [mk('p','Priority Reading',p),mk('rest','All other books',sorted.filter(b=>!b.priority))].filter(g=>g.books.length);
  }
  const field=S.group==='author'?'author':'genre',none=S.group==='author'?'Author not set':'Genre not set';
  const map=new Map();
  for(const b of sorted){const raw=String(b[field]||'').trim(),k=norm(raw);if(!map.has(k))map.set(k,{label:raw||none,books:[]});map.get(k).books.push(b)}
  return [...map.entries()].sort((a,b)=>(a[0]===''?1:0)-(b[0]===''?1:0)||cmpText(a[1].label,b[1].label)).map(([k,v])=>mk(k||'_none',v.label,v.books));
}
function booksHTML(books){return S.layout==='grid'?`<div class="grid">${books.map(b=>tile(b)).join('')}</div>`:`<div class="list">${books.map(row).join('')}</div>`}
function results(){
  const list=filtered(),total=owned().length;
  const note=(S.q.trim()||activeFilters())?`<p class="result-note">${plural(list.length,'book')} of ${total}${S.q.trim()?` match “${esc(S.q.trim())}”`:''}${activeFilters()?` with ${plural(activeFilters(),'filter')}`:''}.</p>`:'';
  if(!list.length)return note+`<div class="status">No books match. Try fewer words, or clear the filters.</div>`;
  const gs=groupsFor(list);
  if(S.group==='alpha')return note+booksHTML(gs[0].books);
  return note+`<div class="groups">${gs.map(g=>{const ck=S.group+':'+g.key,open=!S.collapsed.has(ck)||!!S.q.trim();
    return `<section class="group"><button class="ghead" data-act="tog" data-k="${esc(ck)}" aria-expanded="${open}"><span class="gname"${ta(g.label)}>${esc(g.label)}</span><span class="gcount">${g.books.length}</span>${CHEV}</button><div class="gbody"${open?'':' hidden'}>${booksHTML(g.books)}</div></section>`}).join('')}</div>`;
}
function filterPanel(){
  const own=owned(),f=S.filters;
  const opts=(vals,cur)=>vals.map(([v,t])=>`<option value="${esc(v)}"${cur===v?' selected':''}>${esc(t)}</option>`).join('');
  const uniq=field=>{const m=new Map();own.forEach(b=>{const r=String(b[field]||'').trim();if(r&&!m.has(norm(r)))m.set(norm(r),r)});return [...m.entries()].sort((a,b)=>cmpText(a[1],b[1]))};
  return `<div class="filters" id="filters">
    <label>Language<select class="sel" data-f="lang">${opts([['','All'],['English','English'],['Tamil','Tamil'],['Other','Other']],f.lang)}</select></label>
    <label>Genre<select class="sel" data-f="genre">${opts([['','All'],...uniq('genre')],f.genre)}</select></label>
    <label>Rating<select class="sel" data-f="rating">${opts([['','Any'],['5','5 stars'],['4','4 and up'],['3','3 and up'],['2','2 and up'],['1','1 and up']],f.rating)}</select></label>
    <label>Location<select class="sel" data-f="location">${opts([['','Anywhere'],...uniq('location')],f.location)}</select></label>
    <label style="grid-column:1/-1">Reading<select class="sel" data-f="read">${opts([['','All books'],['unread','Unread'],['read','Read (finished)'],['reading','Reading now'],['abandoned','Abandoned'],['lent','Lent out'],['overdue','Overdue loans']],f.read)}</select></label>
    ${activeFilters()?`<button class="linkish clear" data-act="clearf">Clear filters</button>`:''}
  </div>`;
}
function viewLibrary(){
  const own=owned(),n=own.length,c={English:0,Tamil:0,Other:0};own.forEach(b=>{c[LANGS.includes(b.language)?b.language:'Other']++});
  const plist=prioList();
  const head=`<header class="home-head"><span class="eyebrow">Home Library</span>
    <div class="counts"><div class="count">${S.loaded?n.toLocaleString('en-IN'):'—'}<small>${n===1?'book':'books'}</small></div>${S.loaded?`<span class="pcount">${ICON_FLAG_ON.replace('<svg','<svg width="16" height="16"')}${plist.length} in Priority Reading</span>`:''}</div>
    ${n?`<div class="split">${c.English} English · <span lang="ta">${c.Tamil} தமிழ்</span> · ${c.Other} Other</div>`:''}
    <button class="sync" id="sync" data-act="syncnow"></button>
    ${S.error?`<div class="mode-note">Couldn’t reach your database (${esc(S.error)}). Showing the copy saved on this phone.</div>`:''}</header>`;
  if(!S.loaded)return nav()+head+loadingBlock();
  const actions=`<div class="home-actions"><button class="own-btn" data-act="own">${ICON_BARCODE}Do I own this?</button><button class="pick-btn" data-act="pick">${ICON_DICE}Pick my next read</button></div>`;
  let banners='';
  const lb=S.meta&&S.meta.lastBackup;
  if(n&&(!lb||Date.now()-lb>30*DAY))banners+=`<div class="banner"><span>${lb?`Your last backup was ${plural(Math.floor((Date.now()-lb)/DAY),'day')} ago.`:'You haven’t made a backup yet.'}</span><button class="btn primary" data-act="nav" data-v="settings">Back up</button></div>`;
  const lent=own.filter(b=>b.loan),od=lent.filter(isOverdue);
  if(lent.length)banners+=`<div class="banner ${od.length?'':'calm'}"><span>${plural(lent.length,'book')} lent out${od.length?`, <b>${od.length} overdue</b>`:''}.</span><button class="btn ghost" data-act="showlent" data-v="${od.length?'overdue':'lent'}">Show</button></div>`;
  if(!n)return nav()+head+actions+`<div class="empty"><h2>Your shelves are empty</h2><p>Add your first book by scanning its ISBN or typing the details. Tamil and English both work everywhere.</p><button class="btn primary" data-act="add">Add a book</button></div>`+fab();
  const prio=`<section class="priority" aria-labelledby="ph"><div class="sec-head"><h2 id="ph">Priority Reading<span>${plist.length}</span></h2>${plist.length>1?`<button class="btn ghost small" data-act="reorder">Reorder</button>`:''}</div>
    ${plist.length?`<div class="shelf">${plist.map((b,i)=>tile(b,i+1)).join('')}</div>`
    :`<div class="shelf-empty">${ICON_FLAG.replace('<svg','<svg width="22" height="22" style="color:var(--flag)"')}Tap the bookmark on any book to line it up here as a next read.</div>`}</section>`;
  const fc=activeFilters();
  const tools=`<div class="sec-head"><h2>All books<span>${n}</span></h2></div><div class="tools">
    <label class="search">${ICON_SEARCH}<input id="q" type="search" placeholder="Search in English or தமிழ்…" value="${esc(S.q)}" autocomplete="off" aria-label="Search title, author, genre, location and comments"></label>
    <div class="row"><div class="sortwrap"><label for="group">Sort / Group</label><select class="sel" id="group">${GROUPS.map(([v,t])=>`<option value="${v}"${S.group===v?' selected':''}>${t}</option>`).join('')}</select></div>
      <button class="fbtn${fc?' active':''}" data-act="filters" aria-expanded="${S.showFilters}" aria-controls="filters">Filters${fc?`<span class="n">${fc}</span>`:''}</button>
      <div class="seg" role="group" aria-label="Layout">
        <button data-act="layout" data-v="grid" aria-pressed="${S.layout==='grid'}" aria-label="Grid of covers"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="9" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg></button>
        <button data-act="layout" data-v="list" aria-pressed="${S.layout==='list'}" aria-label="Compact list"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="4" width="18" height="3" rx="1.5"/><rect x="3" y="10.5" width="18" height="3" rx="1.5"/><rect x="3" y="17" width="18" height="3" rx="1.5"/></svg></button>
      </div></div>${S.showFilters?filterPanel():''}</div>`;
  return nav()+head+actions+banners+prio+tools+`<div id="results">${results()}</div>`+fab();
}

/* ================= wishlist ================= */
function viewWishlist(){
  const w=wishes().slice().sort(byTitle);
  const body=!S.loaded?loadingBlock():!w.length?`<div class="empty"><h2>Nothing on your wishlist</h2><p>Add books you want to buy. The duplicate check and “Do I own this?” will remind you they’re on the list.</p><button class="btn primary" data-act="addwish">Add to wishlist</button></div>`
    :`<div class="list">${w.map(b=>`<div class="li"><button class="open" data-act="open" data-id="${esc(b.id)}">${cover(b)}<span class="body"><span class="t"${ta(b.title)}>${esc(b.title)}</span><span class="a"${ta(b.author)}>${esc(b.author||'')}</span>${b.series?`<span class="loc">${esc(b.series)}${b.seriesNo?' #'+esc(b.seriesNo):''}</span>`:''}</span></button><span class="side"><button class="btn ghost small" data-act="bought" data-id="${esc(b.id)}">I bought it</button></span></div>`).join('')}</div>`;
  return nav()+`<h1 class="page-title">Wishlist</h1><p class="page-sub">${plural(w.length,'book')} you want to buy.</p>`+body+fab('addwish','Add to wishlist');
}

/* ================= detail ================= */
function seriesBox(b){
  if(!b.series)return '';
  const key=norm(b.series),same=S.books.filter(x=>norm(x.series)===key);
  const have=new Set(same.filter(x=>!x.wish).map(x=>parseInt(x.seriesNo)).filter(Boolean)),wish=new Set(same.filter(x=>x.wish).map(x=>parseInt(x.seriesNo)).filter(Boolean));
  const total=Math.max(...same.map(x=>parseInt(x.seriesTotal)||0),0),maxNo=Math.max(...have,...wish,0),N=total||maxNo;
  let parts='',missing=[];
  for(let i=1;i<=N;i++){const h=have.has(i),w=wish.has(i);if(!h)missing.push(i);parts+=`<span class="part${h?' have':w?' wish':''}" title="Part ${i}${h?': you own it':w?': on your wishlist':': missing'}">${i}</span>`}
  return `<div class="box"><h3${ta(b.series)}>${esc(b.series)}</h3><p class="muted">${b.seriesNo?`This is part ${esc(b.seriesNo)}${total?' of '+total:''}. `:''}${N?(missing.length?`Missing: part${missing.length>1?'s':''} ${missing.join(', ')}${total?'':' (as far as the numbers you’ve entered go)'}.`:'You have every part.'):'Add part numbers to see which ones are missing.'}</p>${N?`<div class="parts" aria-label="Parts: filled ones you own, outlined orange ones are on your wishlist">${parts}</div>`:''}</div>`;
}
function copiesBox(b){
  const others=S.books.filter(x=>x.id!==b.id&&!x.wish&&((toIsbn13(x.isbn)&&toIsbn13(x.isbn)===toIsbn13(b.isbn))||(similarTitle(x.title,b.title)&&similarAuthor(x.author,b.author))));
  if(!others.length)return '';
  return `<div class="box"><h3>Other copies and editions</h3>${others.map(x=>`<div style="display:flex;flex-direction:column;gap:2px">${miniBook(x)}<span class="muted" style="padding-left:64px">${esc(x.edition||'No edition note')}${x.location?' · '+esc(x.location):''}</span></div>`).join('')}</div>`;
}
function lendBox(b){
  if(b.wish)return '';
  if(!b.loan)return `<div class="sec-row"><h3 style="font-family:var(--f-body);font-size:16px;font-weight:600">Not lent out</h3><button class="btn ghost small" data-act="lend">Lend this book</button></div>`;
  const d=daysSince(b.loan.on),od=d>30;
  return `<div class="box${od?' warn':''}"><h3>${od?'Overdue: ':''}Lent to ${esc(b.loan.to)}</h3><p class="muted">Since ${fmtDate(b.loan.on)} · ${plural(d,'day')}${od?' (more than 30)':''}</p><div class="actions"><button class="btn primary small" data-act="returned">Mark as returned</button><button class="btn ghost small" data-act="lend">Edit</button></div></div>`;
}
function viewDetail(){
  const b=S.books.find(x=>x.id===S.current);if(!b)return '';
  const fact=(k,v,w)=>`<div class="fact${w?' wide':''}"><dt>${k}</dt><dd>${v||'<span style="color:var(--muted)">—</span>'}</dd></div>`;
  const rank=b.priority?prioList().findIndex(x=>x.id===b.id)+1:0;
  const ps=passagesOf(b.id);
  const top=`<div class="d-top">${cover(b)}<div class="info">${b.wish?'<span class="chip warn">On your wishlist</span>':''}<h1 class="d-title"${ta(b.title)}>${esc(b.title)}</h1><div class="d-author"${ta(b.author)}>${esc(b.author||'Unknown author')}</div>${b.wish?'':stars(b.rating)}
    ${b.wish?`<button class="btn primary small" data-act="bought" data-id="${esc(b.id)}" style="margin-top:6px">I bought it</button>`:`<button class="ptoggle" data-act="prio" data-id="${esc(b.id)}" aria-pressed="${!!b.priority}">${b.priority?ICON_FLAG_ON:ICON_FLAG}${b.priority?`Priority Reading · #${rank}`:'Add to Priority Reading'}</button>`}</div></div>`;
  const facts=`<dl class="facts">
      ${b.wish?'':fact('Location',esc(b.location),true)}
      ${b.wish?'':fact('Status',STATUS_LABEL[statusOf(b)])}${b.wish?'':fact('Finished reading',fmtDate(b.finishedOn))}
      ${fact('Genre',esc(b.genre))}${fact('Language',b.language==='Tamil'?'<span lang="ta">தமிழ்</span> Tamil':esc(b.language))}
      ${b.isbn?fact('ISBN',esc(b.isbn)):''}${fact('Added',fmtDate(b.addedAt))}
      ${b.edition?fact('Edition / copy',esc(b.edition),true):''}
    </dl>`;
  const passages=b.wish?'':`<section class="passages"><div class="sec-row"><h3>My passages${ps.length?` <span style="font-family:var(--f-body);font-size:15px;color:var(--muted)">${ps.length}</span>`:''}</h3><button class="btn ghost small" data-act="addpass">Add passage</button></div>
    ${ps.length?ps.map(p=>`<div class="quote"><blockquote${ta(p.text)}>${esc(p.text)}</blockquote><div class="qm">${[p.page?'p. '+esc(p.page):'',p.chapter?esc(p.chapter):''].filter(Boolean).join(' · ')}<span class="sp"></span><button class="linkish" data-act="editpass" data-id="${esc(p.id)}">Edit</button></div></div>`).join(''):`<p class="none">Save quotes you like. Type them, or photograph the page and the text is read for you.</p>`}</section>`;
  return `<div class="bar">${backBtn(S.back==='wishlist'?'Wishlist':S.back==='passages'?'Passages':'Library')}</div>
  <article class="detail">${top}${facts}${lendBox(b)}${seriesBox(b)}${copiesBox(b)}
    <section class="notes"><h3>${b.wish?'Notes':'My comments'}</h3>${b.comments?`<div class="body"${ta(b.comments)}>${esc(b.comments)}</div>`:`<p class="none">No ${b.wish?'notes':'comments'} yet.</p>`}</section>
    ${passages}
    <div class="actions"><button class="btn ghost" data-act="edit">Edit</button><button class="btn danger" data-act="askdel">Delete</button></div>
  </article>`;
}

/* ================= form ================= */
function blankForm(wish){return {id:null,wish:!!wish,title:'',author:'',genre:'',language:'English',isbn:'',location:'',rating:0,finishedOn:'',comments:'',priority:false,status:'want',series:'',seriesNo:'',seriesTotal:'',edition:'',dupOk:false,coverPath:'',coverUrl:'',coverRemote:'',coverBlob:null,coverPreview:'',coverRemoved:false}}
function formCoverSrc(){const f=S.form;if(f.coverPreview)return f.coverPreview;if(f.coverRemoved)return '';if(f.coverRemote)return f.coverRemote;return coverSrc(f)}
function viewForm(){
  const f=S.form,editing=!!f.id,w=f.wish;
  const uniq=field=>[...new Set(S.books.map(b=>b[field]).filter(Boolean))];
  const dl=(id,vals)=>`<datalist id="${id}">${vals.map(g=>`<option value="${esc(g)}">`).join('')}</datalist>`;
  const hasCover=!!formCoverSrc();
  return `<div class="bar">${backBtn('Cancel')}<h2 style="font-size:20px">${editing?(w?'Edit wishlist book':'Edit book'):(w?'Add to wishlist':'New book')}</h2><span style="width:70px"></span></div>
  ${editing?'':`<div class="opts two-up" role="radiogroup" aria-label="Add to" style="margin-bottom:16px"><label><input type="radio" name="dest" value="lib"${w?'':' checked'}><span>My library</span></label><label><input type="radio" name="dest" value="wish"${w?' checked':''}><span>Wishlist</span></label></div>`}
  <section class="scan" aria-label="Fill in from the book">
    <div class="scan-btns">
      <input type="file" accept="image/*" capture="environment" id="scanIsbn" class="vh" tabindex="-1" aria-hidden="true"><input type="file" accept="image/*" id="scanIsbnG" class="vh" tabindex="-1" aria-hidden="true">
      <button type="button" class="btn primary" id="isbnBtn" data-act="scanisbn">${ICON_BARCODE}Scan ISBN</button>
      <input type="file" accept="image/*" capture="environment" id="scanCover" class="vh" tabindex="-1" aria-hidden="true"><input type="file" accept="image/*" id="scanCoverG" class="vh" tabindex="-1" aria-hidden="true">
      <button type="button" class="btn ghost" id="coverBtn" data-act="pickfile" data-for="scanCover"${SC.images?'':' hidden'}>${ICON_CAMERA}Read cover</button>
    </div>
    <div class="gallery-row">From a saved photo: <button type="button" class="linkish" data-act="pickfile" data-for="scanIsbnG">barcode</button><span id="coverG"${SC.images?'':' hidden'}> · <button type="button" class="linkish" data-act="pickfile" data-for="scanCoverG">front cover</button></span></div>
    ${IN_APP?`<div class="app-note">The Claude Android app can’t open the camera or gallery. Open this library in Chrome to scan books; everything you add appears here too.</div>`:''}
    <div class="scan-status" id="scanStatus" role="status">Scan the barcode, or type the ISBN below and tap Look up. Details and the cover come from Open Library and Google Books.${SC.images?' For books they don’t have (common for Tamil), “Read cover” reads the title and author from a photo of the front.':' Add a Claude API key in Settings to read covers of books they don’t have.'}</div>
  </section>
  <div id="dupe" aria-live="polite"></div>
  <form id="bookForm" novalidate>
    <div class="field"><span class="lbl">Cover</span><div class="cover-edit"><div id="coverPrev">${cover(f,formCoverSrc())}</div><div class="btns">
      <button type="button" class="btn ghost" data-act="pickfile" data-for="coverCam">${ICON_CAMERA}Take photo</button>
      <button type="button" class="btn ghost" data-act="pickfile" data-for="coverGal">${ICON_IMAGE}From gallery</button>
      <button type="button" class="linkish" data-act="recrop" id="recrop"${f.coverBlob&&SC.lastPhoto?'':' hidden'}>Crop or rotate again</button>
      <button type="button" class="linkish" data-act="rmcover" id="rmcover" style="color:var(--danger)"${hasCover?'':' hidden'}>Remove cover</button></div></div></div>
    <div class="field"><label for="f-title">Title</label><input class="in" id="f-title" name="title" value="${esc(f.title)}" autocomplete="off" required><div class="err" id="titleErr" hidden>Add a title to save this book.</div></div>
    <div class="field"><label for="f-author">Author</label><input class="in" id="f-author" name="author" value="${esc(f.author)}" autocomplete="off" list="authors">${dl('authors',uniq('author'))}</div>
    <div class="field"><span class="lbl">Language</span><div class="opts" role="radiogroup" aria-label="Language">${LANGS.map(l=>`<label><input type="radio" name="language" value="${l}"${f.language===l?' checked':''}><span>${l==='Tamil'?'<span lang="ta">தமிழ்</span>':l}</span></label>`).join('')}</div></div>
    <div class="field"><label for="f-isbn">ISBN <span class="hint">optional, 10 or 13 digits</span></label><div class="isbn-row"><input class="in" id="f-isbn" name="isbn" inputmode="numeric" value="${esc(f.isbn)}" autocomplete="off"><button type="button" class="btn ghost" data-act="lookup" id="lookupBtn">Look up</button></div><span class="hint" id="isbnHint"></span></div>
    <div class="field"><label for="f-genre">Genre</label><input class="in" id="f-genre" name="genre" list="genres" value="${esc(f.genre)}" autocomplete="off">${dl('genres',uniq('genre'))}</div>
    <div class="wonly"${w?' hidden':''}>
      <div class="field" style="margin-bottom:18px"><span class="lbl">Reading status</span><div class="opts four" role="radiogroup" aria-label="Reading status">${STATUS.map(([v,t])=>`<label><input type="radio" name="status" value="${v}"${(f.status||'want')===v?' checked':''}><span>${t}</span></label>`).join('')}</div></div>
      <label class="switch-row" for="f-prio" style="margin-bottom:18px"><span class="txt"><b>${ICON_FLAG_ON}Priority Reading</b><span class="hint">Show it at the top of the home screen</span></span><span class="switch"><input type="checkbox" role="switch" id="f-prio" name="priority"${f.priority?' checked':''}><span></span></span></label>
      <div class="field" style="margin-bottom:18px"><label for="f-loc">Location at home <span class="hint">e.g. Hall shelf 2, row 3</span></label><input class="in" id="f-loc" name="location" list="locs" value="${esc(f.location)}" autocomplete="off">${dl('locs',uniq('location'))}</div>
      <div class="field" style="margin-bottom:18px"><span class="lbl">Rating</span><div class="rate"><div class="rate-input" id="rateInput">${rateStars(f.rating)}</div><span class="rate-val" id="rateVal">${f.rating?f.rating+' / 5':'Not rated'}</span><button type="button" class="linkish" data-act="clearrate">Clear</button></div></div>
      <div class="field"><label for="f-done">Date finished reading</label><input class="in" type="date" id="f-done" name="finishedOn" value="${esc(f.finishedOn)}"><div id="doneAsk"></div></div>
    </div>
    <div class="field"><span class="lbl">Series <span class="hint">optional</span></span><div class="three"><input class="in" id="f-series" name="series" list="seriesl" value="${esc(f.series)}" placeholder="Series name" aria-label="Series name" autocomplete="off">${dl('seriesl',uniq('series'))}<input class="in" id="f-sno" name="seriesNo" inputmode="numeric" value="${esc(f.seriesNo)}" placeholder="Part" aria-label="Part number"><input class="in" id="f-stot" name="seriesTotal" inputmode="numeric" value="${esc(f.seriesTotal)}" placeholder="of" aria-label="Total parts"></div></div>
    <div class="field wonly"${w?' hidden':''}><label for="f-ed">Edition or copy note <span class="hint">e.g. Hardcover 2012, second copy</span></label><input class="in" id="f-ed" name="edition" value="${esc(f.edition)}" autocomplete="off"></div>
    <div class="field"><label for="f-notes" id="notesLbl">${w?'Notes':'My comments'}</label><textarea class="in" id="f-notes" name="comments"${ta(f.comments)}>${esc(f.comments)}</textarea></div>
    <div class="form-actions"><button type="submit" class="btn primary" id="saveBtn">${editing?'Save changes':(w?'Add to wishlist':'Add to library')}</button></div>
  </form>`;
}
function rateStars(v){return [1,2,3,4,5].map(n=>`<span class="sb ${v>=n?'full':v>=n-.5?'half':''}"><button type="button" data-act="rate" data-v="${n-.5}" aria-label="${n-.5} stars"></button><button type="button" data-act="rate" data-v="${n}" aria-label="${n} star${n>1?'s':''}"></button></span>`).join('')}
function readForm(){
  const fd=new FormData(document.getElementById('bookForm'));
  ['title','author','genre','location','finishedOn','isbn','comments','series','seriesNo','seriesTotal','edition'].forEach(k=>S.form[k]=(fd.get(k)||'').toString());
  S.form.language=(fd.get('language')||'English').toString();
  S.form.status=(fd.get('status')||'want').toString();
  S.form.priority=!!document.getElementById('f-prio').checked;
}
function isbnHint(){
  const el=document.getElementById('isbnHint'),v=(document.getElementById('f-isbn')||{}).value||'';if(!el)return;
  const p=isbnProblem(v),ok=!p&&v.trim();
  el.className='hint'+(ok?' ok':p&&v.replace(/[^0-9X]/gi,'').length>=10?' bad':'');
  el.textContent=ok?`✓ Valid ISBN${cleanIsbn(v).length===10?' (ISBN-13: '+toIsbn13(v)+')':''}`:p;
}
function checkDupe(reveal){
  const el=document.getElementById('dupe');if(!el)return;
  const g=id=>(document.getElementById(id)||{}).value||'';
  const d=findDupes({title:g('f-title'),author:g('f-author'),isbn:g('f-isbn')},S.form.id);
  S.form._dupes=d;
  const sig=d.map(x=>x.b.id).join(',');
  if(!d.length){el.innerHTML='';S.form._dsig='';return}
  el.innerHTML=`<div class="dupe" role="status"><b>${d.some(x=>!x.b.wish)?'You may already own this':'This is on your wishlist'}</b>${d.slice(0,4).map(({b,why})=>`<div class="d"><span>${b.wish?'Wishlist':'Owned'}${why==='isbn'?' (same ISBN)':''}: <strong${ta(b.title)}>${esc(b.title)}</strong>${b.author?' by '+esc(b.author):''}${!b.wish?(b.location?` · <b>${esc(b.location)}</b>`:' · location not set'):''}${b.edition?' · '+esc(b.edition):''}</span>${b.wish&&!S.form.wish?`<button type="button" class="btn ghost" data-act="bought" data-id="${esc(b.id)}">Mark bought</button>`:`<button type="button" class="btn ghost" data-act="peek" data-id="${esc(b.id)}">View</button>`}</div>`).join('')}</div>`;
  if(reveal&&sig!==S.form._dsig){el.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'})}
  S.form._dsig=sig;
}
function askFinished(){
  const box=document.getElementById('doneAsk');if(!box)return;
  const done=document.getElementById('f-done').value,prio=document.getElementById('f-prio').checked;
  box.innerHTML=done&&prio?`<div class="ask" role="status" style="margin-top:8px"><span>Finished it. Remove this book from Priority Reading?</span><div class="actions"><button type="button" class="btn primary" data-act="doneremove">Remove</button><button type="button" class="btn ghost" data-act="donekeep">Keep it</button></div></div>`:'';
}
async function submit(e,force){
  if(e)e.preventDefault();readForm();const f=S.form;
  const title=f.title.trim();
  if(!title){document.getElementById('titleErr').hidden=false;document.getElementById('f-title').focus();return}
  const owners=(f._dupes||[]).filter(x=>!x.b.wish);
  if(!f.wish&&owners.length&&!force&&!(f.id&&f.dupOk))return confirmDup(owners);
  const old=f.id?S.books.find(b=>b.id===f.id):null;
  const priorityOrder=!f.wish&&f.priority?(old&&old.priority&&old.priorityOrder!=null?old.priorityOrder:nextOrder()):null;
  const data={title,author:f.author.trim(),genre:f.genre.trim(),language:f.language,isbn:f.isbn.trim(),
    wish:!!f.wish,location:f.wish?'':f.location.trim(),rating:f.wish?0:(Number(f.rating)||0),finishedOn:f.wish?'':(f.finishedOn||''),
    status:f.wish?'want':f.status,comments:f.comments,priority:!f.wish&&!!f.priority,priorityOrder,
    series:f.series.trim(),seriesNo:f.seriesNo.trim(),seriesTotal:f.seriesTotal.trim(),edition:f.edition.trim(),
    dupOk:!!(f.dupOk||force),loan:old&&old.loan||null,
    coverPath:old&&old.coverPath||'',coverUrl:old&&old.coverUrl||'',
    addedAt:old&&old.addedAt||Date.now()};
  if(f.coverRemoved){data.coverPath='';data.coverUrl=''}
  if(f.coverRemote){data.coverPath='';data.coverUrl=f.coverRemote}
  const btn=document.getElementById('saveBtn');btn.disabled=true;btn.textContent='Saving…';
  try{
    const oldPath=old&&old.coverPath,bid=f.id||newId();
    if(f.coverBlob){btn.textContent='Saving cover…';Object.assign(data,await uploadCover(f.coverBlob,bid))}
    const id=await saveBook(data,bid);
    if(oldPath&&oldPath!==data.coverPath)dropAsset(oldPath);
    S.form=null;S.current=id;S.view='detail';render();window.scrollTo(0,0);
    toast(old?'Changes saved':(data.wish?'Added to your wishlist':'Added to your library'));
  }catch(err){btn.disabled=false;btn.textContent=f.id?'Save changes':(f.wish?'Add to wishlist':'Add to library');
    toast(err&&err.code==='quota_exceeded'?'Your library is full. Delete a few books to add more.':err&&err.code==='cover_upload'?(navigator.onLine?'The cover couldn’t be uploaded. Try again, or remove the cover to save without it.':'You’re offline, so the cover can’t upload. Remove it to save now, and add it later.'):'Couldn’t save. Try again.')}
}
function confirmDup(owners){
  layer.innerHTML=`<div class="scrim" data-act="closesheet"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="dh"><h2 id="dh">You already own this</h2>
    ${owners.slice(0,3).map(({b})=>`<div>${miniBook(b,'peek')}<p style="padding-left:64px;font-size:15px">${b.location?`It’s in <b>${esc(b.location)}</b>.`:'Location not set.'}${b.edition?' '+esc(b.edition)+'.':''}</p></div>`).join('')}
    <p>Save this as another copy or edition? Add a note like “Hardcover” or “Second copy” so you can tell them apart.</p>
    <input class="in" id="dupEd" placeholder="Edition or copy note" value="${esc(S.form.edition)}" aria-label="Edition or copy note">
    <div class="actions"><button class="btn ghost" data-act="closesheet">Don’t save</button><button class="btn primary" data-act="dupsave">Save as another copy</button></div></div></div>`;
}

/* ================= form: scanning & lookup ================= */
function status(html,busy){const el=document.getElementById('scanStatus');if(!el)return;el.innerHTML=html;el.classList.toggle('busy',!!busy)}
function olLink(isbn){return ` <a href="https://openlibrary.org/isbn/${isbn}" target="_blank" rel="noopener">Check on Open Library</a>`}
const FIELD_IDS={title:'f-title',author:'f-author',genre:'f-genre',series:'f-series',seriesNo:'f-sno',seriesTotal:'f-stot'};
function applyFound(r){
  const done=[];
  for(const k of Object.keys(FIELD_IDS)){
    let v=r&&r[k]!=null?String(r[k]).trim():'';const el=document.getElementById(FIELD_IDS[k]);
    if(!v||v==='null'||!el)continue;
    if(!el.value.trim()||SC.filled.has(k)){el.value=v;el.classList.add('filled');SC.filled.add(k);if(k==='title'||k==='author'||k==='genre')done.push(k)}
  }
  if(r&&r.series&&!done.includes('series')&&SC.filled.has('series'))done.push('series');
  if(r&&LANGS.includes(r.language)){const rb=document.querySelector(`input[name="language"][value="${r.language}"]`);if(rb&&!rb.checked&&(SC.filled.has('language')||!S.form.id)){rb.checked=true;SC.filled.add('language');done.push('language')}}
  checkDupe(true);if(done.includes('title'))document.getElementById('titleErr').hidden=true;
  return done;
}
function setScanDisabled(on){['isbnBtn','coverBtn','lookupBtn'].forEach(id=>{const el=document.getElementById(id);if(el)el.disabled=on})}
async function lookup(isbn,photo,kind){
  if(!SC.fn||SC.busy)return;
  SC.busy=true;setScanDisabled(true);
  status(kind==='cover'?'Reading the cover…':`ISBN <strong>${isbn}</strong>. Looking up the book…`,true);
  try{
    const r=await claudeIdentify(isbn,photo,kind);
    if(!S.form)return;
    if(!photo&&r.title&&r.sure===false){
      SC.sug=r;
      status(`Possible match for <strong>${isbn}</strong>: <strong>${esc(r.title)}</strong>${r.author?' by '+esc(r.author):''}. Not certain, so check it first. <button type="button" class="linkish" data-act="usesug">Use this</button>${olLink(isbn)}`);
      return;
    }
    const done=applyFound(r);
    let extra='';
    if(kind==='cover'&&photo&&!formCoverSrc()){const blob=await quickCover(photo);if(blob){setFormCover(blob,photo);extra=' Your photo is now the cover; <button type="button" class="linkish" data-act="recrop">crop or rotate it</button>.'}}
    if(done.length)status(`Filled in ${done.join(', ')}. Please check before saving.${extra}${isbn?olLink(isbn):''}`);
    else status(`${isbn?`ISBN <strong>${isbn}</strong> is kept below, but `:''}I couldn’t identify this book${kind==='cover'?' from that photo':''}. That’s common for Tamil books, so please type in the details.${SC.images&&kind!=='cover'?' A photo of the front cover usually works.':''}${extra}${isbn?olLink(isbn):''}`);
  }catch(e){status(claudeErr(e)+(isbn?olLink(isbn):''));if(!SC.fn){const l=document.getElementById('lookupBtn');if(l)l.hidden=true}}
  finally{SC.busy=false;setScanDisabled(false)}
}
async function lookupIsbn(isbn){
  if(SC.busy)return;
  const el=document.getElementById('f-isbn');if(el){el.value=isbn;el.classList.add('filled');isbnHint();checkDupe(true)}
  if(!navigator.onLine){status(`ISBN <strong>${isbn}</strong> added. You’re offline, so fill in the rest yourself.`);return}
  SC.busy=true;setScanDisabled(true);status(`ISBN <strong>${isbn}</strong>. Searching Open Library and Google Books…`,true);
  let info=null;try{info=await fetchBookInfo(isbn)}catch(e){}
  SC.busy=false;setScanDisabled(false);
  if(!S.form)return;
  if(info&&info.title){
    const done=applyFound(info);let coverNote='';
    if(info.cover&&!formCoverSrc()){
      status(`Found on ${info.src}. Getting the cover…`,true);
      let blob=await fetchCoverBlob(info.cover);if(!blob&&info.coverAlt&&info.coverAlt!==info.cover)blob=await fetchCoverBlob(info.coverAlt);
      if(!S.form)return;
      if(blob){setFormCover(blob,blob);coverNote=' The cover was added; you can replace it.'}
      else{S.form.coverRemote=info.cover;S.form.coverRemoved=false;showFormCover();coverNote=' The cover was added; you can replace it.'}
    }
    status(`Found on ${info.src}. ${done.length?'Filled in '+done.join(', ')+'.':'Nothing new to fill in.'} Please check before saving.${coverNote}${olLink(isbn)}`);
    return;
  }
  if(SC.fn){status(`Not in Open Library or Google Books. Asking Claude…`,true);return lookup(isbn,null,'isbn')}
  status(`ISBN <strong>${isbn}</strong> isn’t in Open Library or Google Books. That’s common for Tamil books, so please type in the details${SC.images?' or tap “Read cover”':''}.${olLink(isbn)}`);
}
function showFormCover(){const f=S.form,cp=document.getElementById('coverPrev');if(!cp)return;cp.innerHTML=cover({title:document.getElementById('f-title').value,author:document.getElementById('f-author').value},formCoverSrc());const rm=document.getElementById('rmcover');if(rm)rm.hidden=!formCoverSrc()}
async function onScanIsbn(file){
  status('Reading the barcode…',true);
  let isbn=null;try{isbn=await decodeIsbn(file)}catch(e){}
  if(!isbn){status('No ISBN barcode found in that photo. Hold the phone closer so the barcode fills most of the frame, in good light, and try again.');return}
  return lookupIsbn(isbn);
}
function setFormCover(blob,srcFile){
  const f=S.form;if(f.coverPreview)URL.revokeObjectURL(f.coverPreview);
  f.coverBlob=blob;f.coverPreview=URL.createObjectURL(blob);f.coverRemoved=false;f.coverRemote='';if(srcFile)SC.lastPhoto=srcFile;
  const t=document.getElementById('f-title'),a=document.getElementById('f-author');
  document.getElementById('coverPrev').innerHTML=cover({title:t?t.value:f.title,author:a?a.value:f.author},f.coverPreview);
  document.getElementById('rmcover').hidden=false;document.getElementById('recrop').hidden=!SC.lastPhoto;
}
async function pickCover(file){const blob=await openCrop(file);if(blob&&S.form)setFormCover(blob,file)}

/* ================= priority toggle & reorder ================= */
async function togglePrio(id){
  const b=S.books.find(x=>x.id===id);if(!b)return;
  const on=!b.priority;
  try{await patchBook(id,{priority:on,priorityOrder:on?nextOrder():null});toast(on?'Added to Priority Reading':'Removed from Priority Reading')}
  catch(e){toast('Couldn’t update. Try again.')}
  refresh();
}
function renderReorder(){
  const list=layer.querySelector('.rlist');if(!list)return;
  list.innerHTML=prioList().map((b,i)=>`<li class="rrow" data-id="${esc(b.id)}"><span class="rnum">${i+1}</span>${cover(b)}<span class="rt"><b${ta(b.title)}>${esc(b.title)}</b><span${ta(b.author)}>${esc(b.author||'')}</span></span><button type="button" class="handle" aria-label="Move ${esc(b.title)}. Use arrow keys or drag." data-idx="${i}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 8h14M5 12h14M5 16h14"/></svg></button></li>`).join('');
}
function openReorder(){
  layer.innerHTML=`<div class="scrim" data-act="closesheet"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="rh"><h2 id="rh">Reorder Priority Reading</h2><p>Drag a book by its handle. The top one is your next read.</p><ol class="rlist"></ol><div class="actions"><button class="btn primary" data-act="closesheet">Done</button></div></div></div>`;
  renderReorder();
}
async function moveTo(from,to){
  const arr=prioList();if(to<0||to>=arr.length||from===to)return;
  const [m]=arr.splice(from,1);arr.splice(to,0,m);
  const prev=arr[to-1],next=arr[to+1];
  let val;
  if(!prev)val=(next.priorityOrder??1)-1;else if(!next)val=(prev.priorityOrder??0)+1;else val=((prev.priorityOrder??0)+(next.priorityOrder??0))/2;
  const clash=(prev&&prev.priorityOrder===val)||(next&&next.priorityOrder===val)||!isFinite(val);
  try{
    if(clash){for(let i=0;i<arr.length;i++){if(arr[i].priorityOrder!==i+1)await patchBook(arr[i].id,{priorityOrder:i+1})}}
    else await patchBook(m.id,{priorityOrder:val});
  }catch(e){toast('Couldn’t save the new order. Try again.')}
  renderReorder();refresh();
}
layer.addEventListener('pointerdown',e=>{
  const h=e.target.closest('.handle');if(!h)return;
  e.preventDefault();const li=h.closest('.rrow'),rows=[...layer.querySelectorAll('.rrow')];
  drag={li,rows,from:+h.dataset.idx,to:+h.dataset.idx,startY:e.clientY,rowH:li.offsetHeight+8,pid:e.pointerId};
  try{h.setPointerCapture(e.pointerId)}catch(_){}
  li.classList.add('dragging');
});
layer.addEventListener('pointermove',e=>{
  if(!drag||e.pointerId!==drag.pid)return;
  const dy=e.clientY-drag.startY,n=drag.rows.length;
  drag.li.style.transform=`translateY(${dy}px)`;
  const to=Math.max(0,Math.min(n-1,drag.from+Math.round(dy/drag.rowH)));
  if(to!==drag.to){drag.to=to;drag.rows.forEach((r,j)=>{if(r===drag.li)return;let s=0;if(drag.from<to&&j>drag.from&&j<=to)s=-drag.rowH;else if(drag.from>to&&j>=to&&j<drag.from)s=drag.rowH;r.style.transform=s?`translateY(${s}px)`:''})}
});
function endDrag(e){
  if(!drag||e.pointerId!==drag.pid)return;
  const {from,to,rows}=drag;rows.forEach(r=>{r.style.transform='';r.classList.remove('dragging')});drag=null;
  if(from!==to)moveTo(from,to);
}
layer.addEventListener('pointerup',endDrag);layer.addEventListener('pointercancel',endDrag);
layer.addEventListener('keydown',async e=>{
  const h=e.target.closest&&e.target.closest('.handle');if(!h)return;
  const i=+h.dataset.idx;
  if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();const to=i+(e.key==='ArrowUp'?-1:1);await moveTo(i,to);const all=layer.querySelectorAll('.handle');const nh=all[Math.max(0,Math.min(to,all.length-1))];if(nh)nh.focus()}
});

/* ================= Do I own this? ================= */
function ownCheck({isbn,title,author}){
  const i13=toIsbn13(isbn);
  const byIsbn=i13?S.books.filter(b=>toIsbn13(b.isbn)===i13):[];
  let byTitle=[];
  if(title&&title.trim()){
    const ex=new Set(byIsbn.map(b=>b.id));
    byTitle=S.books.filter(b=>!ex.has(b.id)&&similarTitle(title,b.title)&&(author?similarAuthor(author,b.author):true));
    if(!byTitle.length&&!author){const sc=S.books.map(b=>[b,scoreBook({...b,comments:'',location:'',genre:''},title)]).filter(x=>x[1]>=6).sort((a,b)=>b[1]-a[1]);byTitle=sc.slice(0,3).map(x=>x[0])}
  }
  return {owned:[...byIsbn,...byTitle].filter(b=>!b.wish),wish:[...byIsbn,...byTitle].filter(b=>b.wish),exact:byIsbn.some(b=>!b.wish)};
}
function openOwn(){
  S.own={isbn:'',title:'',author:''};
  layer.innerHTML=`<div class="scrim" data-act="closesheet"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="oh"><h2 id="oh">Do I own this?</h2>
    <div id="ownOut" role="status"><div class="scan-status">Scan the barcode, or type the ISBN or title.</div></div>
    <div class="actions"><button class="btn primary small" data-act="ownagain">${ICON_BARCODE}Scan</button><button class="btn ghost small" data-act="owngal">${ICON_IMAGE}Saved photo</button></div>
    <form id="ownForm" class="isbn-row" style="flex-direction:row"><input class="in" id="ownQ" placeholder="Or type an ISBN or title" autocomplete="off" aria-label="ISBN or title"><button class="btn ghost" type="submit">Check</button></form>
    <button class="btn ghost" data-act="closesheet">Close</button></div></div>`;
  ownScan();
}
function ownScan(){openScanner({title:'Do I own this?',hint:'Point the camera at the barcode on the back cover.',fallbackInput:'ownCam',onIsbn:isbn=>ownFromIsbn(isbn)})}
async function ownFromIsbn(isbn){
  const r=ownCheck({isbn});if(r.owned.length||r.wish.length){ownAnswer({isbn});return}
  if(!navigator.onLine){ownAnswer({isbn});return}
  ownMsg('Not found by ISBN. Checking the title online…',true);
  let info=null;try{info=await fetchBookInfo(isbn)}catch(e){}
  if(info&&info.title){ownAnswer({isbn,title:info.title,author:info.author,genre:info.genre,language:info.language,cover:info.cover});return}
  if(SC.fn){try{const c=await claudeIdentify(isbn,null,'isbn');if(c.title){ownAnswer({isbn,title:c.title,author:c.author||'',genre:c.genre||'',language:c.language||'',series:c.series||'',seriesNo:c.seriesNo||'',seriesTotal:c.seriesTotal||''});return}}catch(e){}}
  ownAnswer({isbn});
}
function ownMsg(html,busy){const o=document.getElementById('ownOut');if(!o)return;o.className=busy?'scan-status busy':'';o.innerHTML=busy?html:`<div class="scan-status">${html}</div>`}
function ownAnswer(q){
  const r=ownCheck(q),o=document.getElementById('ownOut');if(!o)return;
  const label=q.title?`<strong${ta(q.title)}>${esc(q.title)}</strong>${q.author?' by '+esc(q.author):''}`:q.isbn?`ISBN ${esc(q.isbn)}`:'';
  o.className='';
  if(r.owned.length){
    const b=r.owned[0],more=r.owned.length-1;
    o.innerHTML=`<div class="answer ${r.exact||similarTitle(q.title||'',b.title)?'yes':'maybe'}"><span class="big">${r.exact?'Yes, you own it':'Yes, you seem to own it'}</span><span class="where">${b.location?`It’s in ${esc(b.location)}`:'No location saved for it'}${b.loan?` · lent to ${esc(b.loan.to)}`:''}</span>${miniBook(b)}${more?`<p>You have ${plural(more,'more copy','more copies')}${r.owned.slice(1).map(x=>x.location?' ('+esc(x.location)+')':'').join('')}.</p>`:''}${r.exact?'':'<p>Matched by title, so check the edition.</p>'}</div>`;
  }else if(r.wish.length){
    o.innerHTML=`<div class="answer maybe"><span class="big">No, but it’s on your wishlist</span>${miniBook(r.wish[0])}<div class="actions"><button class="btn primary small" data-act="bought" data-id="${esc(r.wish[0].id)}">I’m buying it</button></div></div>`;
  }else{
    S.own=q;
    o.innerHTML=`<div class="answer no"><span class="big">No, you don’t have it</span>${label?`<p>${label}</p>`:''}<div class="actions"><button class="btn ghost small" data-act="ownwish">Add to wishlist</button><button class="btn primary small" data-act="ownadd">Add to library</button></div></div>`;
  }
}
async function ownFromPhoto(file){
  ownMsg('Reading the barcode…',true);
  let isbn=null;try{isbn=await decodeIsbn(file)}catch(e){}
  if(isbn)return ownFromIsbn(isbn);
  if(!SC.fn){ownMsg('No barcode found in that photo. Try again closer, or type the ISBN or title.');return}
  ownMsg(isbn?'Not found by ISBN. Checking the title…':'No barcode found, so reading the title from the photo…',true);
  try{
    const r=await claudeIdentify(isbn,file,isbn?'back':'cover');
    if(!r.title&&!isbn){ownMsg('I couldn’t read a title from that photo. Try the barcode or the front cover, or type the title.');return}
    ownAnswer({isbn:isbn||'',title:r.title||'',author:r.author||'',genre:r.genre||'',language:r.language||'',series:r.series||'',seriesNo:r.seriesNo||'',seriesTotal:r.seriesTotal||''});
  }catch(e){if(isbn)ownAnswer({isbn});else ownMsg(claudeErr(e))}
}
function ownTyped(v){
  v=v.trim();if(!v)return;
  const isbn=cleanIsbn(v);
  if(/^[\d\sxX-]+$/.test(v)&&!isbn){ownMsg(isbnProblem(v)||'That ISBN doesn’t look right.');return}
  if(isbn)return ownFromIsbn(isbn);ownAnswer({title:v});
}

/* ================= pick my next read ================= */
function openPick(){S.pick={genre:'',lang:'',i:0,seen:[]};renderPick()}
function pickPool(){
  const p=S.pick,ok=b=>(!p.genre||norm(b.genre)===p.genre)&&(!p.lang||(LANGS.includes(b.language)?b.language:'Other')===p.lang);
  const pr=prioList().filter(b=>ok(b)&&!isRead(b));
  if(pr.length)return {kind:'priority',list:pr};
  return {kind:'random',list:owned().filter(b=>ok(b)&&!['finished','abandoned'].includes(statusOf(b))&&!b.loan)};
}
function renderPick(){
  const p=S.pick,pool=pickPool();let b=null,why='';
  if(pool.list.length){
    if(pool.kind==='priority'){b=pool.list[p.i%pool.list.length];const rank=prioList().findIndex(x=>x.id===b.id)+1;why=`#${rank} on your Priority Reading list`}
    else{if(p.cur&&pool.list.some(x=>x.id===p.cur)&&!p.reroll)b=pool.list.find(x=>x.id===p.cur);else{const left=pool.list.filter(x=>!p.seen.includes(x.id));const src=left.length?left:pool.list;b=src[Math.floor(Math.random()*src.length)]}p.reroll=false;why=`Picked at random from ${plural(pool.list.length,'unread book')}`}
    p.cur=b.id;if(!p.seen.includes(b.id))p.seen.push(b.id);
  }
  const genres=[...new Map(owned().filter(x=>x.genre).map(x=>[norm(x.genre),x.genre])).entries()].sort((a,b)=>cmpText(a[1],b[1]));
  layer.innerHTML=`<div class="scrim" data-act="closesheet"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="pkh"><h2 id="pkh">Your next read</h2>
    <div class="two"><label class="field"><span class="lbl">Genre</span><select class="sel" id="pkGenre"><option value="">Any genre</option>${genres.map(([k,v])=>`<option value="${esc(k)}"${p.genre===k?' selected':''}>${esc(v)}</option>`).join('')}</select></label>
    <label class="field"><span class="lbl">Language</span><select class="sel" id="pkLang"><option value="">Any language</option>${LANGS.map(l=>`<option${p.lang===l?' selected':''}>${l}</option>`).join('')}</select></label></div>
    ${b?`<div class="pick-card">${cover(b)}<div class="pt"><span class="chip ${pool.kind==='priority'?'warn':''}" style="align-self:flex-start">${why}</span><h3${ta(b.title)}>${esc(b.title)}</h3><p${ta(b.author)}>${esc(b.author||'')}</p><p class="hint">${b.location?'In '+esc(b.location):'Location not set'}</p></div></div>
      <div class="actions"><button class="btn ghost" data-act="pickagain">${pool.kind==='priority'?'Next in list':'Pick another'}</button><button class="btn primary" data-act="open" data-id="${esc(b.id)}">Open book</button></div>`
      :`<p>No unread books match${p.genre||p.lang?' these filters':''}. ${p.genre||p.lang?'Try a different genre or language.':'Add books, or mark some as Want to read.'}</p>`}
  </div></div>`;
}

/* ================= lending ================= */
function openLend(){
  const b=S.books.find(x=>x.id===S.current);if(!b)return;
  const people=[...new Set(S.books.map(x=>x.loan&&x.loan.to).filter(Boolean))];
  layer.innerHTML=`<div class="scrim" data-act="closesheet"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="lh"><h2 id="lh">Lend “${esc(b.title)}”</h2>
    <form id="lendForm" style="gap:14px"><div class="field"><label for="l-to">Borrowed by</label><input class="in" id="l-to" list="lpeople" value="${esc(b.loan?b.loan.to:'')}" autocomplete="off" required><datalist id="lpeople">${people.map(p=>`<option value="${esc(p)}">`).join('')}</datalist></div>
    <div class="field"><label for="l-on">Date lent</label><input class="in" type="date" id="l-on" value="${esc(b.loan?b.loan.on:todayStr())}"></div>
    <p class="hint">It’s flagged as overdue after 30 days.</p>
    <div class="actions"><button type="button" class="btn ghost" data-act="closesheet">Cancel</button><button type="submit" class="btn primary">Save</button></div></form></div></div>`;
  setTimeout(()=>{const i=document.getElementById('l-to');if(i)i.focus()},50);
}

/* ================= passages ================= */
function openPassage(pid){
  const b=S.books.find(x=>x.id===S.current);const p=pid?S.passages.find(x=>x.id===pid):null;
  S.pform={id:pid||null,bookId:b.id};
  layer.innerHTML=`<div class="scrim" data-act="closesheet"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="pph"><h2 id="pph">${p?'Edit passage':'Save a passage'}</h2><p${ta(b.title)}>${esc(b.title)}</p>
    ${SC.images?'':'<p class="hint">Add a Claude API key in Settings to read text from page photos.</p>'}${SC.images?`<div class="actions"><button type="button" class="btn ghost small" data-act="pagecam">${ICON_CAMERA}Photograph page</button><button type="button" class="btn ghost small" data-act="pagegal">${ICON_IMAGE}Saved photo</button></div>`:''}
    <div id="ocrStatus" class="scan-status" role="status">${SC.images?'A photo of the page is read for you, in English or Tamil. Check the text before saving.':''}</div>
    <form id="passForm" style="gap:12px"><div class="field"><label for="p-text">Passage</label><textarea class="in" id="p-text" required${ta(p&&p.text)}>${esc(p?p.text:'')}</textarea></div>
    <div class="two"><div class="field"><label for="p-page">Page</label><input class="in" id="p-page" inputmode="numeric" value="${esc(p?p.page:'')}"></div><div class="field"><label for="p-ch">Chapter</label><input class="in" id="p-ch" value="${esc(p?p.chapter:'')}"></div></div>
    <div class="actions">${p?`<button type="button" class="btn danger" data-act="delpass">Delete</button>`:`<button type="button" class="btn ghost" data-act="closesheet">Cancel</button>`}<button type="submit" class="btn primary">Save</button></div></form></div></div>`;
}
async function ocrPage(file){
  const st=document.getElementById('ocrStatus');if(!st)return;
  st.className='scan-status busy';st.textContent='Reading the page…';
  try{
    const r=await claudeOCR(file);if(!document.getElementById('p-text'))return;
    const t=document.getElementById('p-text');
    if(r.text){t.value=t.value.trim()?t.value.trim()+'\n\n'+r.text:r.text;t.classList.add('filled');if(hasTamil(r.text))t.setAttribute('lang','ta')}
    if(r.page&&!document.getElementById('p-page').value)document.getElementById('p-page').value=r.page;
    if(r.chapter&&!document.getElementById('p-ch').value)document.getElementById('p-ch').value=r.chapter;
    st.className='scan-status';st.textContent=r.text?'Here’s the text from the photo. Correct anything that’s off, then save.':'No text could be read from that photo. Try a sharper, flatter photo.';
  }catch(e){st.className='scan-status';st.textContent=claudeErr(e)}
}
function viewPassages(){
  const n=S.passages.length,books=new Set(S.passages.map(p=>p.bookId)).size;
  const r=S.pres;let res='';
  if(r){
    if(r.loading)res=`<div class="scan-status busy" role="status">${esc(r.loading)}</div>`;
    else if(r.error)res=`<p class="err">${esc(r.error)}</p>`;
    else{
      if(r.matches&&r.matches.length)res+=`<h2 style="font-size:22px">Closest saved passages</h2><div class="passages">${r.matches.map(m=>{const p=S.passages.find(x=>x.id===m.id);if(!p)return '';const b=S.books.find(x=>x.id===p.bookId)||{title:'Unknown book'};
        return `<div class="quote"><button class="src" data-act="open" data-id="${esc(p.bookId)}"${ta(b.title)}>${esc(b.title)}${b.author?` <span style="font-weight:400;color:var(--muted)">· ${esc(b.author)}</span>`:''}</button><blockquote${ta(p.text)}>${esc(p.text)}</blockquote><div class="qm">${[p.page?'p. '+esc(p.page):'',p.chapter?esc(p.chapter):''].filter(Boolean).join(' · ')}</div>${m.why?`<p class="why">${esc(m.why)}</p>`:''}</div>`}).join('')}</div>`;
      if(r.guess){const g=r.guess;
        if(g.title){const m=ownCheck({title:g.title,author:g.author});const b=m.owned[0],w=m.wish[0];
          res+=`<div class="guess"><span class="eyebrow">${r.matches&&r.matches.length?'Also':'Not in your saved passages. Claude’s best guess'}</span><h3${ta(g.title)}>${esc(g.title)}</h3><p${ta(g.author)}>${esc(g.author||'')}${g.chapter?` · <b>${esc(g.chapter)}</b>`:''}</p>${g.why?`<p class="hint">${esc(g.why)}</p>`:''}${g.sure===false?'<p class="hint">Claude isn’t certain about this.</p>':''}
          ${b?`<div class="answer yes" style="padding:12px"><span class="where">In your library${b.location?': '+esc(b.location):''}</span>${miniBook(b)}</div>`:w?`<div class="answer maybe" style="padding:12px"><span class="where">On your wishlist</span>${miniBook(w)}</div>`:`<div class="answer no" style="padding:12px"><span class="where">Not in your library</span><button class="btn ghost small" data-act="guesswish">Add to wishlist</button></div>`}</div>`;
        }else res+=`<div class="guess"><h3>No match found</h3><p>Nothing in your saved passages fits, and Claude couldn’t place it in a book. Try adding names, places or other details you remember.</p></div>`;
      }
    }
  }
  const recent=S.passages.slice().sort((a,b)=>(b.addedAt||0)-(a.addedAt||0)).slice(0,5);
  return nav()+`<h1 class="page-title">Find a passage</h1><p class="page-sub">Describe a part you remember in your own words, in English or Tamil. Your ${plural(n,'saved passage')} from ${plural(books,'book')} are searched by meaning.</p>
    <form id="pForm" style="gap:10px;margin-bottom:22px"><textarea class="in" id="pq" style="min-height:96px" placeholder="e.g. the part where the hero refuses the crown">${esc(S.pq)}</textarea><button class="btn primary" type="submit"${SC.fn?'':' disabled'}>${ICON_SEARCH}Find passage</button>${SC.fn?'':'<p class="hint">Passage search uses Claude. Add your Claude API key in Settings to turn it on.</p>'}</form>
    <div style="display:flex;flex-direction:column;gap:14px">${res}</div>
    ${!r&&recent.length?`<h2 style="font-size:20px;margin:8px 0 10px">Recently saved</h2><div class="passages">${recent.map(p=>{const b=S.books.find(x=>x.id===p.bookId)||{title:''};return `<div class="quote"><button class="src" data-act="open" data-id="${esc(p.bookId)}"${ta(b.title)}>${esc(b.title)}</button><blockquote${ta(p.text)}>${esc(p.text.length>280?p.text.slice(0,280)+'…':p.text)}</blockquote></div>`}).join('')}</div>`:''}
    ${!n?`<div class="empty" style="margin-top:8px"><p>Save passages from a book’s page with “Add passage”. Even with none saved, Claude will still try to tell you which book a passage is from.</p></div>`:''}`;
}
async function findPassage(q){
  q=q.trim();if(!q||!SC.fn)return;
  S.pq=q;S.pres={loading:'Searching your saved passages…'};render();
  const res={matches:[],guess:null};
  try{
    if(S.passages.length){
      let ps=S.passages.map(p=>{const b=S.books.find(x=>x.id===p.bookId)||{};return {p,b}});
      let budget=70000,lines=[];
      const qk=new Set(phonKey(q).split(' ').filter(w=>w.length>2));
      if(ps.length>250)ps.sort((x,y)=>ov(y)-ov(x));
      function ov(x){return phonKey(x.p.text.slice(0,2000)).split(' ').filter(w=>qk.has(w)).length}
      for(const {p,b} of ps){const line=`[${p.id}] ${b.title||'?'}${b.author?' — '+b.author:''}${p.chapter?' | '+p.chapter:''}${p.page?' | p.'+p.page:''}\n${p.text.slice(0,700)}`;if(budget-line.length<0)break;budget-=line.length;lines.push(line)}
      const prompt=`A reader is trying to find a passage in their saved book quotes. They described it like this:\n"""${q}"""\n\nHere are their saved passages, each starting with its id in square brackets:\n\n${lines.join('\n\n')}\n\nFind the passages that match the description by meaning, not just shared words. The description and the passages may be in English or Tamil, or different languages from each other. Return at most 5, best first, and only ones that plausibly fit. For each, give a short reason in the reader's language.\nReply with only JSON: {"matches":[{"id":"<id>","why":"<short reason>"}]}`;
      const r=await SC.fn.json(prompt,{});
      res.matches=(r&&Array.isArray(r.matches)?r.matches:[]).filter(m=>m&&S.passages.some(p=>p.id===m.id)).slice(0,5);
    }
    if(!res.matches.length){
      S.pres={loading:'Nothing close in your saved passages. Asking Claude which book it’s from…'};render();
      const titles=owned().slice(0,800).map(b=>`${b.title}${b.author?' — '+b.author:''}`).join('\n');
      const prompt=`A reader describes a passage from a book (it may be English or Tamil literature):\n"""${q}"""\n\nWhich book and chapter is it most probably from? Think of well-known English and Tamil books as well as others.${titles?`\nFor context, these are books the reader owns (the passage may or may not be from one of them):\n${titles}`:''}\nIf you can't identify a book, use null for title.\nReply with only JSON: {"title": string|null, "author": string|null, "chapter": string|null, "why": "<one sentence>", "sure": true|false}`;
      res.guess=await SC.fn.json(prompt,{modelTier:'complex'})||{};
    }
    S.pres=res;
  }catch(e){S.pres={error:claudeErr(e)}}
  if(S.view==='passages')render();
}

/* ================= statistics ================= */
function viewStats(){
  const own=owned(),n=own.length;
  if(!S.loaded)return nav()+loadingBlock();
  const fin=own.filter(isRead),rated=own.filter(b=>Number(b.rating)>0);
  const avg=rated.length?(rated.reduce((s,b)=>s+Number(b.rating),0)/rated.length):0;
  const years=new Map();fin.forEach(b=>{const d=parseDay(b.finishedOn);if(d)years.set(d.getFullYear(),(years.get(d.getFullYear())||0)+1)});
  const ys=[...years.keys()].sort();const yr=[];if(ys.length){for(let y=Math.max(ys[0],ys[ys.length-1]-9);y<=ys[ys.length-1];y++)yr.push([y,years.get(y)||0])}
  const ymax=Math.max(1,...yr.map(x=>x[1]));
  const noDate=fin.filter(b=>!parseDay(b.finishedOn)).length;
  const top=field=>{const m=new Map();own.forEach(b=>{const r=String(b[field]||'').trim();if(!r)return;const k=norm(r);const e=m.get(k)||{label:r,n:0};e.n++;m.set(k,e)});return [...m.values()].sort((a,b)=>b.n-a.n||cmpText(a.label,b.label)).slice(0,8)};
  const bars=(arr)=>{const mx=Math.max(1,...arr.map(x=>x.n));return arr.length?`<div class="bars">${arr.map(x=>`<div class="bar-row"><span class="lab"${ta(x.label)} title="${esc(x.label)}">${esc(x.label)}</span><span class="track"><span class="fill" style="display:block;width:${x.n/mx*100}%"></span></span><span class="val">${x.n}</span></div>`).join('')}</div>`:'<p class="note">Nothing recorded yet.</p>'};
  const lang={English:0,Tamil:0,Other:0};own.forEach(b=>lang[LANGS.includes(b.language)?b.language:'Other']++);
  const pct=v=>n?Math.round(v/n*100):0;
  const st={};STATUS.forEach(([k])=>st[k]=0);own.forEach(b=>st[statusOf(b)]++);
  return nav()+`<h1 class="page-title">Statistics</h1><p class="page-sub">Your library at a glance.</p>
  <div class="stat-cards">
    <div class="stat"><b>${n}</b><span>books owned</span></div>
    <div class="stat"><b>${fin.length}</b><span>finished</span></div>
    <div class="stat"><b style="color:var(--flag)">${prioList().length}</b><span>in Priority Reading</span></div>
    <div class="stat"><b>${avg?avg.toFixed(1):'—'}</b><span>average rating${rated.length?` (${rated.length} rated)`:''}</span></div>
    <div class="stat"><b>${own.filter(b=>b.loan).length}</b><span>lent out</span></div>
    <div class="stat"><b>${wishes().length}</b><span>on wishlist</span></div>
  </div>
  <div class="chart"><h3>Books read per year</h3>${yr.length?`<div class="years">${yr.map(([y,v])=>`<div class="ycol"><span class="yv">${v||''}</span><span class="yb" style="height:${v/ymax*100}%"></span></div>`).join('')}</div><div class="ylabels">${yr.map(([y])=>`<span>${y}</span>`).join('')}</div>`:'<p class="note">Add a “Date finished reading” to finished books to see this.</p>'}${noDate?`<p class="note">${plural(noDate,'finished book')} without a date ${noDate===1?'isn’t':'aren’t'} counted here.</p>`:''}</div>
  <div class="chart"><h3>English and Tamil</h3><div class="stack" role="img" aria-label="English ${lang.English}, Tamil ${lang.Tamil}, Other ${lang.Other}">${n?`<div style="width:${pct(lang.English)}%;background:var(--c-en)"></div><div style="width:${pct(lang.Tamil)}%;background:var(--c-ta)"></div><div style="width:${pct(lang.Other)}%;background:var(--c-ot)"></div>`:''}</div>
    <div class="legend"><span><i style="background:var(--c-en)"></i>English ${lang.English} (${pct(lang.English)}%)</span><span lang="ta"><i style="background:var(--c-ta)"></i>தமிழ் ${lang.Tamil} (${pct(lang.Tamil)}%)</span><span><i style="background:var(--c-ot)"></i>Other ${lang.Other} (${pct(lang.Other)}%)</span></div></div>
  <div class="chart"><h3>Reading status</h3>${bars(STATUS.map(([k,t])=>({label:t,n:st[k]})))}</div>
  <div class="chart"><h3>Top authors</h3>${bars(top('author'))}</div>
  <div class="chart"><h3>Top genres</h3>${bars(top('genre'))}</div>`;
}

/* ================= settings: export, import, backup ================= */
function viewSettings(){
  const lb=S.meta&&S.meta.lastBackup,u=usageThisMonth(),key=apiKey();
  return nav()+`<h1 class="page-title">Settings</h1><p class="page-sub">Signed in as <b>${esc(EMAIL)}</b>. Your library is saved in your Supabase database, with a copy on this phone for offline use.</p>
  <div class="set-card"><h3>Claude features</h3><p>Reading covers and page photos, passage search by meaning, and identifying books that aren’t online use your own Claude API key. The key is kept only on this phone.</p>
    ${key?`<p>Key saved: <b>…${esc(key.slice(-6))}</b></p><p>This month (estimate): <b>$${u.usd.toFixed(u.usd<1?3:2)}</b> across ${plural(u.calls,'request')}.</p>
      <div class="btns"><button class="btn ghost" data-act="testkey" id="testKey">Test the key</button><button class="btn danger" data-act="rmkey">Remove key</button></div>`
    :`<form id="keyForm" class="auth-form"><div class="field"><label for="k-key">Claude API key</label><input class="in" id="k-key" type="password" autocomplete="off" placeholder="sk-ant-…" required></div><button class="btn primary" type="submit">Save key</button></form><p class="hint">Create a key at platform.claude.com → API keys, and choose the Default workspace for it. Set a monthly spend limit in the Console too.</p>`}
    <div id="keyOut" role="status"></div></div>
  <div class="set-card"><h3>Back up</h3><p>${lb?`Last backup: ${fmtDate(lb)} (${plural(Math.floor((Date.now()-lb)/DAY),'day')} ago).`:'You haven’t made a backup yet.'} The backup file has every book, your wishlist and all saved passages. Keep a copy in Google Drive.</p>
    <div class="btns"><button class="btn primary" data-act="exjson">Download backup (JSON)</button><button class="btn ghost" data-act="excsv">Download spreadsheet (CSV for Excel)</button></div>
    <p class="hint">Cover photos stay in your Supabase storage; the backup links to them.</p></div>
  <div class="set-card"><h3>Restore or move in</h3><p>Choose a backup file, including one from the Claude version of this app. Books and passages you already have are skipped.</p>
    <div class="btns"><button class="btn ghost" data-act="import">Choose backup file</button></div><div id="impOut" role="status"></div></div>
  <div class="set-card"><h3>Account</h3><p>${owned().length} books, ${wishes().length} on the wishlist, ${S.passages.length} saved passages.</p><div class="btns"><button class="btn ghost" data-act="signout">Sign out</button></div></div>`;
}
function backupPayload(){return {app:'Home Library',version:2,exportedAt:new Date().toISOString(),books:S.books,passages:S.passages}}
async function exportJSON(){
  if(!CAP.downloads)return;
  try{await CAP.downloads.save({filename:`home-library-backup-${todayStr()}.json`,data:JSON.stringify(backupPayload(),null,1)});await setMeta({lastBackup:Date.now()});toast('Backup saved');refresh()}
  catch(e){if(e&&e.code!=='declined')toast('The backup couldn’t be saved. Try again.')}
}
async function exportCSV(){
  if(!CAP.downloads)return;
  const cols=[['Title','title'],['Author','author'],['Genre','genre'],['Language','language'],['ISBN','isbn'],['Status',b=>b.wish?'Wishlist':STATUS_LABEL[statusOf(b)]],['Date finished','finishedOn'],['Location','location'],['Rating','rating'],['Priority',b=>b.priority?'Yes':''],['Priority order',b=>b.priority?prioList().findIndex(x=>x.id===b.id)+1:''],['Series','series'],['Part','seriesNo'],['Of','seriesTotal'],['Edition','edition'],['Lent to',b=>b.loan?b.loan.to:''],['Lent on',b=>b.loan?b.loan.on:''],['Overdue',b=>isOverdue(b)?'Yes':''],['Comments','comments'],['Passages',b=>passagesOf(b.id).length||''],['Date added',b=>b.addedAt?new Date(b.addedAt).toISOString().slice(0,10):'']];
  const cell=v=>{v=String(v??'');return /[",\n\r]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
  const rows=[cols.map(c=>c[0]).join(',')].concat(S.books.slice().sort((a,b)=>(a.wish?1:0)-(b.wish?1:0)||byTitle(a,b)).map(b=>cols.map(([,f])=>cell(typeof f==='function'?f(b):b[f])).join(',')));
  try{await CAP.downloads.save({filename:`home-library-${todayStr()}.csv`,data:'﻿'+rows.join('\r\n')});toast('Spreadsheet saved')}
  catch(e){if(e&&e.code!=='declined')toast('The spreadsheet couldn’t be saved. Try again.')}
}
async function importFile(file){
  const out=document.getElementById('impOut');const say=h=>{if(out)out.innerHTML=h};
  let data;try{data=JSON.parse(await file.text())}catch(e){say('<p class="err">That file isn’t a Home Library backup.</p>');return}
  const books=Array.isArray(data)?data:Array.isArray(data.books)?data.books:null,passages=Array.isArray(data.passages)?data.passages:[];
  if(!books){say('<p class="err">That file isn’t a Home Library backup.</p>');return}
  const plan=[],map=new Map();
  const byId=new Map(S.books.map(b=>[b.id,b]));
  for(const raw of books){
    if(!raw||typeof raw!=='object'||!raw.title)continue;
    const {id,...rest}=raw;delete rest.coverAsset;if(rest.coverUrl&&!/^(https?:|data:)/.test(rest.coverUrl))rest.coverUrl='';
    let ex=id&&byId.get(id);
    const same=b=>!!b.wish===!!rest.wish&&(b.edition||'')===(rest.edition||'')&&((toIsbn13(rest.isbn)&&toIsbn13(b.isbn)===toIsbn13(rest.isbn))||(keyJoin(b.title)===keyJoin(rest.title)&&keyJoin(b.author)===keyJoin(rest.author)));
    if(!ex)ex=S.books.find(same);
    if(ex){if(id)map.set(id,ex.id);continue}
    const inPlan=plan.find(p=>same(p.data));
    if(inPlan){if(id)map.set(id,inPlan.id);continue}
    const nid=id&&!byId.has(id)&&/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(id)?id:newId();
    if(id)map.set(id,nid);
    plan.push({id:nid,data:rest});
  }
  const pplan=[];
  const pIds=new Set(S.passages.map(p=>p.id)),pKeys=new Set(S.passages.map(p=>p.bookId+'|'+norm(p.text)));
  for(const raw of passages){
    if(!raw||!raw.text)continue;const {id,...rest}=raw;const bookId=map.get(rest.bookId)||rest.bookId;
    if((id&&pIds.has(id))||pKeys.has(bookId+'|'+norm(rest.text)))continue;
    if(!S.books.some(b=>b.id===bookId)&&!plan.some(p=>p.id===bookId))continue;
    pKeys.add(bookId+'|'+norm(rest.text));
    pplan.push({id:id&&/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(id)?id:newId(),data:{...rest,bookId}});
  }
  const skipped=books.length-plan.length;
  if(!plan.length&&!pplan.length){say(`<p>Everything in this backup is already in your library (${plural(books.length,'book')}${passages.length?`, ${plural(passages.length,'passage')}`:''}).</p>`);return}
  S.importPlan={plan,pplan};
  say(`<div class="ask"><span>Found <b>${plural(plan.length,'new book')}</b> and <b>${plural(pplan.length,'new passage')}</b>. ${plural(skipped,'book')} already in your library will be skipped.</span><div class="actions"><button class="btn primary" data-act="doimport">Import</button></div></div>`);
}
async function doImport(){
  const {plan,pplan}=S.importPlan||{};if(!plan)return;
  const out=document.getElementById('impOut');let done=0,failed=0;const total=plan.length+pplan.length;
  for(const {id,data} of plan){try{await saveDoc('b',data,id)}catch(e){failed++}done++;if(out&&done%5===0)out.innerHTML=`<p class="scan-status busy">Importing… ${done} of ${total}</p>`}
  for(const {id,data} of pplan){try{await saveDoc('p',data,id)}catch(e){failed++}done++;if(out&&done%5===0)out.innerHTML=`<p class="scan-status busy">Importing… ${done} of ${total}</p>`}
  S.importPlan=null;
  flush();
  if(out)out.innerHTML=`<p>${failed?`${total-failed} of ${total} imported. ${failed} couldn’t be saved; try importing the file again.`:`Imported ${plural(plan.length,'book')} and ${plural(pplan.length,'passage')}.`}</p>`;
  toast('Import finished');
}

/* ================= delete ================= */
function askDelete(){
  const b=S.books.find(x=>x.id===S.current);if(!b)return;const np=passagesOf(b.id).length;
  layer.innerHTML=`<div class="scrim" data-act="closesheet"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="delh"><h2 id="delh">Delete “${esc(b.title)}”?</h2><p>This removes the book${np?`, its ${plural(np,'saved passage')}`:''} and your comments${b.wish?' from your wishlist':' from your library'}. It can’t be undone.</p><div class="actions"><button class="btn ghost" data-act="closesheet" id="cancelDel">Keep it</button><button class="btn danger solid" data-act="confirmdel">Delete</button></div></div></div>`;
  document.getElementById('cancelDel').focus();
}
async function confirmDelete(){
  const b=S.books.find(x=>x.id===S.current);layer.innerHTML='';if(!b)return;
  try{
    for(const p of passagesOf(b.id)){try{await removeDoc('p',p.id)}catch(e){}}
    await removeBook(b.id);dropAsset(b.coverPath);
    S.view=b.wish?'wishlist':(S.back||'library');render();toast('Book deleted');
  }catch(e){toast('Couldn’t delete. Try again.')}
}

/* ================= events ================= */
function clickFile(id){const inp=document.getElementById(id);if(inp){try{inp.value=''}catch(_){}inp.click()}}
document.addEventListener('click',async e=>{
  const t=e.target.closest('[data-act]');if(!t)return;
  const a=t.dataset.act;
  if(a==='closesheet'){if(t.classList.contains('scrim')&&e.target!==t)return;layer.innerHTML='';return}
  if(a==='nav'){layer.innerHTML='';S.view=t.dataset.v;render();window.scrollTo(0,0);return}
  if(a==='confirmdel')return confirmDelete();
  if(a==='open'){layer.innerHTML='';return go('detail',t.dataset.id)}
  if(a==='peek'){layer.innerHTML='';S.form=null;S.view='detail';S.current=t.dataset.id;render();window.scrollTo(0,0);return}
  if(a==='prio'){e.stopPropagation();return togglePrio(t.dataset.id)}
  if(a==='reorder')return openReorder();
  if(a==='add'){S.form=blankForm(false);return go('form')}
  if(a==='addwish'){S.form=blankForm(true);return go('form')}
  if(a==='edit'){const b=S.books.find(x=>x.id===S.current);S.form={...blankForm(b.wish),...b,rating:b.rating||0,status:statusOf(b)};return go('form')}
  if(a==='back'){if(S.view==='form'&&S.form&&S.form.id){S.form=null;S.view='detail';render();return}S.form=null;S.view=S.back||'library';render();return}
  if(a==='askdel')return askDelete();
  if(a==='tog'){const k=t.dataset.k,open=t.getAttribute('aria-expanded')==='true';if(open)S.collapsed.add(k);else S.collapsed.delete(k);setPref('collapsed',JSON.stringify([...S.collapsed]));t.setAttribute('aria-expanded',String(!open));t.nextElementSibling.hidden=open;return}
  if(a==='layout'){S.layout=t.dataset.v;setPref('layout',S.layout);return render()}
  if(a==='filters'){S.showFilters=!S.showFilters;return render()}
  if(a==='clearf'){S.filters={lang:'',genre:'',rating:'',location:'',read:''};return render()}
  if(a==='showlent'){S.filters={lang:'',genre:'',rating:'',location:'',read:t.dataset.v};S.showFilters=true;render();const r=document.getElementById('results');if(r)r.scrollIntoView({block:'start'});return}
  if(a==='pickfile'){if(SC.busy)return;return clickFile(t.dataset.for)}
  if(a==='lookup'){const v=document.getElementById('f-isbn').value,isbn=cleanIsbn(v);if(!isbn){status(isbnProblem(v)||'Type a 10- or 13-digit ISBN first.');return}return lookupIsbn(isbn)}
  if(a==='usesug'){if(SC.sug){const d=applyFound(SC.sug);SC.sug=null;status(d.length?'Filled in. Please check before saving.':'Nothing new to fill in.')}return}
  if(a==='recrop'){if(SC.lastPhoto)return pickCover(SC.lastPhoto);return}
  if(a==='rmcover'){const f=S.form;if(f.coverPreview)URL.revokeObjectURL(f.coverPreview);f.coverBlob=null;f.coverPreview='';f.coverRemote='';f.coverRemoved=true;document.getElementById('coverPrev').innerHTML=cover({title:document.getElementById('f-title').value,author:document.getElementById('f-author').value},'');t.hidden=true;document.getElementById('recrop').hidden=true;return}
  if(a==='doneremove'){document.getElementById('f-prio').checked=false;document.getElementById('doneAsk').innerHTML='';toast('It will leave Priority Reading when you save');return}
  if(a==='donekeep'){document.getElementById('doneAsk').innerHTML='';return}
  if(a==='rate'||a==='clearrate'){S.form.rating=a==='rate'?Number(t.dataset.v):0;document.getElementById('rateInput').innerHTML=rateStars(S.form.rating);document.getElementById('rateVal').textContent=S.form.rating?S.form.rating+' / 5':'Not rated';return}
  if(a==='dupsave'){const ed=document.getElementById('dupEd');const v=ed?ed.value.trim():'';layer.innerHTML='';const ef=document.getElementById('f-ed');if(ef)ef.value=v;S.form.edition=v;return submit(null,true)}
  if(a==='bought'){
    const b=S.books.find(x=>x.id===t.dataset.id);if(!b)return;layer.innerHTML='';
    try{await patchBook(b.id,{wish:false,addedAt:Date.now(),status:'want'})}catch(err){toast('Couldn’t update. Try again.');return}
    S.form={...blankForm(false),...b,wish:false,status:'want',rating:0};S.current=b.id;S.view='form';render();window.scrollTo(0,0);toast('Moved to your library. Add where it’s kept.');return}
  if(a==='own')return openOwn();
  if(a==='ownagain')return ownScan();
  if(a==='scanisbn'){if(SC.busy)return;return openScanner({title:'Scan ISBN',fallbackInput:'scanIsbn',onIsbn:isbn=>lookupIsbn(isbn)})}
  if(a==='scanclose')return closeScanner();
  if(a==='torch')return toggleTorch();
  if(a==='scanphoto'){const inp=SCAN&&SCAN.fallbackInput;closeScanner();if(inp)clickFile(inp);return}
  if(a==='syncnow'){S.syncErr=null;return reload()}
  if(a==='authmode'){S.authMode=S.authMode==='up'?'in':'up';S.authMsg='';return render()}
  if(a==='forgot'){const em=document.getElementById('a-email').value.trim();if(!em){document.getElementById('authMsg').innerHTML='<p class="err">Type your email first.</p>';return}
    const {error}=await sb.auth.resetPasswordForEmail(em,{redirectTo:location.origin+location.pathname});document.getElementById('authMsg').innerHTML=error?`<p class="err">${esc(error.message)}</p>`:'<p class="hint ok">Check your email for a link to reset your password.</p>';return}
  if(a==='resetsetup'){setPref('sbUrl','');setPref('sbKey','');location.reload();return}
  if(a==='signout'){await sb.auth.signOut();return}
  if(a==='rmkey'){setPref('anthropicKey','');refreshClaude();return render()}
  if(a==='testkey'){const o=document.getElementById('keyOut');o.innerHTML='<p class="scan-status busy">Testing…</p>';try{const r=await SC.fn.json('Reply with {"ok": true}',{maxTokens:20});o.innerHTML=r&&r.ok?'<p class="hint ok">✓ The key works.</p>':'<p class="hint">The key answered, but oddly. It should still work.</p>'}catch(e){o.innerHTML=`<p class="err">${esc(claudeErr(e))}</p>`}return}
  if(a==='owngal')return clickFile('ownGal');
  if(a==='ownwish'||a==='ownadd'){const q=S.own||{};layer.innerHTML='';S.form={...blankForm(a==='ownwish'),title:q.title||'',author:q.author||'',isbn:q.isbn||'',genre:q.genre||'',language:LANGS.includes(q.language)?q.language:'English',series:q.series||'',seriesNo:q.seriesNo?String(q.seriesNo):'',seriesTotal:q.seriesTotal?String(q.seriesTotal):''};return go('form')}
  if(a==='pick')return openPick();
  if(a==='pickagain'){S.pick.i++;S.pick.reroll=true;return renderPick()}
  if(a==='lend')return openLend();
  if(a==='returned'){const b=S.books.find(x=>x.id===S.current);try{await patchBook(b.id,{loan:null});toast('Marked as returned')}catch(err){toast('Couldn’t update. Try again.')}return refresh()}
  if(a==='addpass')return openPassage(null);
  if(a==='editpass')return openPassage(t.dataset.id);
  if(a==='pagecam')return clickFile('pageCam');
  if(a==='pagegal')return clickFile('pageGal');
  if(a==='delpass'){
    if(t.dataset.sure!=='1'){t.dataset.sure='1';t.textContent='Tap again to delete';return}
    const id=S.pform&&S.pform.id;layer.innerHTML='';try{await removeDoc('p',id);toast('Passage deleted')}catch(err){toast('Couldn’t delete. Try again.')}return refresh()}
  if(a==='guesswish'){const g=S.pres&&S.pres.guess;if(!g)return;S.form={...blankForm(true),title:g.title||'',author:g.author||''};return go('form')}
  if(a==='exjson')return exportJSON();
  if(a==='excsv')return exportCSV();
  if(a==='import')return clickFile('importFile');
  if(a==='doimport'){t.disabled=true;return doImport()}
});
document.addEventListener('input',e=>{
  const t=e.target;
  if(t.id==='q'){S.q=t.value;const r=document.getElementById('results');if(r)r.innerHTML=results();return}
  if(t.id==='pq'){S.pq=t.value;return}
  if(t.classList&&t.classList.contains('filled')){t.classList.remove('filled');const k=Object.keys(FIELD_IDS).find(k=>FIELD_IDS[k]===t.id);if(k)SC.filled.delete(k)}
  if((t.id==='f-title'||t.id==='f-author')&&S.form&&!formCoverSrc()){const cp=document.getElementById('coverPrev');if(cp)cp.innerHTML=cover({title:document.getElementById('f-title').value,author:document.getElementById('f-author').value},'')}
  if(t.id==='f-title'||t.id==='f-isbn'||t.id==='f-author'){checkDupe();if(t.id==='f-title'&&t.value.trim())document.getElementById('titleErr').hidden=true;if(t.id==='f-isbn')isbnHint()}
  if(t.tagName==='TEXTAREA'&&t.classList.contains('in')&&t.id!=='pq'){t.style.height='auto';t.style.height=Math.max(150,t.scrollHeight+2)+'px'}
});
document.addEventListener('change',e=>{
  const t=e.target;
  if(t.id==='group'){S.group=t.value;setPref('group',S.group);const r=document.getElementById('results');if(r)r.innerHTML=results();return}
  if(t.dataset&&t.dataset.f){S.filters[t.dataset.f]=t.value;const y=window.scrollY;render();window.scrollTo(0,y);return}
  if(t.id==='pkGenre'){S.pick.genre=t.value;S.pick.i=0;S.pick.cur=null;return renderPick()}
  if(t.id==='pkLang'){S.pick.lang=t.value;S.pick.i=0;S.pick.cur=null;return renderPick()}
  if(t.name==='dest'){const w=t.value==='wish';S.form.wish=w;document.querySelectorAll('.wonly').forEach(el=>el.hidden=w);document.getElementById('saveBtn').textContent=w?'Add to wishlist':'Add to library';document.getElementById('notesLbl').textContent=w?'Notes':'My comments';checkDupe();return}
  if(t.id==='f-done'){const was=(S.form&&S.form.finishedOn)||'';if(t.value){const fin=document.querySelector('input[name="status"][value="finished"]');if(fin)fin.checked=true}if(t.value&&t.value!==was)askFinished();else document.getElementById('doneAsk').innerHTML='';return}
  if(t.name==='status'){if(t.value==='finished'){const d=document.getElementById('f-done');if(d&&!d.value){d.value=todayStr()}askFinished()}else{const box=document.getElementById('doneAsk');if(box)box.innerHTML=''}return}
  if(t.id==='f-prio'){if(!t.checked)document.getElementById('doneAsk').innerHTML='';return}
  if(t.name==='language')SC.filled.delete('language');
  const file=t.files&&t.files[0];if(!file)return;
  const id=t.id;t.value='';
  if(id==='scanIsbn'||id==='scanIsbnG'){if(!SC.busy)onScanIsbn(file);return}
  if(id==='scanCover'||id==='scanCoverG'){if(!SC.busy)lookup(cleanIsbn(document.getElementById('f-isbn').value),file,'cover');return}
  if(id==='coverCam'||id==='coverGal'){if(S.form)pickCover(file);return}
  if(id==='ownCam'||id==='ownGal'){if(document.getElementById('ownOut'))ownFromPhoto(file);return}
  if(id==='pageCam'||id==='pageGal'){ocrPage(file);return}
  if(id==='importFile'){importFile(file);return}
});
document.addEventListener('submit',async e=>{
  const f=e.target;
  if(f.id==='bookForm')return submit(e);
  e.preventDefault();
  if(f.id==='setupForm'){
    let url=document.getElementById('s-url').value.trim().replace(/\/+$/,''),key=document.getElementById('s-key').value.trim();
    if(!/^https:\/\/[^\s]+$/.test(url)){S.setupErr='The Project URL should start with https://';return render()}
    const btn=document.getElementById('setupBtn');btn.disabled=true;btn.textContent='Checking…';
    try{const c=window.supabase.createClient(url,key);const {error}=await c.from('books').select('id',{head:true,count:'exact'}).limit(1);
      if(error){S.setupErr=/relation|does not exist|schema cache/i.test(error.message)?'Connected, but the tables are missing. Run the setup SQL in Supabase first.':/Invalid API key|JWT|apikey/i.test(error.message)?'That key was refused. Copy the anon / publishable key again.':error.message;return render()}
    }catch(err){S.setupErr='Couldn’t reach that address. Check the Project URL.';return render()}
    setPref('sbUrl',url);setPref('sbKey',key);location.reload();return;
  }
  if(f.id==='authForm'){
    const em=document.getElementById('a-email').value.trim(),pw=document.getElementById('a-pass').value,msg=document.getElementById('authMsg'),btn=document.getElementById('authBtn');
    S.authEmail=em;btn.disabled=true;msg.innerHTML='';
    if(S.authMode==='up'){
      const {data,error}=await sb.auth.signUp({email:em,password:pw,options:{emailRedirectTo:location.origin+location.pathname}});btn.disabled=false;
      if(error){msg.innerHTML=`<p class="err">${esc(error.message)}</p>`;return}
      if(data.session)return startSession(data.session);
      S.authMode='in';S.authMsg='<p class="hint ok">Account created. Open the confirmation email, tap the link, then sign in here.</p>';return render();
    }
    const {data,error}=await sb.auth.signInWithPassword({email:em,password:pw});btn.disabled=false;
    if(error){msg.innerHTML=`<p class="err">${esc(/confirm/i.test(error.message)?'Please confirm your email first. Check your inbox for the link.':/invalid/i.test(error.message)?'That email and password don’t match.':error.message)}</p>`;return}
    S.authMsg='';return startSession(data.session);
  }
  if(f.id==='newPassForm'){
    const pw=document.getElementById('n-pass').value;const {data,error}=await sb.auth.updateUser({password:pw});
    if(error){document.getElementById('authMsg').innerHTML=`<p class="err">${esc(error.message)}</p>`;return}
    toast('Password changed');const {data:s}=await sb.auth.getSession();if(s&&s.session)return startSession(s.session);S.view='auth';return render();
  }
  if(f.id==='keyForm'){
    const k=document.getElementById('k-key').value.trim();if(!/^sk-ant-/.test(k)){document.getElementById('keyOut').innerHTML='<p class="err">A Claude API key starts with sk-ant-.</p>';return}
    setPref('anthropicKey',k);refreshClaude();render();toast('Key saved on this phone');return;
  }
  if(f.id==='ownForm')return ownTyped(document.getElementById('ownQ').value);
  if(f.id==='pForm')return findPassage(document.getElementById('pq').value);
  if(f.id==='lendForm'){
    const to=document.getElementById('l-to').value.trim(),on=document.getElementById('l-on').value||todayStr();
    if(!to){document.getElementById('l-to').focus();return}
    layer.innerHTML='';try{await patchBook(S.current,{loan:{to,on}});toast(`Lent to ${to}`)}catch(err){toast('Couldn’t save. Try again.')}return refresh();
  }
  if(f.id==='passForm'){
    const text=document.getElementById('p-text').value.trim();if(!text){document.getElementById('p-text').focus();return}
    const pf=S.pform,old=pf.id?S.passages.find(p=>p.id===pf.id):null;
    const data={bookId:pf.bookId,text,page:document.getElementById('p-page').value.trim(),chapter:document.getElementById('p-ch').value.trim(),addedAt:old&&old.addedAt||Date.now()};
    layer.innerHTML='';try{await saveDoc('p',data,pf.id);toast('Passage saved')}catch(err){toast('Couldn’t save the passage. Try again.')}return refresh();
  }
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(SCAN)return closeScanner();if(layer.innerHTML&&!layer.querySelector('#cw'))layer.innerHTML=''}});
window.addEventListener('popstate',()=>{if(SCAN)closeScanner()});
if('serviceWorker' in navigator&&location.protocol==='https:')navigator.serviceWorker.register('sw.js').catch(()=>{});

init();

})();
