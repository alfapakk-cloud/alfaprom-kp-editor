const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const repo = path.join(__dirname, '..');
const baseline = process.env.TEST_BASELINE_REF;
const html = baseline ? cp.execFileSync('git', ['show', baseline+':index.html'], {cwd:repo}) : fs.readFileSync(path.join(repo, 'index.html'));
const artifacts = process.env.TEST_ARTIFACTS_DIR;
if(artifacts)fs.mkdirSync(artifacts,{recursive:true});
const server = http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html)});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1500,height:1000},acceptDownloads:true});
    const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
    page.on('dialog',async d=>{errors.push(d.message());await d.dismiss()});
    await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'networkidle'});
    console.log('libraries',await page.evaluate(()=>({docx:!!window.docx,canvas:!!window.html2canvas,pdf:!!window.jspdf})));
    for (const [name,config] of Object.entries({
      empty:{},
      short:{text:60},
      'four-photos-long-description':{photos:4,text:250},
      'four-photos-tight-boundary':{photos:4,text:250,y:99},
      'long-description-lists-specs':{text:500,rows:90,lists:true},
      'nested-crop-multiple-products':{photos:2,text:150,rows:12,crop:true,multiple:true},
      'large-photo-layout':{photos:4,text:100,y:220}
    })) {
      const result=await page.evaluate(async config=>{
        await ensureDB();
        const p=createProduct();p.productName='Автоклав 300 литров';
        p.description=config.lists?'<p>Начало описания</p><ol><li>Первый пункт</li><li>Второй пункт</li></ol>':'';
        p.description+='<p>'+Array.from({length:config.text||0},(_,i)=>'слово'+i).join(' ')+'</p>';
        p.specsText=Array.from({length:config.rows||0},(_,i)=>'Параметр '+i+': Значение '+i).join('\n');
        p.price='100000';p.discountPrice='90000';p.note='Дополнительная информация';p.videoUrl='https://example.com/video';
        if(config.photos){
          const canvas=document.createElement('canvas');canvas.width=canvas.height=100;
          const ctx=canvas.getContext('2d');ctx.fillStyle='#f80';ctx.fillRect(0,0,100,100);
          const blob=await new Promise(r=>canvas.toBlob(r));
          for(let i=0;i<config.photos;i++){
            const id=await savePhoto(blob);p.photoIds.push(id);p.photoSizes[id]=82;
            p.photoPositions[id]={x:(i%2)*96,y:Math.floor(i/2)*(config.y||86)};
            if(config.crop)p.photoCrops[id]={top:5,bottom:5,left:5,right:5,applied:true,base:{top:10,bottom:10,left:10,right:10}};
          }
        }
        state.products=[p];if(config.multiple)state.products.push({...createProduct(),productName:'Второе оборудование',description:'Описание второго оборудования',price:'500'});
        state.managerName='Тестовый менеджер';state.managerPhone='+7 000 000-00-00';
        const pages=await buildAllPages();
        document.getElementById('qa-pages')?.remove();
        const host=document.createElement('div');host.id='qa-pages';host.style.cssText='position:absolute;left:0;top:0;z-index:100;background:white';host.innerHTML=pages.join('');document.body.appendChild(host);
        await document.fonts.ready;
        const issues=[...host.children].flatMap((el,i)=>{
          const content=el.querySelector('.kp-content'),bottom=el.querySelector('.kp-bottom').getBoundingClientRect().top;
          return [...content.children,...content.querySelectorAll('.product-photo-frame')].filter(child=>child.getBoundingClientRect().bottom>bottom+1).map(child=>({page:i+1,block:child.className,overlap:child.getBoundingClientRect().bottom-bottom}));
        });
        const description=[...host.querySelectorAll('.kp-description')].map(el=>el.textContent).join(' ').replace(/\s+/g,' ').trim();
        const expected=[descriptionTextWithLists(p.description),...(config.multiple?['Описание второго оборудования']:[])].join(' ').replace(/\s+/g,' ').trim();
        const frames=[...host.querySelectorAll('.product-photo-frame')];
        return {pages:pages.length,issues,textPreserved:description===expected,rows:host.querySelectorAll('.specs-table tbody tr').length,photos:frames.length,photosVisible:frames.every(frame=>{const r=frame.getBoundingClientRect();return r.width>1&&r.height>1})};
      },config);
      console.log(name,JSON.stringify(result));
      if(artifacts&&name==='four-photos-tight-boundary')await page.locator('#qa-pages > .kp-page').first().screenshot({path:path.join(artifacts,baseline?'before.png':'after.png')});
      if(artifacts&&name==='large-photo-layout')await page.locator('#qa-pages > .kp-page').first().screenshot({path:path.join(artifacts,'large-photos.png')});
      assert.deepEqual(result.issues,[],name+' overlaps');
      assert.equal(result.textPreserved,true,name+' preserves description');
      assert.equal(result.rows,config.rows||0,name+' preserves rows');
      assert.equal(result.photos,config.photos||0,name+' preserves photos');
      assert.equal(result.photosVisible,true,name+' keeps photos visible');
    }
    await page.evaluate(async()=>{
      document.getElementById('qa-pages').remove();
      const p=state.products[0];p.photoIds=p.photoIds.slice(0,2);
      p.photoIds.forEach((id,i)=>{p.photoSizes[id]=40;p.photoPositions[id]={x:i*45,y:0}});
      p.description='Короткое описание для проверки редактора';p.specsText='Объём: 300 л';
      state.products=[p];saveState();renderProductsEditor();await renderPreviewNow();
    });
    await page.locator('[data-field="productName"]').fill('Проверка автоклава');
    await page.waitForFunction(()=>document.querySelector('#previewPages .kp-product-name')?.textContent==='Проверка автоклава');
    await page.locator('[data-status="order"]').click();
    await page.locator('[data-vat-mode="without"]').click();
    await page.locator('#managerName').fill('Анна');
    await page.locator('.rich-editor').fill('Описание после редактирования');
    await page.waitForFunction(()=>document.querySelector('#previewPages .kp-description')?.textContent==='Описание после редактирования');
    assert.equal(await page.locator('#previewPages .price-vat').textContent(),'Цена без НДС');
    assert.equal(await page.locator('#previewPages .availability').textContent(),'Под заказ');
    await page.locator('#addProductBtn').click();
    assert.equal(await page.locator('.product-editor-card').count(),2);
    await page.reload({waitUntil:'networkidle'});
    assert.equal(await page.locator('.product-editor-card').count(),2,'products persist');
    assert.equal(await page.locator('#managerName').inputValue(),'Анна','manager persists');
    assert.equal(await page.locator('[data-field="productName"]').first().inputValue(),'Проверка автоклава','name persists');
    assert.equal(await page.locator('.rich-editor').first().textContent(),'Описание после редактирования','description persists');
    await page.waitForFunction(()=>window.docx&&window.html2canvas&&window.jspdf);
    const expectedPages=await page.evaluate(async()=>{
      // Экспортируем тот же пограничный случай с четырьмя фотографиями.
      const p=state.products[0],ids=p.photoIds.slice();
      p.photoIds=[...ids,...await Promise.all(ids.map(async id=>savePhoto(await getPhoto(id))))];
      p.photoIds.forEach((id,i)=>{p.photoSizes[id]=82;p.photoPositions[id]={x:(i%2)*96,y:Math.floor(i/2)*99}});
      p.description=Array.from({length:250},(_,i)=>'слово'+i).join(' ');
      state.products=[p];await renderPreviewNow();
      return (await buildAllPages()).length;
    });
    for(const [button,extension,signature] of [['#downloadPdfBtn','pdf','%PDF'],['#downloadDocxBtn','docx','PK']]){
      const pending=page.waitForEvent('download',{timeout:120000});
      await page.locator(button).click();
      const download=await pending;
      const filename=await download.path();
      assert.equal(await download.failure(),null,extension+' download succeeds');
      const data=fs.readFileSync(filename);
      assert.ok(data.subarray(0,4).toString().startsWith(signature),extension+' signature');
      assert.ok(data.length>1000,extension+' is not empty');
      if(extension==='pdf')assert.equal((data.toString('latin1').match(/\/Type \/Page\b/g)||[]).length,expectedPages,'PDF page count');
      if(artifacts)await download.saveAs(path.join(artifacts,'export.'+extension));
      await page.waitForFunction(selector=>!document.querySelector(selector).disabled,button);
      console.log(extension+' export OK ('+data.length+' bytes)');
    }
    assert.deepEqual(errors,[],'runtime errors');
    console.log('Editor, persistence, PDF and DOCX checks passed');
  } finally {await browser.close();server.close()}
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
