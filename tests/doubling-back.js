const fs=require('fs'),vm=require('vm'); const src=fs.readFileSync(__dirname+'/../app.js','utf8');
vm.runInThisContext("var STEP=12;");
["project","resample","prepare","overlap","closePasses","radiusAt"].forEach(n=>{
  const m=src.match(new RegExp("function "+n+"\\([\\s\\S]*?\\n\\}")); vm.runInThisContext(m[0]);
});
// shapes in metres, converted to lon/lat-ish for prepare()
const LS=111320*Math.cos(52.1*Math.PI/180);
const toLL=(x,y)=>[(-1.3 + x/LS), (52.1 + y/110540), 0];

function ring(R,n=600){const p=[];for(let i=0;i<=n;i++){const t=i/n*2*Math.PI;p.push(toLL(R*Math.cos(t),R*Math.sin(t)));}return p;}
function lollipop(stem,R,n=400){ // out along a stem, loop, back down the same stem
  const p=[];
  for(let i=0;i<=n/2;i++) p.push(toLL(0, -stem*(1-i/(n/2))));
  for(let i=0;i<=n;i++){const t=i/n*2*Math.PI;p.push(toLL(R*Math.sin(t), R-R*Math.cos(t)));}
  for(let i=0;i<=n/2;i++) p.push(toLL(0, -stem*i/(n/2)));
  return p;
}
function parallelReturn(len,gap,n=400){ // out on one lane, back on the next one over
  const p=[];
  for(let i=0;i<=n;i++) p.push(toLL(0, len*i/n));
  for(let i=0;i<=40;i++) p.push(toLL(gap*i/40, len));
  for(let i=0;i<=n;i++) p.push(toLL(gap, len*(1-i/n)));
  for(let i=0;i<=40;i++) p.push(toLL(gap*(1-i/40), 0));
  return p;
}
function twistyLoop(R,amp,waves,n=1600){ // a proper circular lap, but wiggly
  const p=[];
  for(let i=0;i<=n;i++){
    const t=i/n*2*Math.PI;
    const r=R+amp*Math.sin(t*waves);
    p.push(toLL(r*Math.cos(t), r*Math.sin(t)));
  }
  return p;
}
function show(name,pts){
  const prep=prepare(pts);
  console.log(name.padEnd(30)+
    " same-road "+(overlap(prep)*100).toFixed(0).padStart(3)+"%"+
    "   close-pass "+(closePasses(prep)*100).toFixed(0).padStart(3)+"%");
}
show("clean circular lap", ring(4000));
show("clean lap, small", ring(1500));
show("lollipop (loop on a stem)", lollipop(3000,1200));
show("out and back, 250m apart", parallelReturn(6000,250));
show("out and back, 600m apart", parallelReturn(6000,600));
show("out and back, 1.5km apart", parallelReturn(6000,1500));
show("twisty circular lap (good)", twistyLoop(3500,700,9));
show("very twisty lap (good)", twistyLoop(3500,900,16));
