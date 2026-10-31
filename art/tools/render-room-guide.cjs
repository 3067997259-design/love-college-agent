// Render only our local geometric study, using an isolated hidden Electron profile.
const { app, BrowserWindow } = require('electron');
const { writeFileSync, existsSync } = require('node:fs');
const { resolve, dirname, join } = require('node:path');
const input=resolve(process.argv[2]), output=resolve(process.argv[3]);
if(existsSync(output))throw new Error('Guide output exists; choose a new version');
app.setPath('userData',join(dirname(output),'.guide-render-profile'));
app.whenReady().then(async()=>{
 const window=new BrowserWindow({width:1254,height:1254,useContentSize:true,show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
 window.webContents.on('console-message',event=>{if(event.level==='error') console.error(event.message)});
 try{
  await window.loadFile(input);
  await window.webContents.executeJavaScript('new Promise((resolve,reject)=>{const start=performance.now();function poll(){if(globalThis.artGuideReady)resolve(true);else if(performance.now()-start>15000)reject(new Error("Guide render timeout"));else setTimeout(poll,50)}poll()})');
  const receipt=await window.webContents.executeJavaScript('globalThis.geometryReceipt');
  const data=await window.webContents.executeJavaScript('document.querySelector("canvas").toDataURL("image/png")');
  const png=Buffer.from(data.split(',')[1],'base64');
  writeFileSync(output,png,{flag:'wx'});writeFileSync(output.replace(/\.png$/,'.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({file:output,size:{width:png.readUInt32BE(16),height:png.readUInt32BE(20)},vanishingPoints:receipt.vanishingPoints}));
 }catch(error){console.error(error.message);process.exitCode=1;}finally{window.destroy();app.quit();}
});
