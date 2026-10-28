// Check the geometric construction, not the generative painting's fidelity.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const input=resolve(process.argv[2]), output=resolve(process.argv[3]);
const r=JSON.parse(readFileSync(input,'utf8'));
const [a,b,c,d]=r.desk.cornersImage, {windowWallX:x,roomDepthZ:z}=r.vanishingPoints;
const residual=(a,b,v)=>Math.abs((b[0]-a[0])*(v[1]-a[1])-(b[1]-a[1])*(v[0]-a[0]))/Math.hypot(b[0]-a[0],b[1]-a[1]);
const errors=[residual(a,b,x),residual(d,c,x),residual(a,d,z),residual(b,c,z)];
const [aw,bw,,dw]=r.desk.cornersWorld;
const ab=bw.map((v,i)=>v-aw[i]),ad=dw.map((v,i)=>v-aw[i]);
const dot=ab.reduce((s,v,i)=>s+v*ad[i],0);
const checks={oneHorizontalHorizon:Math.abs(x[1]-z[1])<1e-8,tableEdgesMeetSharedVanishingPoints:Math.max(...errors)<1e-7,tabletopIsLevel:r.desk.cornersWorld.every(v=>v[1]===.76),tabletopHasRightAngle:Math.abs(dot)<1e-9,allDeskLegsOnFloor:r.desk.legGroundContacts.every(v=>v[1]===0),kneesInsideLongSide:r.desk.knees.every(p=>p[0]<r.desk.rightLongSideX&&p[2]>.2&&p[2]<1.6)};
const report={source:input,checks,maxVanishingLineResidualPixels:Math.max(...errors),deskWidth:Math.hypot(...ab),deskLength:Math.hypot(...ad),passed:Object.values(checks).every(Boolean),scope:'Only verifies geometric underlay. Generated image geometry, character anatomy and artistic approval are not established by these checks.'};
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));
