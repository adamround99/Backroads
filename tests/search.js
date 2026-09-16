const fs=require('fs');
// --- minimal DOM/browser stubs so the app script can be evaluated ---
const el=()=>({style:{},classList:{add(){},remove(){},toggle(){}},dataset:{},
  addEventListener(){},appendChild(){},querySelectorAll:()=>[],
  set innerHTML(v){},set textContent(v){},set className(v){},set hidden(v){}});
global.document={getElementById:el,querySelectorAll:()=>[],addEventListener(){},
  body:{classList:{toggle(){},add(){},remove(){}},dataset:{}},createElement:el};
global.window={addEventListener(){},dispatchEvent(){},matchMedia:()=>({matches:false,addEventListener(){}})};
global.navigator={onLine:true,geolocation:{getCurrentPosition(){}}};
global.localStorage={getItem:()=>null,setItem(){},removeItem(){}};
global.Event=class{constructor(t){this.type=t}};
global.L={map:()=>({setView(){return this},on(){return this},fitBounds(){},addLayer(){},removeLayer(){},getSize:()=>({x:400,y:400})}),
  tileLayer:()=>({addTo(){return this},setUrl(){}}),polyline:()=>({addTo(){return this},getBounds:()=>({})}),
  marker:()=>({addTo(){return this}}),divIcon:()=>({}),latLngBounds:()=>({extend(){}})};
global.fetch=()=>Promise.reject(new Error("no network in test"));
global.setTimeout=setTimeout; global.AbortController=class{constructor(){this.signal={}}abort(){}};

const src=fs.readFileSync(__dirname+'/../app.js','utf8');
const body=require('fs').readFileSync(__dirname+'/../app.js','utf8').replace(/\ninit\(\);[\s\S]*$/,'\n');
require('vm').runInThisContext(body);

// --- synthetic road network: a grid of B roads with a twisty NW quadrant ---
function mkWays(){
  const ways=[]; let id=1;
  const N=25, spacing=0.011;                  // ~1.2 km cells
  const lat0=52.35, lon0=-1.60;
  function pt(r,c,jit){
    const wob = jit ? Math.sin(r*3.1+c*1.7)*0.0016 : 0;
    return {lat: lat0 + r*spacing + wob, lon: lon0 + c*spacing*1.6 + wob*1.2};
  }
  for(let r=0;r<N;r++){
    for(let c=0;c<N-1;c++){
      const twisty = (r>6 && c<6);
      const geo=[]; const steps = twisty?9:3;
      for(let k=0;k<=steps;k++){
        const f=k/steps, a=pt(r,c,twisty), b=pt(r,c+1,twisty);
        const wob = twisty ? Math.sin(f*Math.PI*3)*0.0011 : 0;
        geo.push({lat:a.lat+(b.lat-a.lat)*f+wob, lon:a.lon+(b.lon-a.lon)*f});
      }
      ways.push({type:"way",id:id++,geometry:geo,
        tags:{highway: twisty?"unclassified":(r%4===0?"secondary":"tertiary")}});
    }
  }
  for(let c=0;c<N;c++){
    for(let r=0;r<N-1;r++){
      const twisty = (r>=6 && c<6);
      const geo=[]; const steps = twisty?9:3;
      for(let k=0;k<=steps;k++){
        const f=k/steps, a=pt(r,c,twisty), b=pt(r+1,c,twisty);
        const wob = twisty ? Math.sin(f*Math.PI*3)*0.0011 : 0;
        geo.push({lat:a.lat+(b.lat-a.lat)*f, lon:a.lon+(b.lon-a.lon)*f+wob});
      }
      ways.push({type:"way",id:id++,geometry:geo,
        tags:{highway: twisty?"unclassified":(c%4===0?"secondary":"tertiary")}});
    }
  }
  return ways;
}

const latScale = 110540*Math.cos(52.35*Math.PI/180);
let g = buildGraph(mkWays(), latScale, null, null);
g = pruneSpurs(g); g = mergeChains(g, 5000);
console.log("graph:", g.edges.length, "segments, cruise",
  (g.cruise*2.23694).toFixed(1), "mph avg\n");

const start={lat:52.35+6*0.011, lng:-1.60+6*0.011*1.6};
console.log("target   n   median    range          miles    %corner");
[30,60,90,120].forEach(mins=>{
  const res=findCircuits(g,start,mins*60,8000,260);
  const got=res.found.map(r=>r.mins).sort((a,b)=>a-b);
  if(!got.length){ console.log(String(mins).padStart(5)+"m   none  "+JSON.stringify(res.diag)); return; }
  const med=got[Math.floor(got.length/2)];
  const best=res.found.slice().sort((a,b)=>b.total-a.total)[0];
  console.log(
    String(mins).padStart(5)+"m "+String(got.length).padStart(3)+
    String(med).padStart(8)+"m  "+(got[0]+"-"+got[got.length-1]+"m").padStart(12)+
    String(Math.round(best.km*0.621371)).padStart(8)+"mi"+
    (Math.round(best.twisty*100)+"%").padStart(9)+
    (res.loose?"   (loose)":""));
});

console.log("\nwith the fetch boundary enforced (graph.radius set):");
[[30000,"roomy"],[18000,"tight"],[9000,"very tight"]].forEach(([R,label])=>{
  g.radius=R;
  const res=findCircuits(g,start,60*60,8000,260);
  const got=res.found.map(r=>r.mins).sort((a,b)=>a-b);
  console.log("  radius "+String(R/1000).padStart(2)+"km ("+label.padEnd(10)+") -> "+
    String(got.length).padStart(3)+" laps, median "+
    (got.length?got[Math.floor(got.length/2)]+"m":"none")+
    (res.loose?"  (none on target)":""));
});

console.log("\ndoubling back, across the top 5 of each search:");
g.radius=undefined;
[30,60,90].forEach(mins=>{
  const res=findCircuits(g,start,mins*60,8000,260);
  const top=res.found.slice().sort((a,b)=>b.total-a.total).slice(0,5);
  const lap=top.map(r=>Math.round(r.lap*100));
  const near=top.map(r=>Math.round((r.near||0)*100));
  console.log("  "+String(mins).padStart(3)+"m  same-road "+lap.join("/")+"%   close-pass "+near.join("/")+"%");
});
